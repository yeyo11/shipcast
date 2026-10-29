import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bucketBound, bucketOf, merge, observe, percentile, runChecks, TelemetryStore, type Histogram } from '../src/index.ts';
import { memoryRegistry as memory } from '../src/testing.ts';

test('a histogram bucket is 25 % wide, and a percentile never understates', () => {
  assert.equal(bucketOf(0), 0);
  assert.equal(bucketOf(1), 0);
  for (const ms of [2, 37, 150, 4_700, 39_400]) {
    const bound = bucketBound(bucketOf(ms));
    assert.ok(bound >= ms && bound < ms * 1.25 + 1e-9, `${ms} ms falls under ${bound}`);
  }
  const h: Histogram = {};
  for (let i = 1; i <= 100; i++) observe(h, i * 10);
  const p95 = percentile(h, 0.95)!;
  assert.ok(p95 >= 950 && p95 < 950 * 1.25, `p95 ${p95}`);
  assert.equal(percentile({}, 0.5), undefined);
});

test('histograms of two processes add up', () => {
  const a: Histogram = {};
  const b: Histogram = {};
  observe(a, 100);
  observe(b, 100);
  observe(b, 5_000);
  const both = merge(a, b);
  assert.equal(Object.values(both).reduce((s, n) => s + n, 0), 3);
  assert.equal(both[String(bucketOf(100))], 2);
});

test('two flushes into the same hour add their counts and histograms', async () => {
  const registry = await memory();
  const store = new TelemetryStore(registry.database);
  const hour = '2026-10-28T14:00:00.000Z';
  const row = { hour, process: 'web', origin: 'fn:getLaunch', provider: 'github', method: 'GET', endpoint: '/repos/:owner/:repo/pulls/:n', status: 200, calls: 2, totalMs: 300, bytes: 1000, latency: { '22': 2 } };
  await store.addCalls([row]);
  await store.addCalls([{ ...row, calls: 1, totalMs: 50, bytes: 10, latency: { '22': 1, '18': 1 }, quotaPeak: 0.4, quotaLimit: 5000 }]);
  const [stored] = await store.calls({ from: hour, to: '2026-10-28T15:00:00.000Z' });
  assert.equal(stored?.calls, 3);
  assert.equal(stored?.totalMs, 350);
  assert.equal(stored?.bytes, 1010);
  assert.deepEqual(stored?.latency, { '22': 3, '18': 1 });
  assert.equal(stored?.quotaPeak, 0.4);
  assert.equal(stored?.quotaLimit, 5000);

  const timing = { hour, process: 'web', kind: 'fn' as const, name: 'getLaunch', outcome: 'ok' as const, count: 1, totalMs: 4700, maxMs: 4700, latency: { '38': 1 } };
  await store.addTimings([timing]);
  await store.addTimings([{ ...timing, totalMs: 100, maxMs: 100, latency: { '21': 1 } }]);
  const [t] = await store.timings({ from: hour, to: '2026-10-28T15:00:00.000Z' });
  assert.equal(t?.count, 2);
  assert.equal(t?.maxMs, 4700);
  assert.deepEqual(t?.latency, { '38': 1, '21': 1 });
});

test('the checks find a missed schedule, a late post and a duplicate, and measure freshness', async () => {
  const registry = await memory();
  const store = new TelemetryStore(registry.database);
  const now = new Date();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v0.2.0', trigger: 'release', kind: 'major', brand: 'personal' });
  // Still waiting an hour after its time: missed
  await registry.posts.schedulePost(launch.id, 'mastodon', new Date(now.getTime() - 3_600_000));
  // A live piece read two hours ago, and one never read (another launch's, so it is no duplicate)
  const { post: read } = await registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', externalId: 'at://1', url: 'https://bsky.app/1' });
  await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes: 3 }, new Date(now.getTime() - 2 * 3_600_000), read.id);
  const other = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v0.1.0', trigger: 'release', kind: 'major', brand: 'personal' });
  await registry.posts.recordPost({ launchId: other.launch.id, channel: 'bluesky', externalId: 'at://2', url: 'https://bsky.app/2' });

  const results = await runChecks(registry, store, { now, cadenceHours: 6 });
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(byName['missed-schedules']?.ok, false);
  assert.equal(byName['missed-schedules']?.value, 1);
  assert.equal(byName['late-posts']?.ok, true);
  assert.equal(byName['duplicate-pieces']?.ok, true);
  const fresh = byName.freshness!;
  assert.equal(fresh.value, 0.5, 'one of the two bluesky pieces was read within the cadence');
  assert.equal((fresh.detail as { within1hShare: number }).within1hShare, 0);

  const stored = await store.checks({ from: new Date(now.getTime() - 60_000).toISOString(), to: new Date(now.getTime() + 60_000).toISOString() });
  assert.equal(stored.length, 4);
});

interface Freshness {
  within1hShare: number;
  posts: number;
  channels: Record<string, { posts: number; neverRead: number; within1h: number }>;
}

test('characterisation: freshness counts every read piece, and a readable one never read against it', async () => {
  const registry = await memory();
  const store = new TelemetryStore(registry.database);
  const now = new Date();
  const a = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v1', trigger: 'release', kind: 'major', brand: 'personal' });
  const b = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v2', trigger: 'release', kind: 'major', brand: 'personal' });
  const { post: read } = await registry.posts.recordPost({ launchId: a.launch.id, channel: 'bluesky', externalId: 'at://1', url: 'https://bsky.app/1' });
  await registry.metrics.recordMetrics(a.launch.id, 'bluesky', { likes: 3 }, new Date(now.getTime() - 10 * 60_000), read.id);
  await registry.posts.recordPost({ launchId: b.launch.id, channel: 'bluesky', externalId: 'at://2', url: 'https://bsky.app/2' });
  // A channel nothing was ever read on is left out, not stale
  await registry.posts.recordPost({ launchId: a.launch.id, channel: 'devto', externalId: '7', url: 'https://dev.to/7' });

  const fresh = (await runChecks(registry, store, { now, cadenceHours: 1 })).find((r) => r.name === 'freshness')!;
  const detail = fresh.detail as unknown as Freshness;
  assert.equal(fresh.value, 0.5);
  assert.equal(fresh.ok, false);
  assert.equal(detail.posts, 2);
  assert.equal(detail.within1hShare, 0.5);
  assert.deepEqual(Object.keys(detail.channels), ['bluesky']);
  assert.equal(detail.channels.bluesky?.neverRead, 1);
});

test('freshness leaves out the pieces their channel reads no numbers for (a story, a comment)', async () => {
  const registry = await memory();
  const store = new TelemetryStore(registry.database);
  const now = new Date();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v1', trigger: 'release', kind: 'major', brand: 'personal' });
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'instagram', externalId: 'ig-1', url: 'https://instagram.com/p/1' });
  await registry.metrics.recordMetrics(launch.id, 'instagram', { views: 40, likes: 3 }, new Date(now.getTime() - 10 * 60_000), post.id);
  // Instagram's story and the comment that carries the link: never read, as the metrics rounds never read them
  await registry.posts.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'story', externalId: 'ig-2', url: 'https://instagram.com/stories/2' });
  await registry.posts.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'comment', externalId: 'ig-3', url: 'https://instagram.com/p/1#c3' });
  // A post's own pieces count where the channel has numbers: each of YouTube's videos
  const { post: video } = await registry.posts.recordPost({ launchId: launch.id, channel: 'youtube', kind: 'post:short', externalId: 'yt-1', url: 'https://youtube.com/shorts/1' });
  await registry.metrics.recordMetrics(launch.id, 'youtube', { views: 9 }, new Date(now.getTime() - 5 * 60_000), video.id);
  await registry.posts.recordPost({ launchId: launch.id, channel: 'youtube', kind: 'post:long', externalId: 'yt-2', url: 'https://youtube.com/watch?v=2' });

  const fresh = (await runChecks(registry, store, { now, cadenceHours: 1 })).find((r) => r.name === 'freshness')!;
  const detail = fresh.detail as unknown as Freshness;
  assert.equal(detail.channels.instagram?.posts, 1);
  assert.equal(detail.channels.instagram?.neverRead, 0);
  assert.equal(detail.channels.youtube?.posts, 2);
  assert.equal(detail.channels.youtube?.neverRead, 1, 'a video never read is still stale');
  assert.equal(detail.posts, 3);
  assert.equal(fresh.value, 2 / 3);
});

test('two rows with one network id are a duplicate', async () => {
  const registry = await memory();
  const store = new TelemetryStore(registry.database);
  const a = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v1', trigger: 'release', kind: 'major', brand: 'personal' });
  const b = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref: 'v2', trigger: 'release', kind: 'major', brand: 'personal' });
  await registry.posts.recordPost({ launchId: a.launch.id, channel: 'devto', externalId: '42', url: 'https://dev.to/x' });
  await registry.posts.recordPost({ launchId: b.launch.id, channel: 'devto', externalId: '42', url: 'https://dev.to/x' });
  const results = await runChecks(registry, store, { cadenceHours: 6 });
  const duplicate = results.find((r) => r.name === 'duplicate-pieces')!;
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.value, 1);
});

test('the report reads each KPI from the stored hours and leaves the probe out', async () => {
  const { windowNumbers, compareReport } = await import('../src/index.ts');
  const range = { from: '2026-10-28T00:00:00.000Z', to: '2026-10-30T00:00:00.000Z' };
  const call = (over: Partial<import('../src/index.ts').CallCount>) => ({ hour: '2026-10-28T10:00:00.000Z', process: 'web', origin: 'fn:getLaunch', provider: 'github', method: 'GET', endpoint: '/x', status: 200, calls: 0, totalMs: 0, bytes: 0, latency: {}, ...over });
  const before = windowNumbers(
    range,
    [call({ calls: 180 }), call({ status: 304, calls: 20 }), call({ origin: 'probe', calls: 1000 }), call({ origin: 'job:metrics', provider: 'bluesky', calls: 40, quotaPeak: 0.3 })],
    [
      { hour: '2026-10-28T10:00:00.000Z', process: 'web', kind: 'fn', name: 'getLaunch', outcome: 'ok', count: 100, totalMs: 470_000, maxMs: 6000, latency: { '38': 100 } },
      { hour: '2026-10-28T11:00:00.000Z', process: 'web', kind: 'job', name: 'metrics', outcome: 'ok', count: 8, totalMs: 8 * 39_400, maxMs: 40_000, latency: { '48': 8 } },
    ],
    [],
  );
  assert.equal(before.callsPerDay, 120, '240 calls over two days, the probe left out');
  assert.equal(before.githubCallsPerDay, 100);
  assert.equal(before.github304Share, 0.1);
  assert.equal(before.callsPerFnRun.getLaunch, 2);
  assert.equal(before.jobs.metrics?.runsPerDay, 4);
  assert.equal(before.jobs.metrics?.callsPerRun, 5);
  assert.equal(before.peakQuota.bluesky, 0.3);
  const after = windowNumbers(range, [call({ status: 304, calls: 20 })], [], []);
  const report = compareReport(before, after);
  assert.match(report, /\| Total \| 120 \| 10 \| -91\.7 % \|/);
  assert.match(report, /getLaunch p95/);
});
