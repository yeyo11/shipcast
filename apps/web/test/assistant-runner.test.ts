import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AiTaskRunner, Launch } from '@shipcast/engine';
import { claudioAnswer, claudioChats, claudioRefusal, fakeClaudio, fakeClaudioRunner, fakeGitHubArchives, memoryRegistry, mockRunner, scriptedModel, textParts } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { readEvents, type AssistantEvent } from '../src/components/assistant/protocol.ts';
import { handleAssistant, type AssistantDeps } from '../src/server/assistant.ts';

/*
 * The writing assistant's quick actions and chat on the AI task runner: streamed by every provider,
 * so a chat or an action never announces a whole answer; the pieces make the events and the saved
 * session; a failure is an `error` event with the AiError's words.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const at = '2026-10-26T00:00:00.000Z';
const release: Launch = { id: 7, repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal', status: 'drafted', detail: null, createdAt: at, updatedAt: at };

const base: Omit<AssistantDeps, 'aiRunner'> = {
  brand: async () => brand,
  launch: async (id) => (id === release.id ? release : undefined),
  grounding: async (launch) => ({ kind: 'launch', launch: { repo: launch.repo, ref: launch.ref } }),
  startCheck: async () => assert.fail('no check is queued here'),
};

async function ask(body: unknown, deps: AssistantDeps): Promise<AssistantEvent[]> {
  const request = new Request('http://app/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await handleAssistant(request, async () => deps);
  const events: AssistantEvent[] = [];
  for await (const event of readEvents(response.body!)) events.push(event);
  return events;
}

const chat = { action: 'chat', selection: '', document: 'Old. Rest.', messages: [{ role: 'user', content: 'Punchier, please' }] };

test('assistant: the pieces make the text events and the saved session, with no whole-answer announcement', async () => {
  const pieces = ['```proposal\nNew', '.\n```'];
  const registry = await memoryRegistry();
  const model = scriptedModel(textParts(...pieces));
  const events = await ask(chat, { ...base, aiRunner: mockRunner(model), texts: async () => ({ tone: 'Plain words.' }), sessions: registry.assistant });
  const saved = events.find((e): e is Extract<AssistantEvent, { type: 'saved' }> => e.type === 'saved');
  assert.ok(saved, 'the turn is saved');
  assert.deepEqual(events, [{ type: 'text', text: pieces[0] }, { type: 'text', text: pieces[1] }, saved, { type: 'done' }]);
  const messages = (await registry.assistant.assistantMessages(saved.sessionId)).map((m) => ({ role: m.role, content: m.content, proposals: m.proposals, problem: m.problem }));
  assert.deepEqual(messages, [
    { role: 'user', content: 'Punchier, please', proposals: [], problem: null },
    { role: 'assistant', content: pieces.join(''), proposals: [{ text: 'New.', state: 'open' }], problem: null },
  ]);
  assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /Plain words\./, 'the owner’s tone');
  assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /Punchier, please/);
});

test('assistant: on Claudio a quick action streams from /v1 with no workspace and no whole-answer announcement', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioAnswer(res, 'A shorter intro.') });
  const gh = await fakeGitHubArchives();
  try {
    const events = await ask({ action: 'shorten', selection: 'A long intro.', document: 'A long intro.', launchId: 7 }, { ...base, aiRunner: fakeClaudioRunner(claudio, gh) });
    assert.deepEqual(events, [{ type: 'text', text: 'A shorter intro.' }, { type: 'done' }]);
    assert.deepEqual(claudio.seen.map((s) => `${s.method} ${s.path}`), ['POST /api/v1/chat/completions']);
    assert.equal(claudioChats(claudio)[0]!.headers['x-claudio-max-budget-usd'], '1');
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});

test('assistant: a provider’s failure ends the stream with an error event in the AiError’s words', async () => {
  const claudio = await fakeClaudio({ chat: (_, res) => claudioRefusal(res, 429, 'rate_limit_exceeded', 'session limit') });
  const gh = await fakeGitHubArchives();
  try {
    const runner: AiTaskRunner = fakeClaudioRunner(claudio, gh);
    const events = await ask({ action: 'improve', selection: 'x', document: 'x' }, { ...base, aiRunner: runner });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, 'error');
    assert.match(events[0]?.type === 'error' ? events[0].message : '', /usage limit/);
  } finally {
    await Promise.all([claudio.close(), gh.close()]);
  }
});
