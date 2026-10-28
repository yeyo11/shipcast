import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Claudio, ClaudioError, type ObjectRequest } from '../src/legacy-ai.ts';

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

const request: ObjectRequest = {
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
  const result = await client([view('working'), view('working'), view('idle', { output: { ok: true } })], calls).generateObject(request);

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
    client([view('idle', { outcome: 'failed', error: 'rate limit' })], calls).generateObject(request),
    (e) => e instanceof ClaudioError && e.chatId === 'chat-1' && /rate limit/.test(e.message),
  );
  assert.equal(calls.at(-1)?.path, '/api/chats/chat-1/stop');
});

test('a chat that ends without calling StructuredOutput is an error, not an empty answer', async () => {
  const calls: Call[] = [];
  await assert.rejects(
    client([view('idle', { outcome: 'completed', alive: false })], calls).generateObject(request),
    /without a structured answer/,
  );
});

test('a usage limit says so, with when it resets, instead of "without a structured answer"', async () => {
  // As Shipcast v0.2.0's drafting chat was seen on 2026-10-27: idle, the limit a synthetic line, the execution not ended yet
  const limited = view('idle');
  limited.entries.push(
    { role: 'assistant', isSidechain: false, model: 'claude-sonnet-5-5', blocks: [{ type: 'tool_use', name: 'Bash', input: {} }] },
    { role: 'assistant', isSidechain: false, model: '<synthetic>', blocks: [{ type: 'text', text: "You've hit your session limit · resets 7:30pm (UTC)" }] },
  );
  await assert.rejects(client([limited], []).generateObject(request), (e) => {
    assert.ok(e instanceof ClaudioError);
    assert.equal(e.message, "Claude's usage limit was reached (You've hit your session limit · resets 7:30pm (UTC)): launch it again once it resets");
    assert.equal(e.chatId, 'chat-1');
    return true;
  });
  // Another synthetic stop keeps its own words
  const stopped = view('idle', { outcome: 'stopped' });
  stopped.entries.push({ role: 'assistant', isSidechain: false, model: '<synthetic>', blocks: [{ type: 'text', text: 'Credit balance is too low' }] });
  await assert.rejects(client([stopped], []).generateObject(request), /^Error: claudio chat stopped: Credit balance is too low$|claudio chat stopped: Credit balance is too low/);
});

test('a live chat whose turn ended with words but no StructuredOutput is caught at once', async () => {
  const calls: Call[] = [];
  const talked = view('idle');
  talked.entries.push({ role: 'assistant', isSidechain: false, blocks: [{ type: 'text' }] });
  await assert.rejects(client([talked], calls).generateObject(request), /without a structured answer/);
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
  await assert.rejects(slow.generateObject(request), /took longer than/);
  assert.equal(calls.at(-1)?.path, '/api/chats/chat-1/stop');
});

test('an answer from a subagent is not taken for the main agent’s', async () => {
  const calls: Call[] = [];
  const sidechain = view('working');
  sidechain.entries.push({ role: 'assistant', isSidechain: true, blocks: [{ type: 'tool_use', name: 'StructuredOutput', input: { wrong: 1 } }] });
  const result = await client([sidechain, view('idle', { output: { right: 1 } })], calls).generateObject(request);
  assert.deepEqual(result.output, { right: 1 });
});
