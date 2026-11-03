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
  limits: { maxSteps, maxOutputTokens: 1000, timeoutMs: 10_000, maxBudgetUsd: 1 },
});
const textTask: AiTaskDefinition = { id: 'assistant', settingsTask: 'assistant', needsRepo: 'never', limits: { maxSteps: 1, maxOutputTokens: 1000, timeoutMs: 10_000, maxBudgetUsd: 1 } };

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

function runnerWith(setup: AiRunSetup, options: { fetch?: typeof fetch; telemetry?: AiTelemetry } = {}): AiTaskRunner {
  return new AiTaskRunner({
    resolve: async () => setup,
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
  const { repo } = await workspace();
  const model = scripted(toolCall('git', { command: 'log', n: 5 }), toolCall('read_files', { files: [{ path: 'src/main.ts' }] }), toolCall(SUBMIT_TOOL, { answer: '42' }));
  const runner = runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } });
  const result = await runner.run(answerTask('always'), { prompt: 'What is the answer?', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } });
  assert.deepEqual(result.output, { answer: '42' });
  assert.equal(result.steps, 3);
  assert.deepEqual(result.usage.totalTokens, 45, 'tokens summed over every step');
  const first = model.doStreamCalls[0]!;
  assert.deepEqual((first.tools ?? []).map((t) => t.name).sort(), ['git', 'list_files', 'read_files', 'repo_overview', 'search', SUBMIT_TOOL]);
  assert.equal(first.responseFormat?.type ?? 'text', 'text', 'no response format beside tools');
  assert.deepEqual(first.toolChoice, { type: 'auto' }, 'never forced: current Claude models refuse a forced tool_choice');
  assert.match(JSON.stringify(first.prompt), /call the submit_answer tool exactly once/, 'the model is told how to finish, in the system prompt');
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
  assert.deepEqual(submitModel.doStreamCalls[1]!.toolChoice, { type: 'auto' }, 'the repair asks for the submit call, never forces it');
  assert.deepEqual((submitModel.doStreamCalls[1]!.tools ?? []).map((t) => t.name), [SUBMIT_TOOL], 'with no repo, the submit tool is all there was, and all the repair offers');

  const stubborn = scripted(textParts('not json'));
  await assert.rejects(
    runnerWith({ provider: mockProvider(stubborn), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' }),
    (error: unknown) => error instanceof AiError && error.code === 'ai_invalid_output' && !error.retryable,
  );
  assert.equal(stubborn.doStreamCalls.length, 2, 'one repair, no more');
});

/** A provider that decodes strict schemas within the given limits, as the Anthropic API does */
function strictProvider(model: MockLanguageModelV4, limits = anthropicAiProvider.capabilities.strictSchemas!): AiProviderDefinition {
  const base = mockProvider(model);
  return { ...base, capabilities: { ...base.capabilities, strictSchemas: limits } };
}

const Tags = z.strictObject({ tags: z.array(z.string().regex(/^[a-z]+$/)).min(1).max(2) });
const tagsTask = (needsRepo: AiTaskDefinition['needsRepo'] = 'never'): AiTaskDefinition<z.infer<typeof Tags>> => ({
  id: 'test-tags',
  settingsTask: 'pack',
  output: { schema: Tags, jsonSchema: () => z.toJSONSchema(Tags, { target: 'draft-7', io: 'input' }) as Record<string, unknown>, name: 'tags' },
  needsRepo,
  limits: { maxSteps: 10, maxOutputTokens: 1000, timeoutMs: 10_000, maxBudgetUsd: 1 },
});
const submitToolOf = (call: StreamOptions) => {
  const submit = (call.tools ?? []).find((t) => t.name === SUBMIT_TOOL);
  assert.ok(submit && submit.type === 'function', 'the submit tool was offered');
  return submit;
};

test('a strict submit tool gets the relaxed schema, and the answer is still held to the full one, through the repair', async () => {
  const { repo } = await workspace();
  const model = scripted(toolCall(SUBMIT_TOOL, { tags: ['a', 'b', 'c'] }), toolCall(SUBMIT_TOOL, { tags: ['a', 'b'] }, 'call-2'));
  const result = await runnerWith({ provider: strictProvider(model), settings: { apiKey: 'k' } }).run(tagsTask('always'), { prompt: 'Tag it.', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } });
  assert.deepEqual(result.output, { tags: ['a', 'b'] });
  assert.equal(result.repaired, true, 'three tags break the removed maxItems: refused here, then repaired');
  assert.match(promptText(model.doStreamCalls[1]!), /not valid: tags:/);
  for (const call of model.doStreamCalls) {
    const submit = submitToolOf(call);
    assert.equal(submit.strict, true, 'within the provider’s limits, the submit tool is strict');
    const sent = JSON.stringify(submit.inputSchema);
    assert.doesNotMatch(sent, /"maxItems"|"pattern"|"\$schema"/, 'nothing a strict decoder refuses is sent');
    assert.match(sent, /"minItems":1/, 'a minItems of 1 is kept');
    assert.match(sent, /max items: 2/, 'the removed constraint is told in the description');
  }
});

test('a response format gets the relaxed schema too, and its answer is validated against the full one', async () => {
  const model = scripted(textParts('{"tags":["Not-lower"]}'), textParts('{"tags":["fine"]}'));
  const result = await runnerWith({ provider: strictProvider(model), settings: { apiKey: 'k' } }).run(tagsTask(), { prompt: 'Tag it.' });
  assert.deepEqual(result.output, { tags: ['fine'] });
  assert.equal(result.repaired, true, 'the removed pattern is enforced here');
  const format = model.doStreamCalls[0]!.responseFormat;
  assert.equal(format?.type, 'json');
  assert.doesNotMatch(JSON.stringify(format?.type === 'json' ? format.schema : undefined), /"maxItems"|"pattern"/);
  assert.equal(model.doStreamCalls[0]!.tools, undefined);
});

test('an answer past the provider’s strict limits goes through a submit tool that is not strict, never the response format', async () => {
  const model = scripted(toolCall(SUBMIT_TOOL, { tags: ['a'] }));
  const result = await runnerWith({ provider: strictProvider(model, { optionalParams: 24, unionParams: 0 }), settings: { apiKey: 'k' } }).run(
    { ...tagsTask(), output: { ...tagsTask().output!, jsonSchema: () => ({ ...z.toJSONSchema(Tags, { target: 'draft-7', io: 'input' }), properties: { tags: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } } }) } },
    { prompt: 'Tag it.' },
  );
  assert.deepEqual(result.output, { tags: ['a'] });
  const call = model.doStreamCalls[0]!;
  assert.equal(call.responseFormat?.type ?? 'text', 'text', 'a response format is always decoded strictly: not used');
  assert.equal(submitToolOf(call).strict, false);
});

test('a provider that does not decode strict schemas gets a submit tool that is not strict', async () => {
  const model = scripted(toolCall(SUBMIT_TOOL, { answer: 'ok' }));
  await runnerWith({ provider: mockProvider(model, 'none'), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' });
  assert.equal(submitToolOf(model.doStreamCalls[0]!).strict, false, 'OpenAI’s strict mode would want every optional field required');
});

test('a model that only reads until its step ceiling has no answer', async () => {
  const { repo } = await workspace();
  const model = scripted(toolCall('list_files', {}));
  await assert.rejects(
    runnerWith({ provider: mockProvider(model), settings: { apiKey: 'k' } }).run(answerTask('always', 3), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } }),
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

test('a local-tools provider over HTTP gets the repo’s tools and the submit tool, and no response format', async () => {
  const { repo } = await workspace();
  const requests: Request[] = [];
  const fetch = recording(requests, () => sse({ role: 'assistant', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: SUBMIT_TOOL, arguments: '{"answer":"done"}' } }] }));
  const runner = runnerWith({ provider: fakeAiProvider, settings: { apiKey: 'fake-secret-9' } }, { fetch });
  const result = await runner.run(answerTask('always'), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } });
  assert.deepEqual(result.output, { answer: 'done' });
  const body = requests[0]!.body;
  const tools = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
  assert.deepEqual(tools, ['git', 'list_files', 'read_files', 'repo_overview', 'search', SUBMIT_TOOL]);
  assert.equal(body.response_format, undefined);
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
  const { repo } = await workspace();
  const model = scripted(toolCall('repo_overview', {}), toolCall(SUBMIT_TOOL, { answer: '42' }));
  const toolCalls: string[] = [];
  const steps: Array<number | undefined> = [];
  const runner = runnerWith({ provider: cachingProvider(model), settings: { apiKey: 'k' } });
  await runner.run(answerTask('always'), {
    system: 'Read the code.',
    prompt: 'What is the answer?',
    repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo },
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

/** One Anthropic Messages API turn, streamed: a signed thinking block, then a tool call or text */
function anthropicTurn(n: number, then: { tool: string; input: unknown } | { text: string }): Response {
  const block = 'tool' in then ? { type: 'tool_use', id: `toolu_${n}`, name: then.tool, input: {} } : { type: 'text', text: '' };
  const delta = 'tool' in then ? { type: 'input_json_delta', partial_json: JSON.stringify(then.input) } : { type: 'text_delta', text: then.text };
  const events = [
    { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `thinking ${n}` } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${n}` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: block },
    { type: 'content_block_delta', index: 1, delta },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool' in then ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A request body as preserved thinking compares it: cache breakpoints do not count */
const comparable = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'cache_control' ? undefined : v)));

/**
 * Every call of one task must only append to the one before: same system prompt, same tools, the
 * earlier messages byte for byte. A current Claude model's thinking is bound to that prefix, and a
 * replayed block whose prefix changed is a 400 ("bound to a different conversation").
 */
function assertAppendOnly(requests: Request[]): void {
  for (let i = 1; i < requests.length; i++) {
    const [before, after] = [requests[i - 1]!.body, requests[i]!.body];
    assert.deepEqual(comparable(after.system), comparable(before.system), `request ${i + 1}: the same system prompt`);
    assert.deepEqual(after.tools, before.tools, `request ${i + 1}: the same tools, byte for byte`);
    const earlier = before.messages as unknown[];
    assert.deepEqual(comparable((after.messages as unknown[]).slice(0, earlier.length)), comparable(earlier), `request ${i + 1}: the earlier messages unchanged`);
    assert.ok((after.messages as unknown[]).length > earlier.length, `request ${i + 1}: something appended`);
  }
}

const thinkingIn = (request: Request): string[] =>
  (request.body.messages as Array<{ content: Array<{ type: string; signature?: string }> | string }>).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((c) => c.type === 'thinking').map((c) => c.signature!);

test('the Anthropic API is sent an append-only conversation: tool rounds, then a repair that keeps every tool and every earlier turn', async () => {
  const { repo } = await workspace();
  const requests: Request[] = [];
  const turns = [
    () => anthropicTurn(1, { tool: 'repo_overview', input: {} }),
    () => anthropicTurn(2, { tool: 'read_files', input: { files: [{ path: 'src/main.ts' }] } }),
    () => anthropicTurn(3, { tool: SUBMIT_TOOL, input: { answer: '' } }),
    // In the repair, a repo tool is still declared but refuses to run: the model is told to submit
    () => anthropicTurn(4, { tool: 'search', input: { pattern: 'answer' } }),
    () => anthropicTurn(5, { tool: SUBMIT_TOOL, input: { answer: '42' } }),
  ];
  const fetch = recording(requests, () => turns[requests.length - 1]!());
  const runner = runnerWith({ provider: anthropicAiProvider, settings: { apiKey: 'k' } }, { fetch });
  const result = await runner.run(answerTask('always'), { system: 'Read the code.', prompt: 'What is the answer?', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } });
  assert.deepEqual(result.output, { answer: '42' });
  assert.equal(result.repaired, true);
  assert.equal(requests.length, 5);
  assertAppendOnly(requests);
  assert.deepEqual(thinkingIn(requests[4]!), ['sig-1', 'sig-2', 'sig-3', 'sig-4'], 'every thinking block replayed, signed, in order');
  const names = (requests[3]!.body.tools as Array<{ name: string }>).map((t) => t.name).sort();
  assert.deepEqual(names, ['git', 'list_files', 'read_files', 'repo_overview', 'search', SUBMIT_TOOL], 'the repair offers every tool the task started with');
  const repairTail = JSON.stringify((requests[4]!.body.messages as unknown[]).at(-1));
  assert.match(repairTail, /Only submit_answer may be called now/, 'a repo tool called in the repair refuses to run');
  assert.doesNotMatch(repairTail, /export const answer/, 'and reads nothing');
  for (const request of requests) {
    // No thinking parameter: the API refuses `thinking` without a `type` (400 "thinking.type: Field required", 2026-11-02),
    // and the append-only conversation is what keeps replayed thinking valid
    assert.equal(request.body.thinking, undefined, 'no thinking parameter is sent');
    assert.doesNotMatch(request.headers.get('anthropic-beta') ?? '', /thinking-binding-controls/, 'nor its beta');
    assert.equal(request.body.tool_choice && (request.body.tool_choice as { type: string }).type, 'auto', 'never a forced tool_choice');
  }
});

test('a model that ends without submitting is asked to in an appended turn, with the same tools', async () => {
  const { repo } = await workspace();
  const requests: Request[] = [];
  const turns = [
    () => anthropicTurn(1, { tool: 'repo_overview', input: {} }),
    () => anthropicTurn(2, { text: 'The answer is 42.' }),
    () => anthropicTurn(3, { tool: SUBMIT_TOOL, input: { answer: '42' } }),
  ];
  const fetch = recording(requests, () => turns[requests.length - 1]!());
  const result = await runnerWith({ provider: anthropicAiProvider, settings: { apiKey: 'k' } }, { fetch }).run(answerTask('always'), { prompt: 'What is the answer?', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } });
  assert.deepEqual(result.output, { answer: '42' });
  assert.equal(requests.length, 3);
  assertAppendOnly(requests);
  assert.deepEqual(thinkingIn(requests[2]!), ['sig-1', 'sig-2']);
  assert.match(JSON.stringify((requests[2]!.body.messages as unknown[]).at(-1)), /You ended without calling submit_answer/);
});

test('a response-format task’s repair appends to the conversation too', async () => {
  const requests: Request[] = [];
  const turns = [() => anthropicTurn(1, { text: '{"answer":""}' }), () => anthropicTurn(2, { text: '{"answer":"fixed"}' })];
  const fetch = recording(requests, () => turns[requests.length - 1]!());
  const result = await runnerWith({ provider: anthropicAiProvider, settings: { apiKey: 'k' } }, { fetch }).run(answerTask(), { system: 'Be brief.', prompt: 'Answer.' });
  assert.deepEqual(result.output, { answer: 'fixed' });
  assertAppendOnly(requests);
  assert.deepEqual(thinkingIn(requests[1]!), ['sig-1']);
});

/** One Anthropic turn calling the submit tool with this raw input text, ended for this reason */
function anthropicRawSubmit(n: number, partialJson: string, stopReason: 'tool_use' | 'max_tokens'): Response {
  const events = [
    { type: 'message_start', message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: SUBMIT_TOOL, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: partialJson } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const toolResultsIn = (request: Request): string[] =>
  (request.body.messages as Array<{ content: Array<{ type: string; tool_use_id?: string }> | string }>)
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((c) => c.type === 'tool_result')
    .map((c) => c.tool_use_id!);

test('the Anthropic API gets the submit tool without eager input streaming, so its input comes back checked as JSON', async () => {
  const { repo } = await workspace();
  const requests: Request[] = [];
  const fetch = recording(requests, () => anthropicTurn(1, { tool: SUBMIT_TOOL, input: { answer: '42' } }));
  await runnerWith({ provider: anthropicAiProvider, settings: { apiKey: 'k' } }, { fetch }).run(answerTask('always'), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1', hostDir: repo } });
  const tools = requests[0]!.body.tools as Array<{ name: string; eager_input_streaming?: boolean }>;
  assert.equal(tools.find((t) => t.name === SUBMIT_TOOL)!.eager_input_streaming, undefined, 'the API buffers and validates the answer');
  assert.equal(tools.find((t) => t.name === 'read_files')!.eager_input_streaming, true, 'the repo tools keep the SDK’s default');
});

test('a submit input that is not JSON is told as such, never as “expected object, received string”, and repaired with one result per call', async () => {
  const { repo } = await workspace();
  const input = { name: 'yeyo11/demo', ref: 'v1', hostDir: repo };

  // Cut off by the output token limit, then answered whole in the repair
  const requests: Request[] = [];
  const turns = [() => anthropicRawSubmit(1, '{"answer":"the pack, cut o', 'max_tokens'), () => anthropicTurn(2, { tool: SUBMIT_TOOL, input: { answer: '42' } })];
  const fetch = recording(requests, () => turns[requests.length - 1]!());
  const result = await runnerWith({ provider: anthropicAiProvider, settings: { apiKey: 'k' } }, { fetch }).run(answerTask('always'), { prompt: 'Answer.', repo: input });
  assert.deepEqual(result.output, { answer: '42' });
  assert.equal(result.repaired, true);
  assertAppendOnly(requests);
  const repair = requests[1]!;
  assert.deepEqual(toolResultsIn(repair), ['toolu_1'], 'the cut-off call has exactly one result, the SDK’s');
  const tail = JSON.stringify((repair.body.messages as unknown[]).at(-1));
  assert.match(tail, /submit_answer input was cut off at the output token limit \(1000\)/);
  assert.doesNotMatch(tail, /expected object/);

  // Not JSON twice: the error says so
  let calls = 0;
  const broken = (async () => anthropicRawSubmit(++calls, '{"answer": "unterminated', 'tool_use')) as typeof globalThis.fetch;
  await assert.rejects(
    runnerWith({ provider: anthropicAiProvider, settings: { apiKey: 'k' } }, { fetch: broken }).run(answerTask('always'), { prompt: 'Answer.', repo: input }),
    (error: unknown) => error instanceof AiError && error.code === 'ai_invalid_output' && /the submit_answer input is not valid JSON/.test(error.message) && !/expected object/.test(error.message),
  );
  assert.equal(calls, 2, 'one repair, no more');
});

test('an answer sent as a JSON string holding the object is read once as that object, and still held to the schema', async () => {
  // Through the submit tool
  const model = scripted([{ type: 'tool-call' as const, toolCallId: 'c1', toolName: SUBMIT_TOOL, input: JSON.stringify(JSON.stringify({ answer: 'ok' })) }, finish('tool-calls')]);
  const result = await runnerWith({ provider: mockProvider(model, 'none'), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' });
  assert.deepEqual(result.output, { answer: 'ok' });
  assert.equal(result.repaired, false);

  // Through the response format
  const native = scripted(textParts(JSON.stringify(JSON.stringify({ answer: 'yes' }))));
  assert.deepEqual((await runnerWith({ provider: mockProvider(native), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' })).output, { answer: 'yes' });

  // Unwrapped to an object that breaks the schema: repaired like any invalid answer
  const invalid = scripted(textParts(JSON.stringify(JSON.stringify({ answer: '' }))), textParts('{"answer":"fixed"}'));
  const repaired = await runnerWith({ provider: mockProvider(invalid), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' });
  assert.deepEqual(repaired.output, { answer: 'fixed' });
  assert.equal(repaired.repaired, true);

  // Only once: a string encoded twice over, or a string that is not an object, is no answer
  for (const text of [JSON.stringify(JSON.stringify(JSON.stringify({ answer: 'ok' }))), JSON.stringify('just text')]) {
    const stubborn = scripted(textParts(text));
    await assert.rejects(
      runnerWith({ provider: mockProvider(stubborn), settings: { apiKey: 'k' } }).run(answerTask(), { prompt: 'Answer.' }),
      (error: unknown) => error instanceof AiError && error.code === 'ai_invalid_output' && /expected object, received string/.test(error.message),
    );
  }
});
