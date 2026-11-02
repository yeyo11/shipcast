import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewGitHub } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore, type JobQueue } from '@shipcast/runtime';
import { FailureLimiter, handleApi, openApiDocument, type ApiDeps } from '../src/server/api.ts';
import { eventsInput, subscribeInput } from '../src/server/push-api.ts';
import { endpointHash, pushService } from '../src/server/push.server.ts';

/* The notification routes (docs/push.md), on a PGlite registry, with a queue that only records: nothing is pushed */

const unused = async (): Promise<never> => {
  throw new Error('the notification routes start no other work');
};

const PUBLIC = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const KEYS = { SHIPCAST_VAPID_PUBLIC_KEY: PUBLIC, SHIPCAST_VAPID_PRIVATE_KEY: Buffer.alloc(32, 9).toString('base64url'), SHIPCAST_PUBLIC_URL: 'https://shipcast.example' };

async function setup(env: NodeJS.ProcessEnv = KEYS) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const sent: Array<{ queue: string; data: unknown }> = [];
  const queue = { send: async (queue: string, data: unknown) => (sent.push({ queue, data }), `job-${sent.length}`) } as unknown as JobQueue;
  const push = pushService({ registry, queue, env });
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    launchRead: { review: async () => undefined, channelConfig: async () => undefined },
    publicUrl: 'https://shipcast.example/',
    limiter: new FailureLimiter(),
    jobs: async () => ({ jobs: [], next: null }),
    startLaunch: unused,
    approve: unused,
    startArticle: unused,
    startPublishing: unused,
    editing: unused,
    armSchedule: unused,
    comments: unused,
    checkComments: unused,
    redraftComment: unused,
    push,
  };
  const tokens = { registry, secrets };
  const device = await push.subscribe({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'BPk', auth: 'xyz' }, label: 'Chrome on Android' }, 'owner');
  return { deps, push, registry, sent, device, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
}

async function call(deps: ApiDeps, method: string, path: string, token: string, body?: unknown) {
  const response = await handleApi(
    new Request(`https://shipcast.example/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    deps,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

test('the devices are listed without their endpoint or keys, and with no public key', async () => {
  const { deps, read, device } = await setup();
  const { status, body } = await call(deps, 'GET', '/notifications', read);
  assert.equal(status, 200);
  assert.equal(body.configured, true);
  assert.equal(body.publicKey, undefined);
  const text = JSON.stringify(body);
  for (const secret of ['fcm.googleapis.com', 'BPk', 'xyz']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual((body.devices as Array<{ id: number; events: object; endpointHash: string }>).map((d) => [d.id, d.events, d.endpointHash]), [
    [device.id, { comments: true, approval: true, failed: true, published: true }, endpointHash('https://fcm.googleapis.com/fcm/send/abc')],
  ]);
});

test('a device’s choices change one kind at a time; unknown kinds and devices are refused', async () => {
  const { deps, write, device } = await setup();
  const changed = await call(deps, 'PATCH', `/notifications/devices/${device.id}`, write, { events: { published: false } });
  assert.equal(changed.status, 200);
  assert.deepEqual((changed.body.device as { events: object }).events, { comments: true, approval: true, failed: true, published: false });
  assert.equal((await call(deps, 'PATCH', `/notifications/devices/${device.id}`, write, { events: { everything: true } })).status, 400);
  assert.equal((await call(deps, 'PATCH', '/notifications/devices/999', write, { events: { published: true } })).status, 404);
});

test('a test is queued for the device asked for, and refused without keys; a removed device is gone', async () => {
  const { deps, write, read, device, sent } = await setup();
  const queued = await call(deps, 'POST', '/notifications/test', write, { deviceId: device.id });
  assert.deepEqual([queued.status, queued.body], [202, { queued: 1 }]);
  assert.deepEqual(sent, [{ queue: 'push', data: { subscriptionId: device.id, event: { kind: 'test' } } }]);
  assert.equal((await call(deps, 'POST', '/notifications/test', read)).status, 403, 'a test needs the write scope');
  assert.equal((await call(deps, 'POST', '/notifications/test', write, { deviceId: 999 })).status, 409);
  assert.deepEqual((await call(deps, 'DELETE', `/notifications/devices/${device.id}`, write)).body, { removed: true });
  assert.equal((await call(deps, 'DELETE', `/notifications/devices/${device.id}`, write)).status, 404);

  const off = await setup({});
  const refused = await call(off.deps, 'POST', '/notifications/test', off.write);
  assert.equal(refused.status, 409);
  assert.match(refused.body.error?.message ?? '', /not configured/);
  assert.deepEqual(off.sent, []);
  assert.equal((await call(off.deps, 'GET', '/notifications', off.read)).body.configured, false);
});

test('the routes are in the OpenAPI document', async () => {
  const { deps } = await setup();
  const paths = Object.keys((openApiDocument('https://shipcast.example', deps) as { paths: Record<string, unknown> }).paths);
  assert.ok(paths.includes('/notifications') && paths.includes('/notifications/devices/{deviceId}') && paths.includes('/notifications/test'), paths.join());
});

test('a subscription is checked before it is kept: an https endpoint and base64url keys', () => {
  assert.deepEqual(subscribeInput({ endpoint: 'https://push.example/x', keys: { p256dh: 'BPk-_', auth: 'xyz' }, label: ' Safari on iPhone ' }), { endpoint: 'https://push.example/x', keys: { p256dh: 'BPk-_', auth: 'xyz' }, label: 'Safari on iPhone' });
  for (const bad of [{ endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } }, { endpoint: 'nope', keys: { p256dh: 'a', auth: 'b' } }, { endpoint: 'https://push.example/x', keys: { p256dh: 'a b', auth: 'b' } }, { endpoint: 'https://push.example/x' }]) {
    assert.throws(() => subscribeInput(bad), /endpoint|keys/);
  }
  assert.throws(() => eventsInput({ events: {} }), /at least one/);
  assert.throws(() => eventsInput({ events: { comments: 'yes' } }), /true or false/);
});
