import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCKED_ASSISTANT_ARTICLE_RULES, LOCKED_ASSISTANT_LAUNCH_RULES, type Launch } from '@shipcast/engine';
import { memoryRegistry, mockRunner, scriptedModel, textParts, type ModelScript } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { readEvents, type AssistantEvent } from '../src/components/assistant/protocol.ts';
import { handleAssistant, parseAssistantRequest, sessionTitle, type AssistantDeps } from '../src/server/assistant.ts';
import { tourSteps } from '../src/components/tour/steps.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const at = '2026-10-26T00:00:00.000Z';
const release: Launch = { id: 7, repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal', status: 'drafted', detail: null, createdAt: at, updatedAt: at };

/** The AI SDK's mock model, as the engine's test kit builds it */
type MockModel = ReturnType<typeof scriptedModel>;

function deps(model: MockModel): AssistantDeps {
  return {
    aiRunner: mockRunner(model),
    brand: async () => brand,
    launch: async (id) => (id === release.id ? release : undefined),
    grounding: async (launch) => ({ kind: 'launch', launch: { repo: launch.repo, ref: launch.ref, analysis: { summary: 's', implemented: ['REST API'], planned: [], documentedOnly: [], limitations: [] } } }),
    startCheck: async () => assert.fail('no check is queued here'),
  };
}

/** A model that streams these pieces of text */
const streaming = (...pieces: string[]) => scriptedModel(textParts(...pieces));

/** A model whose stream gives `before`, then fails with `message` */
const failing = (message: string, ...before: string[]): MockModel => {
  const script: ModelScript = before.length === 0 ? async () => Promise.reject(new Error(message)) : [{ type: 'text-start', id: 't' }, ...before.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })), { type: 'error', error: new Error(message) }];
  return scriptedModel(script);
};

/** What the model was sent on its first call: the system prompt, the single user prompt, and the conversation */
function sent(model: MockModel): { system?: string; prompt?: string; messages: unknown } {
  const call = model.doStreamCalls[0]!;
  const system = call.prompt.find((m) => m.role === 'system');
  const users = call.prompt.filter((m) => m.role !== 'system');
  const first = users[0];
  return {
    ...(system && { system: system.content }),
    ...(users.length === 1 && first?.role === 'user' && { prompt: first.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }),
    messages: users,
  };
}

async function ask(body: unknown, model: MockModel, sessions?: AssistantDeps['sessions']): Promise<{ status: number; events: AssistantEvent[]; json?: unknown }> {
  const request = new Request('http://app/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await handleAssistant(request, async () => ({ ...deps(model), ...(sessions && { sessions }) }));
  if (!response.headers.get('content-type')?.includes('ndjson')) return { status: response.status, events: [], json: await response.json() };
  const events: AssistantEvent[] = [];
  for await (const event of readEvents(response.body!)) events.push(event);
  return { status: response.status, events };
}

const text = (events: AssistantEvent[]) => events.map((e) => (e.type === 'text' ? e.text : '')).join('');

test('a quick action streams the model’s text as NDJSON events, then done', async () => {
  const model = streaming('A shorter ', 'intro.');
  const { status, events } = await ask({ action: 'shorten', selection: 'A long, winding intro.', document: 'A long, winding intro.\n\nMore.', lang: 'en' }, model);
  assert.equal(status, 200);
  assert.deepEqual(events, [{ type: 'text', text: 'A shorter ' }, { type: 'text', text: 'intro.' }, { type: 'done' }]);
  assert.ok(sent(model).system?.endsWith(LOCKED_ASSISTANT_ARTICLE_RULES.join('\n')), 'a free article gets the article’s locked rules');
  assert.match(sent(model).prompt ?? '', /Shorten the passage/);
});

test('a draft of a launch is grounded in its analysis and gets the code’s locked rules', async () => {
  const model = streaming('ok');
  await ask({ action: 'improve', selection: '', document: 'claudio has a REST API.', launchId: 7, channel: 'bluesky' }, model);
  assert.ok(sent(model).system?.endsWith(LOCKED_ASSISTANT_LAUNCH_RULES.join('\n')));
  assert.match(sent(model).system ?? '', /- REST API/);
});

test('a chat turn sends the conversation, and the text with the selection in the system prompt', async () => {
  const model = streaming('```proposal\nNew.\n```');
  const { events } = await ask({ action: 'chat', selection: 'Old.', document: 'Old. Rest.', messages: [{ role: 'user', content: 'Punchier, please' }] }, model);
  assert.equal(text(events), '```proposal\nNew.\n```');
  assert.match(sent(model).system ?? '', /The passage the owner selected:\n<<<\nOld\.\n>>>/);
  // The SDK may add empty fields (providerOptions: undefined) to what it sends; the conversation is what counts
  assert.deepEqual(JSON.parse(JSON.stringify(sent(model).messages)), [{ role: 'user', content: [{ type: 'text', text: 'Punchier, please' }] }]);
});

test('checking an article against the code is refused with the reason, as an event', async () => {
  const { events } = await ask({ action: 'check', selection: 'x', document: 'x' }, streaming('never'));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.match(events[0]?.type === 'error' ? events[0].message : '', /no code to check against/);
});

test('a failing model ends the stream with an error event, not a broken stream', async () => {
  const { events } = await ask({ action: 'improve', selection: 'x', document: 'x' }, failing('the model is down'));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.match(events[0]?.type === 'error' ? events[0].message : '', /the model is down/);
});

test('a malformed request is refused before the AI is asked', async () => {
  const model = streaming('never');
  assert.equal((await ask({ action: 'rewrite-everything', document: 'x' }, model)).status, 400);
  assert.equal((await ask({ action: 'improve', selection: '', document: '   ' }, model)).status, 400);
  assert.equal(model.doStreamCalls.length, 0);
  assert.throws(() => parseAssistantRequest({ action: 'chat', document: 'x', messages: [{ role: 'assistant', content: 'hi' }] }), /ends with your message/);
  assert.throws(() => parseAssistantRequest({ action: 'adapt', document: 'x', target: 'myspace' }), /network/);
  assert.throws(() => parseAssistantRequest({ action: 'improve', document: 'x', lang: 'fr' }), /en or es/);
});

test('the tour chains its pages, and leaves the launch page out when there is no launch', () => {
  const steps = tourSteps({ launchId: 12 });
  assert.ok(steps.length >= 5 && steps.length <= 7, `${steps.length} steps`);
  assert.deepEqual([...new Set(steps.map((s) => s.route))], ['/', '/launches/12', '/write', '/channels', '/settings/automation']);
  steps.forEach((step, i) => {
    const next = steps[i + 1];
    assert.equal(step.nextRoute, next && next.route !== step.route ? next.route : undefined);
    // A target must belong to its own page, or NextStep would move on before the navigation lands
    if (step.selector) assert.ok(step.selector.startsWith(`main[data-path="${step.route}"]`), step.selector);
  });
  assert.ok(!tourSteps({ launchId: null }).some((s) => s.route.startsWith('/launches/')));
});

test('a chat turn is saved as it streams: the question, then the answer with its proposals, in one session', async () => {
  const registry = await memoryRegistry();
  const model = streaming('Try this:\n```proposal\nNew.\n```');
  const body = { action: 'chat', selection: 'Old.', range: { start: 0, end: 4 }, document: 'Old. Rest.', draftPath: 'launches/claudio/v1.0.0/bluesky.md', draftLabel: 'Bluesky', messages: [{ role: 'user', content: 'Punchier, please' }] };
  const { events } = await ask(body, model, registry.assistant);
  const saved = events.find((e) => e.type === 'saved');
  assert.ok(saved && saved.type === 'saved');
  assert.equal(events.at(-1)?.type, 'done');

  const session = await registry.assistant.assistantSession(saved.sessionId);
  assert.deepEqual({ title: session?.title, launchId: session?.launchId, draftPath: session?.draftPath, draftLabel: session?.draftLabel }, { title: 'Punchier, please', launchId: null, draftPath: 'launches/claudio/v1.0.0/bluesky.md', draftLabel: 'Bluesky' });
  const turns = await registry.assistant.assistantMessages(saved.sessionId);
  assert.deepEqual(turns.map((t) => [t.role, t.content]), [['user', 'Punchier, please'], ['assistant', 'Try this:\n```proposal\nNew.\n```']]);
  assert.deepEqual(turns[0]?.selection, { start: 0, end: 4, original: 'Old.' });
  assert.deepEqual(turns[1]?.proposals, [{ text: 'New.', state: 'open' }]);
  assert.equal(turns[1]?.id, saved.messageId);

  // A second turn with the session's id continues it instead of starting another
  await ask({ ...body, sessionId: saved.sessionId, messages: [{ role: 'user', content: 'Again' }] }, streaming('Done.'), registry.assistant);
  assert.equal((await registry.assistant.assistantSessions()).sessions.length, 1);
  assert.equal((await registry.assistant.assistantMessages(saved.sessionId)).length, 4);
});

test('a failed answer is saved with why it stopped, and a quick action is not saved at all', async () => {
  const registry = await memoryRegistry();
  await ask({ action: 'chat', selection: '', document: 'x', messages: [{ role: 'user', content: 'Hi' }] }, failing('the model is down', 'Half'), registry.assistant);
  const [session] = (await registry.assistant.assistantSessions()).sessions;
  const turns = await registry.assistant.assistantMessages(session!.id);
  assert.equal(turns[1]?.content, 'Half');
  assert.match(turns[1]?.problem ?? '', /the model is down/);

  await ask({ action: 'improve', selection: 'x', document: 'x' }, streaming('y'), registry.assistant);
  assert.equal((await registry.assistant.assistantSessions()).sessions.length, 1);
});

test('a session is titled by the first question, or by the draft when there are no words', () => {
  assert.equal(sessionTitle('  Make   it\npunchier ', 'Bluesky'), 'Make it punchier');
  assert.equal(sessionTitle('', 'Bluesky'), 'Bluesky');
  assert.equal(sessionTitle('x'.repeat(200), undefined).length, 80);
  assert.throws(() => parseAssistantRequest({ action: 'chat', document: 'x', sessionId: 0, messages: [{ role: 'user', content: 'hi' }] }), /sessionId/);
  assert.throws(() => parseAssistantRequest({ action: 'chat', document: 'x', range: { start: 5, end: 2 }, messages: [{ role: 'user', content: 'hi' }] }), /range/);
});
