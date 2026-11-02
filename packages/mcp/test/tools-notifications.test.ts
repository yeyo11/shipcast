import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiError, fakeClient, named, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const device = { id: 4, label: 'Safari on iPhone', login: 'owner', events: { comments: true, approval: true, failed: true, published: false }, createdAt: '2026-11-02T10:00:00.000Z', endpointHash: 'abc' };

const ROUTES: FakeRoutes = {
  'GET /notifications': { configured: true, events: [], devices: [device] },
  'PATCH /notifications/devices/4': ({ body }) => Response.json({ device: { ...device, events: { ...device.events, ...(JSON.parse(body) as { events: object }).events } } }),
  'DELETE /notifications/devices/4': { removed: true },
  'POST /notifications/test': () => Response.json({ queued: 1 }, { status: 202 }),
};

test('the notification tools make their one API call each, in the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.match(JSON.stringify(await runTool(api, 'list_notification_devices', {})), /"label":"Safari on iPhone"/);
  assert.match(JSON.stringify(await runTool(api, 'set_notification_events', { deviceId: 4, events: { published: true } })), /"published":true/);
  assert.deepEqual(await runTool(api, 'send_test_notification', { deviceId: 4 }), { queued: 1 });
  assert.deepEqual(await runTool(api, 'send_test_notification', {}), { queued: 1 });
  assert.deepEqual(await runTool(api, 'delete_notification_device', { deviceId: 4 }), { removed: true });
  assert.deepEqual(fake.calls, [
    'GET /notifications',
    'PATCH /notifications/devices/4 {"events":{"published":true}}',
    'POST /notifications/test {"deviceId":4}',
    'POST /notifications/test {}',
    'DELETE /notifications/devices/4',
  ]);
});

test('a choice names at least one known kind, and nothing is called otherwise', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const args of [{ deviceId: 4, events: {} }, { deviceId: 4, events: { comments: 'yes' } }, { events: { comments: true } }, { deviceId: 0, events: { comments: true } }]) {
    assert.match(await refusal(api, 'set_notification_events', args), /Invalid arguments for set_notification_events/);
  }
  assert.deepEqual(fake.calls, []);
});

test('the API\'s refusal reaches the model, and the hints say what each costs', async () => {
  const { api } = fakeClient({ 'POST /notifications/test': () => apiError(409, 'refused', 'push is not configured on this instance') });
  assert.match(await refusal(api, 'send_test_notification', {}), /not configured/);
  assert.equal(named('list_notification_devices').hints.readOnlyHint, true);
  assert.equal(named('delete_notification_device').hints.destructiveHint, true);
  assert.equal(named('set_notification_events').hints.idempotentHint, true);
});
