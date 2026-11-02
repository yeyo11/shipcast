import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiError, fakeClient, named, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const KEY = 'account:4:reconnect:1x2y3z';

const ROUTES: FakeRoutes = {
  'GET /attention': {
    count: 1,
    items: [{ key: KEY, kind: 'reconnect', text: '@me@m.example (Mastodon) needs reconnecting', action: 'Reconnect', accountId: 4, url: 'https://shipcast.example/channels?focus=4' }],
  },
  'POST /attention/dismiss': ({ body }) => Response.json({ dismissed: (JSON.parse(body) as { keys: string[] }).keys.length }),
};

test('the attention tools make their one API call each, in the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const listed = await runTool(api, 'list_attention', {});
  assert.match(JSON.stringify(listed), /"kind":"reconnect".*"accountId":4/);
  assert.deepEqual(await runTool(api, 'dismiss_attention', { keys: [KEY, 'launch:3:waiting:2026-10-26T10:00:00.000Z'] }), { dismissed: 2 });
  assert.deepEqual(fake.calls, ['GET /attention', `POST /attention/dismiss {"keys":["${KEY}","launch:3:waiting:2026-10-26T10:00:00.000Z"]}`]);
});

test('dismiss_attention takes 1 to 100 of the bell\'s keys and calls nothing otherwise', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const args of [{ keys: [] }, { keys: ['not a key'] }, { keys: Array.from({ length: 101 }, (_, i) => `launch:${i}:waiting:x`) }, {}]) {
    assert.match(await refusal(api, 'dismiss_attention', args), /Invalid arguments for dismiss_attention/);
  }
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('the API\'s refusal reaches the model, and dismissing is a setting of Shipcast\'s own', async () => {
  const { api } = fakeClient({ 'POST /attention/dismiss': () => apiError(409, 'refused', 'the attention list is not available in this process') });
  assert.match(await refusal(api, 'dismiss_attention', { keys: [KEY] }), /not available in this process/);

  assert.equal(named('list_attention').hints.readOnlyHint, true);
  const dismiss = named('dismiss_attention').hints;
  assert.deepEqual([dismiss.readOnlyHint, dismiss.destructiveHint, dismiss.openWorldHint, dismiss.idempotentHint], [false, false, false, true]);
  // The model learns from the list which tool acts on each kind of line
  for (const word of ['approve_drafts', 'retry_channel', 'list_comments', 'reconnect', 'nothingOut', 'scheduled', 'canonical', 'drift', 'permission']) {
    assert.ok(named('list_attention').description.includes(word), word);
  }
});
