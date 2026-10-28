import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry } from '../src/testing.ts';

test('a session keeps its turns in order, with the proposals and what was done with them', async () => {
  const registry = await memoryRegistry();
  const session = await registry.assistant.createAssistantSession({ title: 'Shorten the intro', draftPath: 'launches/a/post.md', draftLabel: 'The intro' });
  assert.equal(session.launchId, null);
  await registry.assistant.addAssistantMessage(session.id, { role: 'user', content: 'Shorten it', selection: { start: 0, end: 5, original: 'Hello' } });
  const answer = await registry.assistant.addAssistantMessage(session.id, { role: 'assistant', content: 'Here:', proposals: [{ text: 'Hi', state: 'open' }, { text: 'Hey', state: 'open' }] });
  assert.ok(answer);

  assert.equal(await registry.assistant.settleAssistantProposal(answer.id, 1, 'accepted'), true);
  assert.equal(await registry.assistant.settleAssistantProposal(answer.id, 5, 'accepted'), false);

  const turns = await registry.assistant.assistantMessages(session.id);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant']);
  assert.deepEqual(turns[0]?.selection, { start: 0, end: 5, original: 'Hello' });
  assert.deepEqual(turns[1]?.proposals.map((p) => p.state), ['open', 'accepted']);
});

test('a message for a session that is gone is refused', async () => {
  const registry = await memoryRegistry();
  assert.equal(await registry.assistant.addAssistantMessage(999, { role: 'user', content: 'x' }), undefined);
});

test('sessions page by cursor, the most recently talked in first, and a message moves a session up', async () => {
  const registry = await memoryRegistry();
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push((await registry.assistant.createAssistantSession({ title: `Session ${i}` })).id);
  await registry.assistant.addAssistantMessage(ids[0]!, { role: 'user', content: 'back again' });

  const first = await registry.assistant.assistantSessions({ limit: 2 });
  assert.deepEqual(first.sessions.map((s) => s.id), [ids[0], ids[4]]);
  assert.ok(first.next);
  const second = await registry.assistant.assistantSessions({ limit: 2, cursor: first.next });
  assert.deepEqual(second.sessions.map((s) => s.id), [ids[3], ids[2]]);
  const third = await registry.assistant.assistantSessions({ limit: 2, cursor: second.next! });
  assert.deepEqual(third.sessions.map((s) => s.id), [ids[1]]);
  assert.equal(third.next, null);
});
