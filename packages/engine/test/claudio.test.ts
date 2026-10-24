import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Claudio, ClaudioError, type GenerateRequest } from '../src/index.ts';

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A claudio that answers each GET of the chat with the next view, and records every call. */
function fakeClaudio(views: unknown[], calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'POST' && url.pathname === '/api/chats') return Response.json({ id: 'chat-1', state: 'working' });
    if (method === 'POST' && url.pathname.endsWith('/stop')) return Response.json({ ok: true });
    const view = views.length > 1 ? views.shift() : views[0];
    return Response.json(view);
  }) as typeof fetch;
}

function view(state: string, opts: { output?: unknown; outcome?: string | null; error?: string | null; alive?: boolean } = {}) {
  const entries: unknown[] = [{ role: 'user', blocks: [{ type: 'text' }] }];
  if (opts.output !== undefined) {
    entries.push({ role: 'assistant', isSidechain: false, blocks: [{ type: 'tool_use', name: 'StructuredOutput', input: opts.output }] });
  }
  return {
    chat: {
      id: 'chat-1',
      state,
      alive: opts.alive ?? true,
      executions: [{ outcome: opts.outcome ?? null, error: opts.error ?? null, costUsd: 0.08 }],
    },
    entries,
  };
}

const request: GenerateRequest = {
  prompt: 'Analyse the repo',
  cwd: '/workspace/claudio',
  jsonSchema: { type: 'object' },
  allowedTools: ['Read', 'Grep', 'Glob'],
  maxBudgetUsd: 2,
};

function client(views: unknown[], calls: Call[]) {
  return new Claudio({ url: 'http://claudio:8798/', token: 'tok', fetch: fakeClaudio(views, calls), pollMs: 1, sleep: async () => {} });
}

test('a generation starts a chat with the schema and read-only tools, waits for the answer and stops the chat', async () => {
  const calls: Call[] = [];
  const result = await client([view('working'), view('working'), view('idle', { output: { ok: true } })], calls).generate(request);

  assert.deepEqual(result, { output: { ok: true }, chatId: 'chat-1', costUsd: 0.08 });
  const start = calls[0]!;
  assert.equal(start.path, '/api/chats');
  assert.deepEqual(start.body, {
    prompt: 'Analyse the repo',
    cwd: '/workspace/claudio',
    jsonSchema: { type: 'object' },
    allowedTools: ['Read', 'Grep', 'Glob'],
    permissionMode: 'dontAsk',
    maxBudgetUsd: 2,
  });
  assert.equal(calls.at(-1)?.path, '/api/chats/chat-1/stop', 'the chat is stopped once answered');
});

test('a failed execution raises with the chat id, and the chat is still stopped', async () => {
  const calls: Call[] = [];
  await assert.rejects(
    client([view('idle', { outcome: 'failed', error: 'rate limit' })], calls).generate(request),
    (e) => e instanceof ClaudioError && e.chatId === 'chat-1' && /rate limit/.test(e.message),
  );
  assert.equal(calls.at(-1)?.path, '/api/chats/chat-1/stop');
});

test('a chat that ends without calling StructuredOutput is an error, not an empty answer', async () => {
  const calls: Call[] = [];
  await assert.rejects(
    client([view('idle', { outcome: 'completed', alive: false })], calls).generate(request),
    /without a structured answer/,
  );
});

test('a live chat whose turn ended with words but no StructuredOutput is caught at once', async () => {
  const calls: Call[] = [];
  const talked = view('idle');
  talked.entries.push({ role: 'assistant', isSidechain: false, blocks: [{ type: 'text' }] });
  await assert.rejects(client([talked], calls).generate(request), /without a structured answer/);
});

test('a chat that never answers is stopped at the timeout', async () => {
  const calls: Call[] = [];
  const slow = new Claudio({
    url: 'http://claudio:8798',
    token: 'tok',
    fetch: fakeClaudio([view('working')], calls),
    pollMs: 1,
    timeoutMs: -1,
    sleep: async () => {},
  });
  await assert.rejects(slow.generate(request), /took longer than/);
  assert.equal(calls.at(-1)?.path, '/api/chats/chat-1/stop');
});

test('an answer from a subagent is not taken for the main agent’s', async () => {
  const calls: Call[] = [];
  const sidechain = view('working');
  sidechain.entries.push({ role: 'assistant', isSidechain: true, blocks: [{ type: 'tool_use', name: 'StructuredOutput', input: { wrong: 1 } }] });
  const result = await client([sidechain, view('idle', { output: { right: 1 } })], calls).generate(request);
  assert.deepEqual(result.output, { right: 1 });
});
