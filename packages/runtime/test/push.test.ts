import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GitHubRest, Launch, PipelineDeps, PublishResult } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import {
  deliverPush,
  draftEvent,
  eventChoices,
  launchName,
  MemoryStore,
  publishEvent,
  pushFailureKind,
  pushPayload,
  pushRecipients,
  pushTopic,
  PushRetry,
  PushServiceError,
  pushSetup,
  queuePush,
  wantsEvent,
  workHandlers,
  type JobContext,
  type JobQueue,
  type PushEvent,
  type PushTransport,
} from '../src/index.ts';

/*
 * Web push (docs/push.md): what each event says, that it never says anything private, which devices
 * are told, and what a push service's answer does to a subscription. Nothing reaches a real push
 * service: every send goes through a fake transport.
 */

// A real pair's shape: a P-256 point (65 bytes) and a scalar (32 bytes), made up for the tests
const PUBLIC = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const PRIVATE = Buffer.alloc(32, 9).toString('base64url');
const ENV = { SHIPCAST_VAPID_PUBLIC_KEY: PUBLIC, SHIPCAST_VAPID_PRIVATE_KEY: PRIVATE, SHIPCAST_PUBLIC_URL: 'https://shipcast.example.dev' };

const launch = (over: Partial<Launch> = {}) => ({ id: 12, repo: 'yeyo11/claudio', ref: 'v0.9.0', ...over }) as Launch;

const SECRET = 'my secret unannounced product';

function published(over: Partial<Extract<PublishResult, { state: 'published' | 'partial' }>> = {}): PublishResult {
  return { state: 'published', launch: launch(), posted: [], problems: [], scheduled: [], failures: [], heldElsewhere: [], ...over };
}

describe('the payload of each event', () => {
  test('names a release by its repo and tag, and opens the page the event is about', () => {
    assert.deepEqual(pushPayload({ kind: 'approval', launchId: 12, launch: launch() }), { title: 'Drafts to review', body: 'claudio v0.9.0 is drafted and waits for your approval.', url: '/launches/12', tag: 'launch-12' });
    assert.deepEqual(pushPayload({ kind: 'published', launchId: 12, launch: launch() }), { title: 'Launch published', body: 'claudio v0.9.0 is out on every channel.', url: '/launches/12', tag: 'launch-12' });
    assert.deepEqual(pushPayload({ kind: 'failed', launchId: 12, launch: launch(), stage: 'publish', channels: ['bluesky', 'devto'] }).body, 'claudio v0.9.0 failed on bluesky, devto.');
    assert.deepEqual(pushPayload({ kind: 'failed', launchId: 12, launch: launch(), stage: 'draft' }).body, 'claudio v0.9.0 could not be drafted.');
    assert.deepEqual(pushPayload({ kind: 'comments', waiting: 3 }), { title: 'Comments waiting', body: '3 replies wait for your approval.', url: '/comments', tag: 'comments' });
    assert.equal(pushPayload({ kind: 'comments', waiting: 1 }).body, 'A reply waits for your approval.');
    assert.equal(pushPayload({ kind: 'test' }).url, '/settings/notifications');
  });

  test('never carries private text: an article is never named by its slug, and nothing but channel ids is echoed', () => {
    const article = launch({ repo: 'yeyo11/launches', ref: `article:${SECRET.replaceAll(' ', '-')}` });
    const events: PushEvent[] = [
      { kind: 'approval', launchId: 3, launch: article },
      { kind: 'published', launchId: 3, launch: article },
      { kind: 'failed', launchId: 3, launch: article, stage: 'draft' },
      { kind: 'failed', launchId: 3, launch: launch(), stage: 'publish', channels: [`bluesky: ${SECRET}`, 'devto'] },
      { kind: 'failed', launchId: 3, launch: launch({ repo: `yeyo11/${SECRET}` }), stage: 'publish' },
      { kind: 'comments', waiting: 2 },
      { kind: 'test' },
    ];
    for (const event of events) {
      const payload = pushPayload(event);
      const text = JSON.stringify(payload);
      for (const word of ['secret', 'unannounced', 'product']) assert.ok(!text.includes(word), `${event.kind}: ${text}`);
      assert.deepEqual(Object.keys(payload).sort(), ['body', 'tag', 'title', 'url']);
      assert.match(payload.url, /^\/[^/]/, 'a path of the app, never another origin');
      assert.ok(payload.title.length <= 40 && payload.body.length <= 120, text);
    }
    assert.equal(launchName(article), 'Your article');
    assert.equal(launchName(launch({ repo: 'sources' })), 'A launch');
    assert.equal(pushPayload(events[3]!).body, 'claudio v0.9.0 failed on devto.');
  });

  test('a long name is cut, so a notification stays one line', () => {
    assert.ok(launchName(launch({ ref: `v1.0.0-${'x'.repeat(100)}` })).length <= 60);
  });
});

describe('which events a run makes', () => {
  test('a publish run: published when all is out, failed when a piece failed for good, nothing while a retry follows', () => {
    const failed = { channel: 'bluesky' as const, message: SECRET, retryable: true };
    assert.equal(publishEvent(launch(), published(), { final: false })?.kind, 'published');
    assert.equal(publishEvent(launch(), published({ state: 'partial', failures: [failed] }), { final: false }), undefined);
    const final = publishEvent(launch(), published({ state: 'partial', failures: [failed, { ...failed, channel: 'devto', retryable: false }] }), { final: true });
    assert.deepEqual(final, { kind: 'failed', launchId: 12, launch: launch(), stage: 'publish', channels: ['bluesky', 'devto'] });
    assert.equal(publishEvent(launch(), published({ state: 'partial', failures: [{ ...failed, retryable: false }] }), { final: false })?.kind, 'failed');
    assert.equal(publishEvent(launch(), published({ state: 'partial', scheduled: [{ channel: 'devto', at: '2026-11-03T10:00:00Z' }] }), { final: true }), undefined, 'only time is missing');
    assert.equal(publishEvent(launch(), { state: 'waiting', launch: launch(), reason: 'the site' }, { final: true }), undefined);
    assert.equal(publishEvent(launch(), { state: 'skipped', launch: launch() }, { final: true }), undefined);
  });

  test('a draft run: approval while the drafts wait for the owner, failed when it could not draft', () => {
    assert.equal(draftEvent(launch(), { ok: true }, true)?.kind, 'approval');
    assert.equal(draftEvent(launch(), { ok: true }, false), undefined);
    assert.deepEqual(draftEvent(launch(), { ok: false }, false), { kind: 'failed', launchId: 12, launch: launch(), stage: 'draft' });
  });
});

describe('the devices told', () => {
  test('a kind a device never set is on; one it turned off is not; a test always goes', () => {
    assert.equal(wantsEvent({}, { kind: 'approval' }), true);
    assert.equal(wantsEvent({ approval: false }, { kind: 'approval' }), false);
    assert.equal(wantsEvent({ approval: false }, { kind: 'failed' }), true);
    assert.equal(wantsEvent({ approval: false, comments: false, failed: false, published: false }, { kind: 'test' }), true);
    assert.deepEqual(eventChoices({ published: false, unknown: false }), { comments: true, approval: true, failed: true, published: false });
  });

  test('the recipients are the devices that want it, or for a test the ones asked for', () => {
    const row = (id: number, events: Record<string, boolean>) => ({ id, events }) as Parameters<typeof pushRecipients>[0][number];
    const rows = [row(1, {}), row(2, { comments: false }), row(3, { comments: true })];
    assert.deepEqual(pushRecipients(rows, { kind: 'comments', waiting: 1 }).map((r) => r.id), [1, 3]);
    assert.deepEqual(pushRecipients(rows, { kind: 'test' }, [2]).map((r) => r.id), [2]);
  });
});

describe('the configuration', () => {
  test('off without keys, invalid when half set or malformed, ready with the public URL as the subject', () => {
    assert.deepEqual(pushSetup({}), { state: 'off' });
    assert.match(JSON.stringify(pushSetup({ SHIPCAST_VAPID_PUBLIC_KEY: PUBLIC })), /SHIPCAST_VAPID_PRIVATE_KEY is missing/);
    assert.match(JSON.stringify(pushSetup({ ...ENV, SHIPCAST_VAPID_PUBLIC_KEY: 'nope' })), /not a VAPID public key/);
    assert.match(JSON.stringify(pushSetup({ ...ENV, SHIPCAST_VAPID_PRIVATE_KEY: PUBLIC })), /not a VAPID private key/);
    assert.match(JSON.stringify(pushSetup({ ...ENV, SHIPCAST_VAPID_SUBJECT: 'someone' })), /mailto: or https:/);
    assert.deepEqual(pushSetup(ENV), { state: 'ready', config: { publicKey: PUBLIC, privateKey: PRIVATE, subject: 'https://shipcast.example.dev' } });
    // The keys never appear in a problem
    for (const setup of [pushSetup({ ...ENV, SHIPCAST_VAPID_PUBLIC_KEY: `${PRIVATE}x` }), pushSetup({ ...ENV, SHIPCAST_VAPID_PRIVATE_KEY: `${PUBLIC}` })]) assert.ok(!JSON.stringify(setup).includes(PRIVATE) && !JSON.stringify(setup).includes(PUBLIC.slice(0, 20)));
  });
});

/** A transport that answers what each test says, and remembers what it was given */
function fakeTransport(answer: (endpoint: string) => number) {
  const sent: Array<{ endpoint: string; payload: unknown; topic: string; ttl: number }> = [];
  const transport: PushTransport = {
    async send(subscription, payload, options) {
      const status = answer(subscription.endpoint);
      if (status >= 300 || status === 0) throw new PushServiceError(status, `${status} from the fake`);
      sent.push({ endpoint: subscription.endpoint, payload: JSON.parse(payload), topic: options.topic, ttl: options.ttlSeconds });
      return { statusCode: status };
    },
  };
  return { transport, sent };
}

async function subscribed(count: number, events: Record<string, boolean> = {}) {
  const registry = await memoryRegistry();
  const rows = [];
  for (let i = 1; i <= count; i++) rows.push(await registry.pushSubscriptions.subscribe({ login: 'owner', endpoint: `https://push.example/${i}`, p256dh: 'p', auth: 'a', label: `Device ${i}`, events }));
  return { registry, rows };
}

describe('a delivery', () => {
  test('a success is recorded on the device', async () => {
    const { registry, rows } = await subscribed(1);
    const { transport, sent } = fakeTransport(() => 201);
    assert.equal(await deliverPush(registry, transport, rows[0]!.id, { kind: 'test' }, () => new Date('2026-11-02T10:00:00Z')), 'sent');
    assert.deepEqual(sent, [{ endpoint: 'https://push.example/1', payload: pushPayload({ kind: 'test' }), topic: pushTopic('test'), ttl: 300 }]);
    assert.equal((await registry.pushSubscriptions.subscription(rows[0]!.id))?.lastSuccessAt, '2026-11-02T10:00:00.000Z');
  });

  test('a 404 or a 410 deletes the subscription, and nothing is retried', async () => {
    for (const status of [404, 410]) {
      const { registry, rows } = await subscribed(2);
      const { transport } = fakeTransport((endpoint) => (endpoint.endsWith('/1') ? status : 201));
      assert.equal(await deliverPush(registry, transport, rows[0]!.id, { kind: 'test' }), 'gone');
      assert.deepEqual((await registry.pushSubscriptions.subscriptions()).map((r) => r.endpoint), ['https://push.example/2'], `${status}: only the gone device goes`);
    }
  });

  test('a throttled or failing push service is retried; any other refusal is recorded and not', async () => {
    assert.deepEqual([0, 408, 429, 500, 503, 404, 410, 400, 403, 413].map(pushFailureKind), ['retry', 'retry', 'retry', 'retry', 'retry', 'gone', 'gone', 'refused', 'refused', 'refused']);
    const { registry, rows } = await subscribed(1);
    await assert.rejects(deliverPush(registry, fakeTransport(() => 503).transport, rows[0]!.id, { kind: 'test' }), PushRetry);
    assert.match((await registry.pushSubscriptions.subscription(rows[0]!.id))?.lastFailure ?? '', /503/);
    assert.equal(await deliverPush(registry, fakeTransport(() => 403).transport, rows[0]!.id, { kind: 'test' }), 'refused');
    assert.equal((await registry.pushSubscriptions.subscriptions()).length, 1, 'a refusal keeps the device');
  });

  test('the Topic header is valid for every push service: 32 base64url characters made from the tag (Apple refused `launch-16`)', async () => {
    const events: PushEvent[] = [
      { kind: 'comments', waiting: 2 },
      { kind: 'approval', launchId: 16, launch: launch() },
      { kind: 'failed', launchId: 16, launch: launch(), stage: 'publish', channels: ['bluesky'] },
      { kind: 'published', launchId: 16, launch: launch() },
      { kind: 'published', launchId: 123456789, launch: launch() },
      { kind: 'test' },
    ];
    const { registry, rows } = await subscribed(1);
    const { transport, sent } = fakeTransport(() => 201);
    for (const event of events) assert.equal(await deliverPush(registry, transport, rows[0]!.id, event), 'sent');
    assert.equal(sent.length, events.length);
    for (const [i, { topic, payload }] of sent.entries()) {
      // RFC 8030 §5.4: at most 32 characters of the URL- and filename-safe Base64 alphabet; whole quads, as Apple decodes it
      assert.ok(topic.length <= 32, `${events[i]!.kind}: ${topic}`);
      assert.match(topic, /^[A-Za-z0-9_-]+$/, events[i]!.kind);
      assert.equal(topic.length % 4, 0, `${events[i]!.kind}: ${topic}`);
      assert.equal(topic, pushTopic((payload as { tag: string }).tag), 'the topic is made from the tag');
    }
    // The notification's own tag is unchanged: the device still replaces a launch's older notification
    assert.equal((sent[1]!.payload as { tag: string }).tag, 'launch-16');
    // The same tag is the same topic (the push service still coalesces), different launches differ
    assert.equal(pushTopic('launch-16'), pushTopic('launch-16'));
    assert.equal(sent[1]!.topic, sent[3]!.topic);
    assert.notEqual(pushTopic('launch-16'), pushTopic('launch-17'));
    assert.notEqual(sent[3]!.topic, sent[4]!.topic);
    assert.equal(new Set([pushTopic('comments'), pushTopic('test'), pushTopic('launch-16')]).size, 3);
  });

  test('a device that turned the kind off since, or left, is not told', async () => {
    const { registry, rows } = await subscribed(1);
    const { transport, sent } = fakeTransport(() => 201);
    await registry.pushSubscriptions.setEvents(rows[0]!.id, { published: false });
    assert.equal(await deliverPush(registry, transport, rows[0]!.id, { kind: 'published', launchId: 1, launch: launch() }), 'unwanted');
    assert.equal(await deliverPush(registry, transport, 999, { kind: 'test' }), 'missing');
    assert.deepEqual(sent, []);
  });
});

/** A queue that only records what was sent */
function sendingQueue() {
  const sent: Array<{ queue: string; data: unknown }> = [];
  const queue = { send: async (name: string, data: unknown) => (sent.push({ queue: name, data }), `job-${sent.length}`) } as unknown as JobQueue;
  return { queue, sent };
}

describe('queueing an event', () => {
  test('one push job per device that wants it; none without keys', async () => {
    const { registry, rows } = await subscribed(3);
    await registry.pushSubscriptions.setEvents(rows[1]!.id, { comments: false });
    const event: PushEvent = { kind: 'comments', waiting: 2 };
    const off = sendingQueue();
    assert.equal(await queuePush({ queue: off.queue, registry, env: {} }, event), 0);
    assert.deepEqual(off.sent, []);
    const on = sendingQueue();
    assert.equal(await queuePush({ queue: on.queue, registry, env: ENV }, event), 2);
    assert.deepEqual(on.sent, [
      { queue: 'push', data: { subscriptionId: rows[0]!.id, event } },
      { queue: 'push', data: { subscriptionId: rows[2]!.id, event } },
    ]);
  });

  test('a failure to queue never throws at the work that tells of it', async () => {
    const lines: string[] = [];
    const registry = { pushSubscriptions: { subscriptions: () => Promise.reject(new Error('the database is down')) } } as unknown as Parameters<typeof queuePush>[0]['registry'];
    assert.equal(await queuePush({ queue: sendingQueue().queue, registry, env: ENV, log: (l) => lines.push(l) }, { kind: 'test' }), 0);
    assert.match(lines.join(), /not queued: the database is down/);
  });
});

describe('the push job', () => {
  const job = (lines: string[]): JobContext => ({ id: 'j', attempt: 1, lastAttempt: false, log: (l) => lines.push(l), link: () => undefined, signal: new AbortController().signal });

  test('sends through the transport, prunes a gone device and says it, and does nothing without keys', async () => {
    const { registry, rows } = await subscribed(2);
    const { transport, sent } = fakeTransport((endpoint) => (endpoint.endsWith('/2') ? 410 : 201));
    const deps = (env: NodeJS.ProcessEnv) => ({ env, registry, github: {} as GitHubRest, secrets: new MemoryStore(), pipeline: {} as PipelineDeps, brand: () => Promise.reject(new Error('no brand')), pushTransport: transport });
    const { push } = workHandlers(sendingQueue().queue, deps(ENV));
    const lines: string[] = [];
    await push!({ subscriptionId: rows[0]!.id, event: { kind: 'test' } }, job(lines));
    await push!({ subscriptionId: rows[1]!.id, event: { kind: 'test' } }, job(lines));
    assert.equal(sent.length, 1);
    assert.deepEqual(lines, ['Sent', 'The browser dropped this subscription (404 or 410): the device is removed']);
    assert.equal((await registry.pushSubscriptions.subscriptions()).length, 1);

    const quiet: string[] = [];
    await workHandlers(sendingQueue().queue, deps({})).push!({ subscriptionId: rows[0]!.id, event: { kind: 'test' } }, job(quiet));
    assert.deepEqual(quiet, ['Push is not configured: nothing sent']);
    assert.equal(sent.length, 1);
  });
});
