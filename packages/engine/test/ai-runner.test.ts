import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AiError, type AiTaskDefinition } from '@shipcast/schema';
import { APICallError } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  aiProvider,
  anthropicAiProvider,
  AiTaskRunner,
  claudioAiProvider,
  fakeAiProvider,
  SUBMIT_TOOL,
  workspaceMount,
  type AiProviderDefinition,
  type AiRunSetup,
  type AiTelemetry,
  type StructuredOutputSupport,
} from '../src/index.ts';

type StreamPart = Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P> ? P : never;
type StreamOptions = Parameters<MockLanguageModelV4['doStream']>[0];

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (reason: 'stop' | 'tool-calls' = 'stop') => ({ type: 'finish' as const, finishReason: { unified: reason, raw: undefined }, usage });
const textParts = (...pieces: string[]) => [{ type: 'text-start' as const, id: 't' }, ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })), { type: 'text-end' as const, id: 't' }, finish()];
const toolCall = (toolName: string, input: unknown, id = `call-${toolName}`) => [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }, finish('tool-calls')];

/** A model that answers each call with the next script, recording what it was asked */
function scripted(...scripts: Array<StreamPart[] | ((options: StreamOptions) => Promise<never>)>): MockLanguageModelV4 {
  let next = 0;
  return new MockLanguageModelV4({
    doStream: async (options) => {
      const script = scripts[Math.min(next++, scripts.length - 1)]!;
      if (typeof script === 'function') return script(options);
      return { stream: convertArrayToReadableStream(script) };
    },
  });
}

function mockProvider(model: MockLanguageModelV4, structuredOutput: StructuredOutputSupport = 'native'): AiProviderDefinition {
  return aiProvider({
    id: 'mock',
    name: 'mock provider',
    listed: false,
    settings: [{ key: 'apiKey', label: 'API key', secret: true }],
    capabilities: { streaming: true, tools: true, structuredOutput, repoAccess: 'local-tools' },
    defaultModel: () => 'mock-model',
    model: () => model,
  });
}

const Answer = z.strictObject({ answer: z.string().min(1) });
const answerTask = (needsRepo: AiTaskDefinition['needsRepo'] = 'never', maxSteps = 10): AiTaskDefinition<z.infer<typeof Answer>> => ({
  id: 'test-answer',
  settingsTask: 'pack',
  output: {
    schema: Answer,
    jsonSchema: () => ({ type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }),
    name: 'answer',
  },
  needsRepo,
  limits: { maxSteps, maxOutputTokens: 1000, timeoutMs: 10_000 },
});
const textTask: AiTaskDefinition = { id: 'assistant', settingsTask: 'assistant', needsRepo: 'never', limits: { maxSteps: 1, maxOutputTokens: 1000, timeoutMs: 10_000 } };

async function workspace(): Promise<{ hostDir: string; repo: string }> {
  const hostDir = await mkdtemp(join(tmpdir(), 'shipcast-runner-'));
  const repo = join(hostDir, 'yeyo11__demo@v1');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'main.ts'), 'export const answer = 42;\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo });
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'feat: the answer');
  return { hostDir, repo };
}

function runnerWith(setup: AiRunSetup, options: { hostDir?: string; fetch?: typeof fetch; telemetry?: AiTelemetry } = {}): AiTaskRunner {
  return new AiTaskRunner({
    resolve: async () => setup,
    mount: workspaceMount({ hostDir: options.hostDir ?? tmpdir(), providerDir: '/workspace' }),
    ...(options.telemetry && { telemetry: options.telemetry }),
    ...(options.fetch && { fetch: options.fetch }),
  });
}

const promptText = (options: StreamOptions): string => JSON.stringify(options.prompt);

test('a provider with a response format answers in it: no tools, the schema sent, the answer validated and counted', async () => {
  const model = scripted(textParts('{"answer":', '"yes"}'));
  const timings: Array<{ name: string; outcome: string }> = [];
  const runner = runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } }, { telemetry: { timing: (s) => timings.push(s) } });
  const result = await runner.run(answerTask(), { system: 'Be brief.', prompt: 'Answer.' });
  assert.deepEqual(result.output, { answer: 'yes' });
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  assert.equal(result.model, 'mock-model');
  assert.equal(result.repaired, false);
  const call = model.doStreamCalls[0]!;
  assert.equal(call.responseFormat?.type, 'json');
  assert.equal(call.tools, undefined);
  assert.equal(call.maxOutputTokens, 1000);
  assert.deepEqual(timings.map((t) => [t.name, t.outcome]), [['ai:test-answer:mock', 'ok']]);
});

test('with the repo’s tools, the model reads the checkout and answers through the submit tool', async () => {
  const { hostDir, repo } = await workspace();
  const model = scripted(toolCall('git', { command: 'log', n: 5 }), toolCall('read_files', { files: [{ path: 'src/main.ts' }] }), toolCall(SUBMIT_TOOL, { answer: '42' }));
  const runner = runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } }, { hostDir });
  const result = await runner.run(answerTask('always'), { prompt: 'What is the answer?', repo: { hostDir: repo } });
  assert.deepEqual(result.output, { answer: '42' });
  assert.equal(result.steps, 3);
  assert.deepEqual(result.usage.totalTokens, 45, 'tokens summed over every step');
  const first = model.doStreamCalls[0]!;
  assert.deepEqual((first.tools ?? []).map((t) => t.name).sort(), ['git', 'list_files', 'read_files', 'repo_overview', 'search', SUBMIT_TOOL]);
  assert.equal(first.responseFormat?.type ?? 'text', 'text', 'no response format beside tools');
  assert.deepEqual(first.toolChoice, { type: 'required' });
  assert.match(promptText(model.doStreamCalls[1]!), /feat: the answer/, 'the git history came back to the model');
  assert.match(promptText(model.doStreamCalls[2]!), /export const answer = 42/, 'the file came back to the model');
});

test('a provider without a response format answers through the submit tool even with no repo', async () => {
  const model = scripted(toolCall(SUBMIT_TOOL, { answer: 'ok' }));
  const result = await runnerWith({ provider: mockProvider(model, 'none'), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' });
  assert.deepEqual(result.output, { answer: 'ok' });
  assert.deepEqual((model.doStreamCalls[0]!.tools ?? []).map((t) => t.name), [SUBMIT_TOOL]);
});

test('an invalid answer is sent back once with what is wrong, and the repaired one is used', async () => {
  const model = scripted(textParts('{"answer":""}'), textParts('{"answer":"fixed"}'));
  const result = await runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' });
  assert.deepEqual(result.output, { answer: 'fixed' });
  assert.equal(result.repaired, true);
  assert.equal(result.usage.totalTokens, 30);
  assert.match(promptText(model.doStreamCalls[1]!), /not valid: answer:/);

  const submitModel = scripted(toolCall(SUBMIT_TOOL, { answer: '' }), toolCall(SUBMIT_TOOL, { answer: 'fixed' }, 'call-2'));
  const submitted = await runnerWith({ provider: mockProvider(submitModel, 'none'), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' });
  assert.deepEqual(submitted.output, { answer: 'fixed' });
  assert.deepEqual(submitModel.doStreamCalls[1]!.toolChoice, { type: 'tool', toolName: SUBMIT_TOOL }, 'the repair may only submit');

  const stubborn = scripted(textParts('not json'));
  await assert.rejects(
    runnerWith({ provider: mockProvider(stubborn), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' }),
    (error: unknown) => error instanceof AiError && error.code === 'ai_invalid_output' && !error.retryable,
  );
  assert.equal(stubborn.doStreamCalls.length, 2, 'one repair, no more');
});

test('a model that only reads until its step ceiling has no answer', async () => {
  const { hostDir, repo } = await workspace();
  const model = scripted(toolCall('list_files', {}));
  await assert.rejects(
    runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } }, { hostDir }).run(answerTask('always', 3), { prompt: 'Answer.', repo: { hostDir: repo } }),
    (error: unknown) => error instanceof AiError && error.code === 'ai_no_answer' && /all 3 steps/.test(error.message),
  );
  assert.equal(model.doStreamCalls.length, 3);
});

const hanging = (options: StreamOptions): Promise<never> =>
  new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal?.reason), { once: true }));

test('the task’s deadline and the caller’s abort both stop the call, told apart', async () => {
  const timings: Array<{ outcome: string }> = [];
  const runner = runnerWith({ provider: mockProvider(scripted(hanging)), settings: { apiKey: 'k' } }, { telemetry: { timing: (s) => timings.push(s) } });
  await assert.rejects(
    runner.run(answerTask(), { prompt: 'Answer.', limits: { timeoutMs: 30 } }),
    (error: unknown) => error instanceof AiError && error.code === 'ai_timeout' && error.retryable,
  );
  const controller = new AbortController();
  const run = runner.run(answerTask(), { prompt: 'Answer.', abortSignal: controller.signal });
  controller.abort();
  await assert.rejects(run, (error: unknown) => error instanceof AiError && error.code === 'ai_aborted' && !error.retryable);
  assert.deepEqual(timings.map((t) => t.outcome), ['retry', 'error']);
});

test('a provider’s HTTP refusal becomes an AiError the job queue can act on', async () => {
  const refusing = (statusCode: number) => async (): Promise<never> => {
    throw new APICallError({ message: `status ${statusCode}`, url: 'https://ai.example/v1', requestBodyValues: {}, statusCode });
  };
  const cases: Array<[number, string, boolean]> = [
    [429, 'ai_rate_limited', true],
    [503, 'ai_unavailable', true],
    [401, 'ai_not_connected', false],
    [400, 'ai_refused', false],
  ];
  for (const [status, code, retryable] of cases) {
    const runner = runnerWith({ provider: mockProvider(scripted(refusing(status))), settings: { apiKey: 'k' } });
    await assert.rejects(runner.run(answerTask(), { prompt: 'Answer.' }), (error: unknown) => {
      assert.ok(error instanceof AiError, String(error));
      assert.equal(error.code, code);
      assert.equal(error.retryable, retryable);
      assert.equal(error.provider, 'mock');
      if (status === 401) assert.match(error.message, /reconnect the AI provider/);
      return true;
    });
  }
});

test('a text task streams as it comes, its tokens counted at the end', async () => {
  const model = scripted(textParts('Hello, ', 'world'));
  const stream = runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } }).stream(textTask, { messages: [{ role: 'user', content: 'Say hello' }] });
  const pieces: string[] = [];
  for await (const piece of stream.textStream) pieces.push(piece);
  assert.deepEqual(pieces, ['Hello, ', 'world']);
  const result = await stream.result;
  assert.equal(result.text, 'Hello, world');
  assert.equal(result.usage.totalTokens, 15);

  const failing = runnerWith({ provider: mockProvider(scripted(async () => Promise.reject(new APICallError({ message: 'down', url: 'u', requestBodyValues: {}, statusCode: 502 })))), settings: { apiKey: 'k' } });
  const read = async () => {
    for await (const _ of failing.stream(textTask, { prompt: 'Say hello' }).textStream) void _;
  };
  await assert.rejects(read(), (error: unknown) => error instanceof AiError && error.code === 'ai_unavailable');
});

/** An OpenAI chat completions stream, as server-sent events */
function sse(...deltas: Array<Record<string, unknown>>): Response {
  const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
    `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
  const last = deltas.length - 1;
  const body = deltas.map((d, i) => chunk(d, i === last ? (d.tool_calls ? 'tool_calls' : 'stop') : null)).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

interface Request {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function recording(requests: Request[], answer: () => Response): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return answer();
  }) as typeof fetch;
}

test('claudio reads the repo itself: the checkout’s path and its read-only preset in headers, the response format, no tools', async () => {
  const { hostDir, repo } = await workspace();
  const requests: Request[] = [];
  const fetch = recording(requests, () => sse({ role: 'assistant', content: '{"answer":"from claudio"}' }));
  const runner = runnerWith({ provider: claudioAiProvider, settings: { url: 'http://claudio:8798/', token: 'tok-secret-1', toolPreset: 'read-only' } }, { hostDir, fetch });
  const result = await runner.run(answerTask('always'), { prompt: 'Answer.', repo: { hostDir: repo } });
  assert.deepEqual(result.output, { answer: 'from claudio' });
  const [request] = requests;
  assert.equal(request!.url, 'http://claudio:8798/api/v1/chat/completions');
  assert.equal(request!.headers.get('x-claudio-cwd'), '/workspace/yeyo11__demo@v1');
  assert.equal(request!.headers.get('x-claudio-tool-preset'), 'read-only');
  assert.equal(request!.headers.get('authorization'), 'Bearer tok-secret-1');
  assert.equal((request!.body.response_format as { type?: string }).type, 'json_schema');
  assert.equal(request!.body.tools, undefined);
  assert.equal(request!.body.model, 'default');

  // No repo: an empty folder of the mount to work in, and no tools to explore with
  await runner.run(answerTask('never'), { prompt: 'Answer.' });
  assert.equal(requests[1]!.headers.get('x-claudio-cwd'), '/workspace/.shipcast-empty');
  assert.equal(requests[1]!.headers.get('x-claudio-tool-preset'), null);
});

test('a local-tools provider over HTTP gets the repo’s tools and the submit tool, and no response format', async () => {
  const { hostDir, repo } = await workspace();
  const requests: Request[] = [];
  const fetch = recording(requests, () => sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: SUBMIT_TOOL, arguments: '{"answer":"done"}' } }] }));
  const runner = runnerWith({ provider: fakeAiProvider, settings: { apiKey: 'fake-secret-9' } }, { hostDir, fetch });
  const result = await runner.run(answerTask('always'), { prompt: 'Answer.', repo: { hostDir: repo } });
  assert.deepEqual(result.output, { answer: 'done' });
  const body = requests[0]!.body;
  const tools = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
  assert.deepEqual(tools, ['git', 'list_files', 'read_files', 'repo_overview', 'search', SUBMIT_TOOL]);
  assert.equal(body.response_format, undefined);
  assert.equal(requests[0]!.headers.get('x-claudio-cwd'), null);
});

test('no provider’s secret reaches an error message, whatever its server echoes', async () => {
  for (const status of [401, 400, 429, 500]) {
    for (const [provider, settings, secret] of [
      [fakeAiProvider, { apiKey: 'fake-secret-9a8b' }, 'fake-secret-9a8b'],
      [claudioAiProvider, { url: 'http://claudio:8798', token: 'tok-secret-7c6d' }, 'tok-secret-7c6d'],
    ] as const) {
      const fetch = recording([], () => new Response(JSON.stringify({ error: { message: `bad key ${secret}` } }), { status, headers: { 'content-type': 'application/json' } }));
      const runner = runnerWith({ provider, settings }, { fetch });
      await assert.rejects(runner.run(answerTask(), { prompt: 'Answer.' }), (error: unknown) => {
        assert.ok(error instanceof AiError, String(error));
        assert.doesNotMatch(error.message, new RegExp(secret), `${provider.id} ${status}`);
        return true;
      });
    }
  }
});

test('a provider that caches gets its breakpoints on a run with the repo’s tools: the system prompt and every call', async () => {
  const caching = anthropicAiProvider.capabilities.promptCaching;
  assert.ok(caching, 'the Anthropic API declares its prompt caching');
  const cachingProvider = (model: MockLanguageModelV4): AiProviderDefinition => {
    const base = mockProvider(model);
    return { ...base, capabilities: { ...base.capabilities, promptCaching: caching }, providerOptions: { anthropic: { sendReasoning: false } } };
  };
  const { hostDir, repo } = await workspace();
  const model = scripted(toolCall('repo_overview', {}), toolCall(SUBMIT_TOOL, { answer: '42' }));
  const toolCalls: string[] = [];
  const steps: Array<number | undefined> = [];
  const runner = runnerWith({ provider: cachingProvider(model), settings: { apiKey: 'k' } }, { hostDir });
  await runner.run(answerTask('always'), {
    system: 'Read the code.',
    prompt: 'What is the answer?',
    repo: { hostDir: repo },
    observer: { toolCall: (c) => toolCalls.push(c.name), step: (u) => steps.push(u.inputTokens) },
  });
  for (const call of model.doStreamCalls) {
    assert.deepEqual(call.providerOptions, { anthropic: { sendReasoning: false, cacheControl: { type: 'ephemeral' } } }, 'the call’s breakpoint, beside the provider’s own options');
    const system = call.prompt[0]!;
    assert.equal(system.role, 'system');
    assert.deepEqual(system.providerOptions, { anthropic: { cacheControl: { type: 'ephemeral' } } }, 'the system prompt’s breakpoint, on every step');
  }
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(toolCalls, ['repo_overview', SUBMIT_TOOL], 'the observer saw every tool call');
  assert.deepEqual(steps, [10, 10], 'and every model call’s tokens');

  // No tools, no loop to cache: the call is left as the provider sends it
  const plain = scripted(textParts('{"answer":"yes"}'));
  await runnerWith({ provider: cachingProvider(plain), settings: { apiKey: 'k' } }).run(answerTask(), { system: 'Be brief.', prompt: 'Answer.' });
  assert.deepEqual(plain.doStreamCalls[0]!.providerOptions, { anthropic: { sendReasoning: false } });
  assert.equal(plain.doStreamCalls[0]!.prompt[0]!.providerOptions, undefined);
});
