import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Claudio, LOCKED_ASSISTANT_ARTICLE_RULES, LOCKED_ASSISTANT_LAUNCH_RULES, type AiProvider, type Launch } from '@shipcast/engine';
import { mockStreamingProvider, type StreamCall } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { readEvents, type AssistantEvent } from '../src/components/assistant/protocol.ts';
import { handleAssistant, parseAssistantRequest, type AssistantDeps } from '../src/server/assistant.ts';
import { tourSteps } from '../src/components/tour/steps.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const at = '2026-10-26T00:00:00.000Z';
const release: Launch = { id: 7, repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal', status: 'drafted', detail: null, createdAt: at, updatedAt: at };

function deps(provider: AiProvider): AssistantDeps {
  return {
    setup: async () => ({ provider, prompts: {} }),
    brand: async () => brand,
    launch: async (id) => (id === release.id ? release : undefined),
    grounding: async (launch) => ({ kind: 'launch', launch: { repo: launch.repo, ref: launch.ref, analysis: { summary: 's', implemented: ['REST API'], planned: [], documentedOnly: [], limitations: [] } } }),
    checkout: async () => assert.fail('nothing is checked out here'),
    aiWorkdir: '/workspace',
  };
}

async function ask(body: unknown, provider: AiProvider): Promise<{ status: number; events: AssistantEvent[]; json?: unknown }> {
  const request = new Request('http://app/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await handleAssistant(request, async () => deps(provider));
  if (!response.headers.get('content-type')?.includes('ndjson')) return { status: response.status, events: [], json: await response.json() };
  const events: AssistantEvent[] = [];
  for await (const event of readEvents(response.body!)) events.push(event);
  return { status: response.status, events };
}

const text = (events: AssistantEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');

test('a quick action streams the model’s text as NDJSON events, then done', async () => {
  const calls: StreamCall[] = [];
  const provider = await mockStreamingProvider(['A shorter ', 'intro.'], calls);
  const { status, events } = await ask({ action: 'shorten', selection: 'A long, winding intro.', document: 'A long, winding intro.\n\nMore.', lang: 'en' }, provider);
  assert.equal(status, 200);
  assert.deepEqual(events, [{ type: 'text', text: 'A shorter ' }, { type: 'text', text: 'intro.' }, { type: 'done' }]);
  assert.ok(calls[0]?.system?.endsWith(LOCKED_ASSISTANT_ARTICLE_RULES.join('\n')), 'a free article gets the article’s locked rules');
  assert.match(calls[0]?.prompt ?? '', /Shorten the passage/);
});

test('a draft of a launch is grounded in its analysis and gets the code’s locked rules', async () => {
  const calls: StreamCall[] = [];
  const provider = await mockStreamingProvider(['ok'], calls);
  await ask({ action: 'improve', selection: '', document: 'claudio has a REST API.', launchId: 7, channel: 'bluesky' }, provider);
  assert.ok(calls[0]?.system?.endsWith(LOCKED_ASSISTANT_LAUNCH_RULES.join('\n')));
  assert.match(calls[0]?.system ?? '', /- REST API/);
});

test('a chat turn sends the conversation, and the text with the selection in the system prompt', async () => {
  const calls: StreamCall[] = [];
  const provider = await mockStreamingProvider(['```proposal\nNew.\n```'], calls);
  const { events } = await ask({ action: 'chat', selection: 'Old.', document: 'Old. Rest.', messages: [{ role: 'user', content: 'Punchier, please' }] }, provider);
  assert.equal(text(events), '```proposal\nNew.\n```');
  assert.match(calls[0]?.system ?? '', /The passage the owner selected:\n<<<\nOld\.\n>>>/);
  // The SDK may add empty fields (providerOptions: undefined) to what it sends; the conversation is what counts
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]?.messages)), [{ role: 'user', content: [{ type: 'text', text: 'Punchier, please' }] }]);
});

test('checking an article against the code is refused with the reason, as an event', async () => {
  const provider = await mockStreamingProvider(['never']);
  const { events } = await ask({ action: 'check', selection: 'x', document: 'x' }, provider);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.match(events[0]?.type === 'error' ? events[0].message : '', /no code to check against/);
});

test('a failing model ends the stream with an error event, not a broken stream', async () => {
  const failing: AiProvider = {
    id: 'test',
    generateObject: async () => assert.fail('not used'),
    streamText: async function* () {
      throw new Error('the model is down');
    },
  };
  const { events } = await ask({ action: 'improve', selection: 'x', document: 'x' }, failing);
  assert.deepEqual(events, [{ type: 'error', message: 'the model is down' }]);
});

test('with claudio and no streaming API, the answer comes whole through the REST chat, announced first', async () => {
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.startsWith('/api/v1/')) return Response.json({ error: 'route not found' }, { status: 404 });
    if (method === 'POST') posted.push({ path: url.pathname, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
    if (method === 'POST' && url.pathname === '/api/chats') return Response.json({ id: 'c1', state: 'working' });
    if (method === 'POST') return Response.json({ ok: true });
    return Response.json({
      chat: { id: 'c1', state: 'idle', alive: true, executions: [{ outcome: 'success', error: null, costUsd: 0.01 }] },
      entries: [{ role: 'assistant', isSidechain: false, blocks: [{ type: 'tool_use', name: 'StructuredOutput', input: { text: 'Una intro corta.' } }] }],
    });
  }) as typeof globalThis.fetch;
  const claudio = new Claudio({ url: 'http://claudio:8798', token: 't', fetch, pollMs: 1, sleep: async () => {} });
  const { events } = await ask({ action: 'translate', selection: 'A short intro.', document: 'A short intro.', lang: 'en' }, claudio);
  assert.deepEqual(events, [{ type: 'whole' }, { type: 'text', text: 'Una intro corta.' }, { type: 'done' }]);
  const chat = posted.find((p) => p.path === '/api/chats');
  assert.equal(chat?.body.cwd, '/workspace');
  assert.match(String(chat?.body.prompt), /into Spanish/);
  assert.ok(String(chat?.body.appendSystemPrompt).endsWith(LOCKED_ASSISTANT_ARTICLE_RULES.join('\n')));
});

test('a malformed request is refused before the AI is asked', async () => {
  const provider = await mockStreamingProvider(['never']);
  assert.equal((await ask({ action: 'rewrite-everything', document: 'x' }, provider)).status, 400);
  assert.equal((await ask({ action: 'improve', selection: '', document: '   ' }, provider)).status, 400);
  assert.throws(() => parseAssistantRequest({ action: 'chat', document: 'x', messages: [{ role: 'assistant', content: 'hi' }] }), /ends with your message/);
  assert.throws(() => parseAssistantRequest({ action: 'adapt', document: 'x', target: 'myspace' }), /network/);
  assert.throws(() => parseAssistantRequest({ action: 'improve', document: 'x', lang: 'fr' }), /en or es/);
});

test('the tour chains its pages, and leaves the launch page out when there is no launch', () => {
  const steps = tourSteps({ launchId: 12 });
  assert.ok(steps.length >= 5 && steps.length <= 7, `${steps.length} steps`);
  assert.deepEqual([...new Set(steps.map((s) => s.route))], ['/', '/launches/12', '/write', '/channels', '/automation']);
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    assert.equal(step.nextRoute, next && next.route !== step.route ? next.route : undefined);
    // A target must belong to its own page, or NextStep would move on before the navigation lands
    if (step.selector) assert.ok(step.selector.startsWith(`main[data-path="${step.route}"]`), step.selector);
  });
  assert.ok(!tourSteps({ launchId: null }).some((s) => s.route.startsWith('/launches/')));
});
