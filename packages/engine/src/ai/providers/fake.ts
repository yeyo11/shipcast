import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { parseLaunchConfig, type Brand } from '@shipcast/schema';
import type { LanguageModel } from 'ai';
import { LAUNCH_CONFIG_PATH } from '../../detect.ts';
import { FAKE_NOTICE, fakePack } from '../../fake-ai.ts';
import type { Launch } from '../../repositories/index.ts';
import { SUBMIT_TOOL } from '../runner.ts';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need } from './settings.ts';

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'fake', name: 'Fake provider', settings: [{ key: 'apiKey', label: 'API key', secret: true }] } as const;

/**
 * A provider for tests, never in the registry: an OpenAI-compatible model at an address that does
 * not exist, so whatever answers it is the test's fetch. It claims no structured output, so it is
 * the one that exercises the submit tool, and it shows what adding a provider takes: this module and
 * a line in a registry.
 */
export const fakeAiProvider = aiProvider({
  ...self,
  listed: true,
  capabilities: { streaming: true, tools: true, structuredOutput: 'none', repoAccess: 'local-tools' },
  defaultModel: () => 'fake-model',
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const provider = createOpenAICompatible({
      name: 'fake',
      baseURL: 'https://fake.invalid/v1',
      apiKey: need(self, settings, 'apiKey'),
      ...(options.fetch && { fetch: options.fetch }),
    });
    return provider(modelId || 'fake-model');
  },
});

type FakeModel = Extract<LanguageModel, { specificationVersion: 'v4' }>;
type CallOptions = Parameters<FakeModel['doStream']>[0];
type StreamPart = Awaited<ReturnType<FakeModel['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;

const READ_TOOL = 'read_files';
const NO_USAGE = { inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } };

/** What the fake model says on one call: text, or one tool's call */
type FakeAnswer = { text: string } | { tool: string; input: unknown };

/** The text a tool answered the model with, when the conversation holds that tool's result */
function toolResult(options: CallOptions, toolName: string): string | undefined {
  for (const message of options.prompt) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result' && part.toolName === toolName) return part.output.type === 'text' ? part.output.value : JSON.stringify(part.output);
    }
  }
  return undefined;
}

/**
 * The fake pack model's turn. Like a real model on the runner, it reads the clone through the runner's
 * own read tool (launch.yml first, the one file it needs), then answers through the submit tool. A
 * call without the repo's tools is not a pack: a structured one fails, a text one gets the notice.
 */
function fakeAnswer(options: CallOptions, launch: Launch, brand: Brand): FakeAnswer {
  const tools = new Set((options.tools ?? []).map((t) => t.name));
  if (!tools.has(READ_TOOL)) {
    if (tools.has(SUBMIT_TOOL) || options.responseFormat?.type === 'json') throw new Error('the fake AI provider only writes launch packs, from a checkout');
    return { text: FAKE_NOTICE };
  }
  const read = toolResult(options, READ_TOOL);
  if (read === undefined) return { tool: READ_TOOL, input: { files: [{ path: LAUNCH_CONFIG_PATH }], lineNumbers: false } };
  // read_files heads each file with a `=== path (n lines) ===` line, and answers a failure as `error: …`
  const [header = '', ...lines] = read.split('\n');
  const parsed = header.startsWith(`=== ${LAUNCH_CONFIG_PATH} (`) && !lines[0]?.startsWith('error:') ? parseLaunchConfig(lines.join('\n')) : undefined;
  if (!parsed?.ok) throw new Error(`the fake AI provider could not read ${LAUNCH_CONFIG_PATH}`);
  return { tool: SUBMIT_TOOL, input: fakePack(launch, parsed.value, brand) };
}

function fakePackModel(launch: Launch, brand: Brand): FakeModel {
  const finish = (reason: 'stop' | 'tool-calls') => ({ unified: reason, raw: undefined });
  return {
    specificationVersion: 'v4',
    provider: 'fake-pack',
    modelId: 'fake-pack',
    supportedUrls: {},
    async doGenerate(options) {
      const answer = fakeAnswer(options, launch, brand);
      return 'text' in answer
        ? { content: [{ type: 'text', text: answer.text }], finishReason: finish('stop'), usage: NO_USAGE, warnings: [] }
        : { content: [{ type: 'tool-call', toolCallId: `fake-${answer.tool}`, toolName: answer.tool, input: JSON.stringify(answer.input) }], finishReason: finish('tool-calls'), usage: NO_USAGE, warnings: [] };
    },
    async doStream(options) {
      const answer = fakeAnswer(options, launch, brand);
      const parts: StreamPart[] =
        'text' in answer
          ? [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: answer.text }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: finish('stop'), usage: NO_USAGE }]
          : [{ type: 'tool-call', toolCallId: `fake-${answer.tool}`, toolName: answer.tool, input: JSON.stringify(answer.input) }, { type: 'finish', finishReason: finish('tool-calls'), usage: NO_USAGE }];
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
}

/**
 * The fake provider of Action mode (`SHIPCAST_AI_PROVIDER=fake`) and of the tests that draft without a
 * model: built per launch, since its placeholder pack (`fakePack`) names the launch it was asked for.
 * It calls no network and is never in the registry. It reads launch.yml from the clone through the
 * runner's tools, as a real provider reads the repo, so a draft on it runs the runner's whole path.
 */
export function fakePackAiProvider(launch: Launch, brand: Brand) {
  return aiProvider({
    id: 'fake-pack',
    name: 'fake AI provider',
    listed: false,
    settings: [],
    capabilities: { streaming: true, tools: true, structuredOutput: 'none', repoAccess: 'local-tools' },
    defaultModel: () => 'fake-pack',
    model: () => fakePackModel(launch, brand),
  });
}
