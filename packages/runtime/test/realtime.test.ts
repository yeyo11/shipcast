import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import { runJob } from '../src/queue.ts';
import { withEvents } from '../src/realtime/publish.ts';
import { LiveHub, parseTopics } from '../src/realtime/stream.ts';
import { MemoryEventBus, RedisEventBus, type EventName, type ShipcastEvents } from '../src/redis/index.ts';
import { redisSkip, testRedis } from './redis-helper.ts';

/*
 * Phase 9's server side: the registry's writes announce themselves on the bus (publish.ts), and the
 * hub turns the bus into each tab's event stream (stream.ts), across processes through Redis.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every event the bus carried, in order */
async function recorder(bus: MemoryEventBus) {
  const seen: Array<{ event: EventName; payload: unknown }> = [];
  const names: EventName[] = ['launch.changed', 'post.changed', 'job.changed', 'comment.changed', 'metrics.changed', 'account.changed', 'attention.changed'];
  for (const event of names) await bus.subscribe(event, (payload) => seen.push({ event, payload }));
  return seen;
}

/** The stream's text as it arrives, read until `until` holds or the time is up */
function streamOf(response: Response) {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let ended = false;
  return {
    get text() {
      return text;
    },
    get ended() {
      return ended;
    },
    async until(test: (text: string) => boolean, ms = 2000): Promise<string> {
      const deadline = Date.now() + ms;
      while (!test(text)) {
        if (ended) throw new Error(`the stream ended before it said what was awaited; it said:\n${text}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timed out; the stream said:\n${text}`);
        const next = await Promise.race([reader.read(), sleep(left).then(() => undefined)]);
        if (!next) continue;
        if (next.done) ended = true;
        else text += decoder.decode(next.value, { stream: true });
      }
      return text;
    },
    cancel: () => reader.cancel(),
  };
}

const request = (query = '', headers: Record<string, string> = {}, signal?: AbortSignal) => new Request(`https://app.test/api/events${query}`, { headers, ...(signal && { signal }) });

/** The `id:` lines of a stream's text */
const ids = (text: string) => [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
const kinds = (text: string) => [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

describe('the registry announces its writes', () => {
  test('each kind of change names what changed, ids only', async () => {
    const base = await memoryRegistry();
    const bus = new MemoryEventBus();
    const seen = await recorder(bus);
    const { registry, flush } = withEvents(base, bus);
    const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
    await registry.launches.setStatus(launch.id, 'drafted');
    const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', externalId: 'at://1', url: 'https://bsky.app/1' });
    await registry.cursors.setCursor(`publish-failed:${launch.id}:devto`, 'refused');
    await registry.cursors.setCursor('github:etag', 'W/"1"');
    const account = await registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: 'Me', settings: {} });
    const comment = { postId: post.id, channel: 'bluesky' as const, externalId: 'c1', author: { handle: 'someone' }, text: 'Nice', createdAt: new Date().toISOString(), own: false };
    await registry.comments.recordComment(comment);
    // Read again by the next run: no change, no event
    await registry.comments.recordComment(comment);
    await registry.attention.dismissAttention(['launch:1:approve']);
    // The bell's own sweep that removed nothing is not news
    await registry.attention.clearAttentionDismissals(['launch:1:approve']);
    await flush();
    await tick();
    assert.deepEqual(
      seen.map((s) => [s.event, s.payload]),
      [
        ['launch.changed', { launchId: launch.id }],
        ['launch.changed', { launchId: launch.id }],
        ['post.changed', { postId: post.id, launchId: launch.id }],
        ['launch.changed', { launchId: launch.id }],
        ['account.changed', { accountId: account.id }],
        ['comment.changed', { commentId: 1, launchId: launch.id }],
        ['attention.changed', { dismissed: 1 }],
      ],
    );
  });

  test("a launch's metric readings are one event per run, a job's burst one event with its state then", async () => {
    const base = await memoryRegistry();
    const bus = new MemoryEventBus();
    const seen = await recorder(bus);
    const { registry, flush } = withEvents(base, bus);
    const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
    seen.length = 0;
    for (const source of ['bluesky', 'mastodon', 'devto', 'github']) await registry.metrics.recordMetrics(launch.id, source, { likes: 1 }, new Date());
    await registry.jobs.recordJob({ id: 'j1', queue: 'draft', title: 'Drafting', launchId: launch.id });
    await registry.jobs.updateJob('j1', { state: 'active', started: true });
    for (let i = 0; i < 10; i++) await registry.jobs.logJob('j1', `line ${i}`);
    await registry.jobs.updateJob('j1', { state: 'completed', ended: true });
    assert.equal(seen.length, 0, 'nothing yet: both kinds wait for their burst to settle');
    await flush();
    await tick();
    assert.deepEqual(
      seen.map((s) => [s.event, s.payload]),
      [
        ['job.changed', { id: 'j1', queue: 'draft', state: 'completed', launchId: launch.id }],
        ['metrics.changed', { launchId: launch.id }],
      ],
    );
  });
});

describe('the event stream', () => {
  async function hub(options: Partial<ConstructorParameters<typeof LiveHub>[0]> = {}) {
    const bus = new MemoryEventBus();
    const live = new LiveHub({ bus, boot: 'b00t', ...options });
    await live.start();
    const publish = <E extends EventName>(event: E, payload: ShipcastEvents[E]) => bus.publish(event, payload);
    return { bus, live, publish };
  }

  test('says it is an event stream no proxy may hold back, and delivers events with ids', async () => {
    const { live, publish } = await hub();
    const response = live.open(request(), 's1');
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.match(response.headers.get('cache-control') ?? '', /no-transform/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const stream = streamOf(response);
    await stream.until((t) => t.includes('retry: 3000'));
    await publish('job.changed', { id: 'j1', queue: 'draft', state: 'active', launchId: 12 });
    const text = await stream.until((t) => t.includes('event: job'));
    assert.match(text, /id: b00t\.1\nevent: job\ndata: \{"id":"j1","queue":"draft","state":"active","launchId":12\}\n\n/);
    await stream.cancel();
  });

  test('filters by topics: a kind whole, or one launch of a kind', async () => {
    const { live, publish } = await hub();
    const stream = streamOf(live.open(request('?topics=launch,job:12'), 's1'));
    await stream.until((t) => t.includes('retry'));
    await publish('job.changed', { id: 'other', queue: 'draft', state: 'active', launchId: 13 });
    await publish('post.changed', { postId: 1, launchId: 12 });
    await publish('launch.changed', { launchId: 99 });
    await publish('job.changed', { id: 'mine', queue: 'draft', state: 'active', launchId: 12 });
    const text = await stream.until((t) => t.includes('"mine"'));
    assert.deepEqual(kinds(text), ['launch', 'job']);
    assert.doesNotMatch(text, /"other"/);
    assert.equal(live.open(request('?topics=nonsense'), 's1').status, 400);
    assert.ok(parseTopics('job:12,launch')?.launches.get('job')?.has(12));
    await stream.cancel();
  });

  test('a reconnect with Last-Event-ID gets what it missed, and only that', async () => {
    const { live, publish } = await hub();
    const first = streamOf(live.open(request(), 's1'));
    await first.until((t) => t.includes('retry'));
    await publish('launch.changed', { launchId: 1 });
    const seen = await first.until((t) => t.includes('event: launch'));
    const last = ids(seen).at(-1)!;
    await first.cancel();
    await publish('launch.changed', { launchId: 2 });
    await publish('post.changed', { postId: 5, launchId: 3 });
    const again = streamOf(live.open(request('', { 'last-event-id': last }), 's1'));
    const text = await again.until((t) => t.includes('"postId":5'));
    assert.deepEqual(kinds(text), ['launch', 'post']);
    assert.match(text, /"launchId":2/);
    assert.doesNotMatch(text, /"launchId":1\b/);
    assert.doesNotMatch(text, /resync/);
    // ?last= does the same for a new EventSource, which cannot set the header
    const viaQuery = streamOf(live.open(request(`?last=${last}&topics=post`), 's1'));
    assert.deepEqual(kinds(await viaQuery.until((t) => t.includes('"postId":5'))), ['post']);
    await again.cancel();
    await viaQuery.cancel();
  });

  test('a gap the ring cannot cover, another process’s id or a bus reconnect is one resync', async () => {
    const { live, publish } = await hub({ ringSize: 2 });
    for (let i = 1; i <= 5; i++) await publish('launch.changed', { launchId: i });
    const old = streamOf(live.open(request('', { 'last-event-id': 'b00t.1' }), 's1'));
    const text = await old.until((t) => t.includes('event: resync'));
    assert.deepEqual(kinds(text), ['resync']);
    assert.match(text, /id: b00t\.5\nevent: resync/);
    const foreign = streamOf(live.open(request('', { 'last-event-id': 'cafe.3' }), 's1'));
    assert.deepEqual(kinds(await foreign.until((t) => t.includes('resync'))), ['resync']);
    // Within the ring: replayed, no resync
    const recent = streamOf(live.open(request('', { 'last-event-id': 'b00t.4' }), 's1'));
    assert.deepEqual(kinds(await recent.until((t) => t.includes('"launchId":5'))), ['launch']);
    live.gap();
    await recent.until((t) => t.includes('resync'));
    await Promise.all([old.cancel(), foreign.cancel(), recent.cancel()]);
  });

  test('a heartbeat comment keeps an idle stream alive', async () => {
    const { live } = await hub({ heartbeatMs: 20 });
    const stream = streamOf(live.open(request(), 's1'));
    const text = await stream.until((t) => (t.match(/^: hb$/gm) ?? []).length >= 2);
    assert.deepEqual(kinds(text), [], 'a heartbeat is a comment, no event a page reacts to');
    await stream.cancel();
  });

  test('caps the streams of one session, and lets go of one whose client left', async () => {
    const { live } = await hub({ maxPerSession: 2 });
    const left = new AbortController();
    const a = streamOf(live.open(request('', {}, left.signal), 's1'));
    const b = streamOf(live.open(request(), 's1'));
    assert.equal(live.open(request(), 's1').status, 429);
    assert.equal(live.open(request(), 's2').status, 200, 'another session has its own');
    assert.equal(live.connections, 3);
    left.abort();
    await a.until(() => false, 50).catch(() => undefined);
    assert.equal(live.connections, 2);
    assert.equal(live.open(request(), 's1').status, 200, 'the freed slot is taken again');
    await b.cancel();
  });

  test('the drain closes every stream and takes no new one', async () => {
    const { live, publish } = await hub();
    const stream = streamOf(live.open(request(), 's1'));
    await stream.until((t) => t.includes('retry'));
    await live.drain();
    await stream.until(() => stream.ended).catch(() => undefined);
    assert.equal(stream.ended, true);
    assert.equal(live.connections, 0);
    assert.equal(live.open(request(), 's1').status, 503);
    // Unsubscribed: what the bus says now reaches no stream and no ring
    await publish('launch.changed', { launchId: 1 });
    assert.equal(live.lastId, 'b00t.0');
  });
});

describe('across processes, through Redis', { skip: redisSkip }, () => {
  test("a job's end in a worker reaches a tab's stream on a web process", async () => {
    const redis = testRedis();
    // Two processes: each its own Redis clients and its own bus
    const workerBus = new RedisEventBus(redis.client('cache'), { prefix: redis.prefix });
    const webBus = new RedisEventBus(redis.client('cache'), { prefix: redis.prefix });
    try {
      const live = new LiveHub({ bus: webBus, boot: 'web1' });
      await live.start();
      const base = await memoryRegistry();
      const { registry, flush } = withEvents(base, workerBus);
      const { launch } = await base.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
      const tab = streamOf(live.open(request(`?topics=job:${launch.id}`), 's1'));
      await tab.until((t) => t.includes('retry'));
      // As the queue sent it: the row knows its launch, then the worker runs it through the shared wrapper
      await registry.jobs.recordJob({ id: 'draft-1', queue: 'draft', title: 'Drafting', launchId: launch.id });
      await runJob(registry, undefined, { id: 'draft-1', queue: 'draft', data: { launchId: launch.id }, attempt: 1, lastAttempt: true, readyAt: Date.now(), signal: new AbortController().signal }, async (_data, job) => {
        job.log('Drafting');
      });
      await flush();
      const text = await tab.until((t) => t.includes('"state":"completed"'), 5000);
      assert.match(text, new RegExp(`event: job\\ndata: \\{"id":"draft-1","queue":"draft","state":"completed","launchId":${launch.id}\\}`));
      await tab.cancel();
      await live.drain();
    } finally {
      await workerBus.close();
      await webBus.close();
      await redis.cleanup();
    }
  });
});
