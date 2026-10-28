import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { aiProvider, type AiProviderDefinition, type StructuredOutputSupport } from '../ai/providers/definition.ts';
import { AiTaskRunner, SUBMIT_TOOL, type AiRunSetup, type AiTelemetry } from '../ai/runner.ts';
import type { RepoArchiveSource } from '../github.ts';

/*
 * The AI task runner without a network: the AI SDK's mock model behind a provider definition of its
 * own, so a task migrated onto the runner is tested on the runner's real code path (its tool loop,
 * its validation and repair, its errors). A model scripted here answers both the SDK's generate and
 * stream calls, so one model can drive the old provider path and the runner alike, and the two can
 * be compared on what they record.
 */

export type MockStreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];
type GenerateResult = Extract<Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>, { content: unknown }>;

export const MOCK_USAGE = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };

const finish = (reason: 'stop' | 'tool-calls' = 'stop') => ({ type: 'finish' as const, finishReason: { unified: reason, raw: undefined }, usage: MOCK_USAGE });

/** One streamed answer of text, in pieces */
export const textParts = (...pieces: string[]): MockStreamPart[] => [
  { type: 'text-start', id: 't' },
  ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
  { type: 'text-end', id: 't' },
  finish(),
];

/** One streamed call of a tool */
export const toolCallParts = (toolName: string, input: unknown, id = `call-${toolName}`): MockStreamPart[] => [
  { type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) },
  finish('tool-calls'),
];

/** The answer as the submit tool's input: how a provider without a response format, or one with tools, answers */
export const submitParts = (answer: unknown, id = 'call-submit'): MockStreamPart[] => toolCallParts(SUBMIT_TOOL, answer, id);

/** A call that fails as the provider would fail it: thrown from the model, before any part */
export type MockFailure = (options: StreamOptions) => Promise<never>;
export type ModelScript = MockStreamPart[] | MockFailure;

/** What a generate call answers for a script: its text and tool calls, whole */
function generated(script: MockStreamPart[]): GenerateResult {
  const text = script.flatMap((p) => (p.type === 'text-delta' ? [p.delta] : [])).join('');
  const calls = script.flatMap((p) => (p.type === 'tool-call' ? [{ type: 'tool-call' as const, toolCallId: p.toolCallId, toolName: p.toolName, input: p.input }] : []));
  return {
    content: [...(text ? [{ type: 'text' as const, text }] : []), ...calls],
    finishReason: { unified: calls.length > 0 ? 'tool-calls' : 'stop', raw: undefined },
    usage: MOCK_USAGE,
    warnings: [],
  };
}

/**
 * A model that answers each call with the next script (the last one again once they run out),
 * whether it is asked to generate or to stream; `doStreamCalls` and `doGenerateCalls` say what it was asked.
 */
export function scriptedModel(...scripts: ModelScript[]): MockLanguageModelV4 {
  let next = 0;
  const take = (): ModelScript => scripts[Math.min(next++, scripts.length - 1)]!;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const script = take();
      if (typeof script === 'function') return script(options);
      return { stream: convertArrayToReadableStream(script) };
    },
    doGenerate: async (options) => {
      const script = take();
      if (typeof script === 'function') return script(options);
      return generated(script);
    },
  });
}

/** A model whose every call answers this value as JSON text: a response format's answer */
export const jsonModel = (value: unknown): MockLanguageModelV4 => scriptedModel(textParts(JSON.stringify(value)));

/**
 * A provider definition over a mock model. `native` answers in the response format; `none` through
 * the submit tool. It reads the repo with the runner's local tools, as every provider but Claudio does.
 */
export function mockAiProvider(model: MockLanguageModelV4, options: { structuredOutput?: StructuredOutputSupport; id?: string } = {}): AiProviderDefinition {
  return aiProvider({
    id: options.id ?? 'mock',
    name: 'mock provider',
    listed: false,
    settings: [{ key: 'apiKey', label: 'API key', secret: true }],
    capabilities: { streaming: true, tools: true, structuredOutput: options.structuredOutput ?? 'native', repoAccess: 'local-tools' },
    defaultModel: () => 'mock-model',
    model: () => model,
  });
}

/** A runner whose every task runs on `setup` (a mock provider's, or Claudio's at a fake address) */
export function runnerOn(setup: AiRunSetup, options: { archives?: RepoArchiveSource; fetch?: typeof fetch; telemetry?: AiTelemetry } = {}): AiTaskRunner {
  return new AiTaskRunner({
    resolve: async () => setup,
    ...(options.archives && { archives: options.archives }),
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.telemetry && { telemetry: options.telemetry }),
  });
}

/** A runner on a mock model, the shortest way to one */
export const mockRunner = (model: MockLanguageModelV4, options: { structuredOutput?: StructuredOutputSupport } = {}): AiTaskRunner =>
  runnerOn({ provider: mockAiProvider(model, options), settings: { apiKey: 'test-key' } });

/** Everything a model was sent on its calls, as one text: what a prompt assertion reads */
export function promptOf(model: MockLanguageModelV4): string {
  return JSON.stringify([...model.doStreamCalls, ...model.doGenerateCalls].map((c) => c.prompt));
}
