import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { AiError, ANALYSIS_RULES, type AiTaskDefinition } from '@shipcast/schema';
import { InvalidArgumentError, jsonSchema, Output, streamText } from 'ai';
import { z } from 'zod';
import { AiTaskRunner, CLAUDIO_ERRORS, claudioAiProvider, ClaudioWorkspaces, createClaudio, GitHubError, GitHubRest, type AiRunSetup } from '../src/index.ts';

/*
 * Claudio as an AI SDK provider, its workspaces and its readiness, against a fake Claudio and a fake
 * GitHub served in-process on 127.0.0.1: nothing here reaches a real Claudio, AI or GitHub.
 */

interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Handler = (request: Seen, response: ServerResponse) => void;

interface Fake {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

async function serve(handler: Handler): Promise<Fake> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(request);
      handler(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** Claudio's streamed chat completion: the answer as text, then the usage with its cost */
function sse(res: ServerResponse, content: string, headers: Record<string, string> = { 'x-claudio-chat-id': 'chat-7' }) {
  const chunk = (value: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'default', ...value })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
  res.end(
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_cost_usd: 0.12 } }) +
      'data: [DONE]\n\n',
  );
}

const WORKSPACE = { id: 'ws-1', bytes: 2048, files: 3, expiresAt: '2026-10-28T12:00:00Z' };
const CODELOAD = 'https://codeload.github.com/yeyo11/demo/legacy.tar.gz/refs/tags/v1';
const CLAUDIO_TOKEN = 'claudio-token-1a2b';
const GITHUB_TOKEN = 'ghs_installation-secret-9z8y';

/** A fake Claudio: workspaces, readiness and a chat that answers the task's JSON, unless a test says otherwise */
function claudio(chat: Handler = (_, res) => sse(res, '{"answer":"from claudio"}')): Promise<Fake> {
  return serve((req, res) => {
    if (req.method === 'POST' && req.path === '/api/workspaces') return json(res, 201, WORKSPACE);
    if (req.method === 'DELETE' && req.path.startsWith('/api/workspaces/')) return void res.writeHead(204).end();
    if (req.method === 'POST' && req.path === '/api/v1/chat/completions') return chat(req, res);
    json(res, 404, { error: { message: 'no route', code: 'not-found' } });
  });
}

/** A fake GitHub whose tarball answer is codeload's redirect, as the API gives it */
function github(): Promise<Fake> {
  return serve((req, res) => {
    if (req.path === '/repos/yeyo11/demo/tarball/v1' || req.path === '/repos/yeyo11/demo/tarball') return void res.writeHead(302, { location: CODELOAD }).end();
    if (req.path === '/repos/yeyo11/plain/tarball/v1') return void res.writeHead(302, { location: 'http://codeload.github.com/x.tar.gz' }).end();
    json(res, 404, { message: 'Not Found' });
  });
}

/** fetch for 127.0.0.1 only: a redirect followed to codeload, or any other host, fails the test instead of leaving the machine */
const outside: string[] = [];
const localFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== '127.0.0.1') {
    outside.push(url.href);
    throw new Error(`a test reached ${url.href}`);
  }
  return fetch(input, init);
}) as typeof fetch;

const Answer = z.strictObject({ answer: z.string().min(1) });
const answerTask = (needsRepo: AiTaskDefinition['needsRepo']): AiTaskDefinition<z.infer<typeof Answer>> => ({
  id: 'test-answer',
  settingsTask: 'pack',
  output: {
    schema: Answer,
    jsonSchema: () => ({ type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } }),
    name: 'answer',
  },
  needsRepo,
  limits: { maxSteps: 12, maxOutputTokens: 1000, timeoutMs: 10_000, maxTurns: 12, maxBudgetUsd: 0.75 },
});

function runnerOn(claudioUrl: string, githubUrl: string): AiTaskRunner {
  const setup: AiRunSetup = { provider: claudioAiProvider, settings: { url: claudioUrl, token: CLAUDIO_TOKEN } };
  return new AiTaskRunner({ resolve: async () => setup, archives: new GitHubRest({ token: GITHUB_TOKEN, baseUrl: githubUrl, fetch: localFetch }), fetch: localFetch });
}

const chats = (fake: Fake) => fake.seen.filter((s) => s.path === '/api/v1/chat/completions');
const deletes = (fake: Fake) => fake.seen.filter((s) => s.method === 'DELETE');

/** Every request Claudio saw carries its own token and nothing of GitHub's */
function onlyClaudiosToken(fake: Fake): void {
  for (const request of fake.seen) {
    if (request.path === '/api/ready') assert.equal(request.headers.authorization, undefined, 'readiness takes no token');
    else assert.equal(request.headers.authorization, `Bearer ${CLAUDIO_TOKEN}`, `${request.method} ${request.path}`);
    assert.doesNotMatch(JSON.stringify(request), new RegExp(GITHUB_TOKEN), 'no GitHub token reaches Claudio');
  }
}

test('createClaudio: a streamed chat completion with Claudio’s headers from providerOptions.claudio, the response format, and the chat id and cost back', async () => {
  const fake = await claudio();
  try {
    const model = createClaudio({ baseURL: `${fake.url}/`, token: CLAUDIO_TOKEN })();
    const result = streamText({
      model,
      prompt: 'Answer.',
      maxRetries: 0,
      output: Output.object({ schema: jsonSchema({ type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false }), name: 'answer' }),
      providerOptions: { claudio: { workspace: 'ws-9', allowedTools: ['Read', 'Bash(ls *)'], maxTurns: 7, maxBudgetUsd: 1.5, user: 'shipcast' } },
    });
    assert.deepEqual(await result.output, { answer: 'from claudio' });
    assert.deepEqual((await result.providerMetadata)?.claudio, { costUsd: 0.12, chatId: 'chat-7' });

    const [chat] = chats(fake);
    assert.ok(chat);
    assert.equal(chat.headers.authorization, `Bearer ${CLAUDIO_TOKEN}`);
    assert.equal(chat.headers['x-claudio-workspace'], 'ws-9');
    assert.deepEqual(JSON.parse(String(chat.headers['x-claudio-allowed-tools'])), ['Read', 'Bash(ls *)']);
    assert.equal(chat.headers['x-claudio-max-turns'], '7');
    assert.equal(chat.headers['x-claudio-max-budget-usd'], '1.5');
    assert.equal(chat.headers['x-claudio-tool-preset'], undefined);
    const body = JSON.parse(chat.body) as Record<string, unknown>;
    assert.equal(body.stream, true);
    assert.equal(body.model, 'default');
    assert.equal((body.response_format as { type: string }).type, 'json_schema');
    assert.equal(body.tools, undefined, 'Claude Code uses its own tools: no client tools');
    for (const key of ['workspace', 'allowedTools', 'maxTurns', 'maxBudgetUsd']) assert.equal(body[key], undefined, `${key} goes in a header, never in the body`);
    assert.equal(body.user, 'shipcast', 'another key under claudio still reaches the body, as the OpenAI-compatible model sends it');
  } finally {
    await fake.close();
  }
});

test('createClaudio: allowedTools and toolPreset together are refused before anything is sent', async () => {
  const fake = await claudio();
  try {
    const result = streamText({ model: createClaudio({ baseURL: fake.url, token: CLAUDIO_TOKEN })(), prompt: 'x', maxRetries: 0, providerOptions: { claudio: { allowedTools: ['Read'], toolPreset: 'read-only' } } });
    let failure: unknown;
    for await (const part of result.fullStream) if (part.type === 'error') failure = part.error;
    assert.ok(InvalidArgumentError.isInstance(failure), String(failure));
    assert.match(String((failure as Error).message), /exclusive/);
    assert.equal(chats(fake).length, 0);
  } finally {
    await fake.close();
  }
});

test('the runner: a workspace from the codeload URL, the analysis rules and the task’s ceilings, then the workspace deleted', async () => {
  const fake = await claudio();
  const gh = await github();
  try {
    const runner = runnerOn(fake.url, gh.url);
    const result = await runner.run(answerTask('always'), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1' }, limits: { maxBudgetUsd: 2 } });
    assert.deepEqual(result.output, { answer: 'from claudio' });
    assert.deepEqual(result.providerMetadata?.claudio, { costUsd: 0.12, chatId: 'chat-7' }, 'the chat id and cost, for the runner’s caller to record');

    assert.deepEqual(gh.seen.map((s) => s.path), ['/repos/yeyo11/demo/tarball/v1']);
    assert.equal(gh.seen[0]!.headers.authorization, `Bearer ${GITHUB_TOKEN}`, 'the token goes to GitHub’s API');
    assert.deepEqual(outside, [], 'the redirect is read, never followed');

    assert.deepEqual(fake.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/workspaces', 'POST /api/v1/chat/completions', 'DELETE /api/workspaces/ws-1']);
    assert.deepEqual(JSON.parse(fake.seen[0]!.body), { url: CODELOAD });
    const chat = chats(fake)[0]!;
    assert.equal(chat.headers['x-claudio-workspace'], 'ws-1');
    assert.deepEqual(JSON.parse(String(chat.headers['x-claudio-allowed-tools'])), [...ANALYSIS_RULES]);
    assert.equal(chat.headers['x-claudio-max-turns'], '12');
    assert.equal(chat.headers['x-claudio-max-budget-usd'], '2', 'the run’s budget over the task’s');
    const messages = (JSON.parse(chat.body) as { messages: Array<{ role: string }> }).messages;
    assert.ok(!messages.some((m) => m.role === 'assistant'), 'no assistant message: Claudio starts a chat of its own');
    onlyClaudiosToken(fake);

    // A task without the repo: no workspace, its own ceilings all the same
    fake.seen.length = 0;
    await runner.run(answerTask('never'), { prompt: 'Answer.' });
    assert.deepEqual(fake.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/v1/chat/completions']);
    assert.equal(fake.seen[0]!.headers['x-claudio-workspace'], undefined);
    assert.equal(fake.seen[0]!.headers['x-claudio-allowed-tools'], undefined);
    assert.equal(fake.seen[0]!.headers['x-claudio-max-budget-usd'], '0.75', 'the task’s budget, always sent');
    assert.equal(fake.seen[0]!.headers['x-claudio-max-turns'], '12');
  } finally {
    await Promise.all([fake.close(), gh.close()]);
  }
});

test('the runner deletes the workspace after a failed run and after an aborted one', async () => {
  const failing = await claudio((_, res) => json(res, 500, { error: { message: 'boom', type: 'server_error' } }));
  const gh = await github();
  try {
    await assert.rejects(runnerOn(failing.url, gh.url).run(answerTask('always'), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1' } }), (error: unknown) => error instanceof AiError && error.code === 'ai_unavailable');
    assert.equal(deletes(failing).length, 1);
    assert.equal(deletes(failing)[0]!.path, '/api/workspaces/ws-1');
  } finally {
    await failing.close();
  }

  const controller = new AbortController();
  // The chat never answers: the run is aborted while Claude Code works
  const hanging = await claudio((req, res) => {
    controller.abort();
    res.on('close', () => res.end());
    void req;
  });
  try {
    await assert.rejects(
      runnerOn(hanging.url, gh.url).run(answerTask('always'), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1' }, abortSignal: controller.signal }),
      (error: unknown) => error instanceof AiError && error.code === 'ai_aborted',
    );
    assert.equal(deletes(hanging).length, 1, 'released, though the run was aborted');
  } finally {
    await Promise.all([hanging.close(), gh.close()]);
  }
});

test('each of Claudio’s error codes becomes the AiError of its table entry', async () => {
  const chatCodes: Array<[number, string]> = [
    [429, 'rate_limit_exceeded'],
    [422, 'max_turns'],
    [422, 'max_budget'],
    [422, 'tool_blocked'],
    [422, 'no_structured_output'],
    [400, 'cwd_missing'],
    [404, 'workspace_not_found'],
    [410, 'workspace_expired'],
    [409, 'policy_mismatch'],
    [503, 'starting'],
    [503, 'signed-out'],
  ];
  for (const [status, code] of chatCodes) {
    const fake = await claudio((_, res) => json(res, status, { error: { message: `claudio says ${code} ${CLAUDIO_TOKEN}`, type: 'invalid_request_error', code } }));
    try {
      await assert.rejects(runnerOn(fake.url, 'http://127.0.0.1:9').run(answerTask('never'), { prompt: 'Answer.' }), (error: unknown) => {
        assert.ok(error instanceof AiError, String(error));
        assert.equal(error.code, CLAUDIO_ERRORS[code]!.code, code);
        assert.match(error.message, new RegExp(code));
        assert.doesNotMatch(error.message, new RegExp(CLAUDIO_TOKEN), 'the token echoed by the server is taken out');
        return true;
      });
    } finally {
      await fake.close();
    }
  }

  // Streamed, Claudio sends the error as the last chunk before [DONE], after what was written so far
  const midStream = await claudio((_, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const partial = { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'default', choices: [{ index: 0, delta: { role: 'assistant', content: '{"ans' }, finish_reason: null }] };
    const error = { error: { message: 'max turns reached', type: 'invalid_request_error', code: 'max_turns' } };
    res.end(`data: ${JSON.stringify(partial)}\n\ndata: ${JSON.stringify(error)}\n\ndata: [DONE]\n\n`);
  });
  try {
    await assert.rejects(runnerOn(midStream.url, 'http://127.0.0.1:9').run(answerTask('never'), { prompt: 'Answer.' }), (error: unknown) => error instanceof AiError && error.code === 'ai_no_answer');
  } finally {
    await midStream.close();
  }
});

test('a 429 with Retry-After is a retryable AiError that says how long to wait', async () => {
  const fake = await claudio((_, res) => json(res, 429, { error: { message: 'usage limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'retry-after': '30' }));
  try {
    await assert.rejects(runnerOn(fake.url, 'http://127.0.0.1:9').run(answerTask('never'), { prompt: 'Answer.' }), (error: unknown) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, 'ai_rate_limited');
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 30_000);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('a workspace Claudio refuses fails the run before any chat, and leaves nothing to delete', async () => {
  for (const [status, code, expected, retryable] of [
    [413, 'workspace-too-large', 'ai_refused', false],
    [429, 'workspace-limit', 'ai_rate_limited', true],
    [400, 'workspace-host-not-allowed', 'ai_refused', false],
    [400, 'workspace-address-blocked', 'ai_refused', false],
    [422, 'workspace-bad-archive', 'ai_refused', false],
  ] as const) {
    const fake = await serve((req, res) => json(res, status, { error: { code, message: `refused ${req.path}` } }));
    const gh = await github();
    try {
      await assert.rejects(runnerOn(fake.url, gh.url).run(answerTask('always'), { prompt: 'Answer.', repo: { name: 'yeyo11/demo', ref: 'v1' } }), (error: unknown) => {
        assert.ok(error instanceof AiError, String(error));
        assert.equal(error.code, expected, code);
        assert.equal(error.retryable, retryable, code);
        return true;
      });
      assert.deepEqual(fake.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/workspaces'], code);
    } finally {
      await Promise.all([fake.close(), gh.close()]);
    }
  }
});

test('ClaudioWorkspaces: created from a URL or a gzip tarball, and a delete of one already gone is fine', async () => {
  let deleted = 0;
  const fake = await serve((req, res) => {
    if (req.method === 'POST') return json(res, 201, { ...WORKSPACE, bytes: req.body.length });
    deleted++;
    if (deleted === 1) return void res.writeHead(204).end();
    json(res, 404, { error: { code: 'workspace-not-found', message: 'gone' } });
  });
  try {
    const workspaces = new ClaudioWorkspaces({ baseURL: fake.url, token: CLAUDIO_TOKEN });
    assert.equal((await workspaces.create({ url: CODELOAD })).id, WORKSPACE.id);
    const archive = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0]);
    await workspaces.create({ archive });
    assert.equal(fake.seen[1]!.headers['content-type'], 'application/gzip');
    assert.equal(fake.seen[0]!.headers['content-type'], 'application/json');
    await workspaces.delete('ws-1');
    await workspaces.delete('ws-1');
    assert.deepEqual(fake.seen.slice(2).map((s) => `${s.method} ${s.path}`), ['DELETE /api/workspaces/ws-1', 'DELETE /api/workspaces/ws-1']);
    onlyClaudiosToken(fake);
  } finally {
    await fake.close();
  }
});

test('readiness: ready, each reason it is not, and a Claudio that does not answer', async () => {
  let answer: { status: number; body: unknown } = { status: 200, body: { ready: true } };
  const fake = await serve((req, res) => (req.path === '/api/ready' ? json(res, answer.status, answer.body) : json(res, 404, {})));
  const ready = () => claudioAiProvider.ready!({ url: fake.url, token: CLAUDIO_TOKEN });
  try {
    assert.deepEqual(await ready(), { ready: true });
    for (const reason of ['cli-missing', 'signed-out', 'sign-in-expired', 'starting']) {
      answer = { status: 503, body: { ready: false, reason } };
      const got = await ready();
      assert.equal(got.ready, false);
      assert.ok(!got.ready);
      assert.equal(got.reason, reason);
      assert.match(got.message, new RegExp(CLAUDIO_ERRORS[reason]!.message.split(':')[0]!));
    }
    assert.match(((await ready()) as { message: string }).message, /still starting/);
    onlyClaudiosToken(fake);
  } finally {
    await fake.close();
  }
  assert.deepEqual(await claudioAiProvider.ready!({ url: fake.url, token: CLAUDIO_TOKEN }), { ready: false, reason: 'unreachable', message: `the ${claudioAiProvider.name} could not be reached` });
  assert.equal(claudioAiProvider.name, 'Claude Code — your subscription (via Claudio)');
  assert.deepEqual(claudioAiProvider.settings.map((f) => f.key), ['url', 'token'], 'the same settings, no migration');
});

test('GitHub’s tarball redirect is read without following it, for a ref or the default branch', async () => {
  const gh = await github();
  try {
    const client = new GitHubRest({ token: GITHUB_TOKEN, baseUrl: gh.url, fetch: localFetch });
    assert.equal(await client.tarballUrl('yeyo11/demo', 'v1'), CODELOAD);
    assert.equal(await client.tarballUrl('yeyo11/demo', 'HEAD'), CODELOAD);
    assert.deepEqual(gh.seen.map((s) => s.path), ['/repos/yeyo11/demo/tarball/v1', '/repos/yeyo11/demo/tarball']);
    assert.ok(gh.seen.every((s) => s.headers.authorization === `Bearer ${GITHUB_TOKEN}`));
    assert.deepEqual(outside, []);
    await assert.rejects(client.tarballUrl('yeyo11/missing', 'v1'), (error: unknown) => error instanceof GitHubError && error.status === 404);
    await assert.rejects(client.tarballUrl('yeyo11/plain', 'v1'), /not an https download/);
  } finally {
    await gh.close();
  }
});
