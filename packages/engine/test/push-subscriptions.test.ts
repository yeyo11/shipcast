import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry } from '../src/testing.ts';

/* The browsers that take web push (docs/push.md): one row per endpoint, the owner's choices kept */

const device = { login: 'owner', endpoint: 'https://push.example/abc', p256dh: 'key-1', auth: 'auth-1', label: 'Chrome on Android' };

test('subscribing the same endpoint again updates its row and keeps the events chosen', async () => {
  const registry = await memoryRegistry();
  const first = await registry.pushSubscriptions.subscribe(device);
  assert.deepEqual(first.events, {});
  await registry.pushSubscriptions.setEvents(first.id, { published: false });
  await registry.pushSubscriptions.recordFailure(first.id, '400 bad', new Date('2026-11-02T10:00:00Z'));
  const again = await registry.pushSubscriptions.subscribe({ ...device, p256dh: 'key-2', label: 'Chrome on Pixel' });
  assert.equal(again.id, first.id);
  assert.deepEqual([again.p256dh, again.label, again.events, again.lastFailure], ['key-2', 'Chrome on Pixel', { published: false }, null]);
  assert.equal((await registry.pushSubscriptions.subscriptions()).length, 1);
});

test('setting events merges them, and a device is removed by id or by endpoint', async () => {
  const registry = await memoryRegistry();
  const row = await registry.pushSubscriptions.subscribe(device);
  await registry.pushSubscriptions.setEvents(row.id, { comments: false });
  assert.deepEqual((await registry.pushSubscriptions.setEvents(row.id, { failed: true }))?.events, { comments: false, failed: true });
  assert.equal(await registry.pushSubscriptions.setEvents(999, { failed: true }), undefined);
  assert.equal(await registry.pushSubscriptions.removeEndpoint(device.endpoint), true);
  assert.equal(await registry.pushSubscriptions.remove(row.id), false);
});
