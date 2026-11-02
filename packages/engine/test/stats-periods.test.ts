import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstReadingDay, STATS_METRICS, statsOverview, statsSeries, type PostKind, type Repositories, type StatsFilter } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

/*
 * A longer period never counts less than a shorter one it holds: "all" (from the first reading) ≥
 * 90 days ≥ 30 days ≥ 7 days, for every family and every filter, whatever the sources are like:
 * counters whose first reading falls inside a period, a counter that dips and climbs back, a repo
 * whose stars predate Shipcast, and sources kept per day.
 */

const TODAY = '2026-11-01';
const DAY_MS = 86_400_000;
const ago = (days: number, hour = 6) => new Date(Date.parse(`${TODAY}T${String(hour).padStart(2, '0')}:00:00Z`) - days * DAY_MS);
const dayAgo = (days: number) => ago(days).toISOString().slice(0, 10);

async function launch(registry: Repositories, ref: string) {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref, trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  return launch;
}

async function piece(registry: Repositories, launchId: number, channel: string, kind: PostKind = 'post') {
  return (await registry.posts.recordPost({ launchId, channel: channel as 'devto', kind, accountId: null, externalId: `${channel}-${launchId}-${kind}`, url: `https://${channel}.example/${launchId}/${kind}` })).post;
}

async function seed(registry: Repositories) {
  const a = await launch(registry, 'v0.8.0');
  const b = await launch(registry, 'v0.9.0');
  const read = async (launchId: number, source: string, postId: number | null, readings: ReadonlyArray<readonly [number, Record<string, number>]>) => {
    for (const [days, values] of readings) await registry.metrics.recordMetrics(launchId, source, values, ago(days), postId);
  };
  // dev.to: read since long before 90 days
  await read(a.id, 'devto', (await piece(registry, a.id, 'devto')).id, [[110, { views: 40, reactions: 1 }], [60, { views: 300, reactions: 4 }], [20, { views: 520, reactions: 6 }], [2, { views: 600, reactions: 7 }]]);
  // Bluesky: first read inside the last 30 days
  await read(b.id, 'bluesky', (await piece(registry, b.id, 'bluesky')).id, [[9, { likes: 3, replies: 1 }], [5, { likes: 10, replies: 2 }]]);
  // Instagram: views that dip (Meta recounting) and climb back past where they were
  await read(a.id, 'instagram', (await piece(registry, a.id, 'instagram')).id, [[40, { views: 100 }], [20, { views: 80 }], [5, { views: 90 }], [1, { views: 130 }]]);
  // Threads: first read 8 days ago, just before the last 7 days
  await read(b.id, 'threads', (await piece(registry, b.id, 'threads')).id, [[8, { views: 50, likes: 2 }], [3, { views: 70, likes: 4 }]]);
  // YouTube: one video
  await read(a.id, 'youtube', (await piece(registry, a.id, 'youtube', 'post:horizontal')).id, [[45, { views: 200, likes: 5 }], [10, { views: 260, likes: 9 }]]);
  // The blog: one launch kept per day (the earliest numbers of all), another read only as a counter
  const blogDays: Record<string, Record<string, number>> = {};
  for (const days of [115, 100, 80, 50, 31, 29, 12, 6, 0]) blogDays[dayAgo(days)] = { views: days + 1, visits: 1 };
  await registry.metrics.recordDays(a.id, 'blog', blogDays, ago(0));
  await read(b.id, 'blog', null, [[12, { views: 30 }], [4, { views: 45 }]]);
  // GitHub: stars from before Shipcast, an unstar, and its views from their days
  await read(b.id, 'github', null, [[70, { stars: 120, forks: 3 }], [25, { stars: 130, forks: 4 }], [6, { stars: 128, forks: 4 }], [1, { stars: 135, forks: 5 }]]);
  await registry.metrics.recordDays(b.id, 'github', { [dayAgo(13)]: { views: 8 }, [dayAgo(3)]: { views: 5 } }, ago(1));
  // Search Console, per day
  await registry.metrics.recordDays(a.id, 'search', { [dayAgo(70)]: { clicks: 2, impressions: 30 }, [dayAgo(4)]: { clicks: 1, impressions: 9 } }, ago(1));
  return { a, b, blogDays };
}

const periods = (first: string) => [
  { name: '7d', from: dayAgo(6) },
  { name: '30d', from: dayAgo(29) },
  { name: '90d', from: dayAgo(89) },
  { name: 'all', from: first },
];

test('"all" starts on the first reading: the earliest reading or the earliest day a source kept', async () => {
  const registry = await memoryRegistry();
  assert.equal(await firstReadingDay(registry), null, 'nothing read yet');
  const l = await launch(registry, 'v1.0.0');
  await registry.metrics.recordMetrics(l.id, 'blog', { views: 3 }, ago(20));
  assert.equal(await firstReadingDay(registry), dayAgo(20));
  await registry.metrics.recordDays(l.id, 'blog', { [dayAgo(30)]: { views: 1 } }, ago(20));
  assert.equal(await firstReadingDay(registry), dayAgo(30), 'a day kept before the first reading was taken');
  // A repo's stars per day go back to its creation: the stats do not read them, so they do not stretch "all"
  await registry.metrics.recordDays(l.id, 'github', { '2019-01-01': { stars: 1 } }, ago(20));
  assert.equal(await firstReadingDay(registry), dayAgo(30));
});

test('a longer period never counts less than a shorter one, for every family and filter', async () => {
  const registry = await memoryRegistry();
  const { a, b } = await seed(registry);
  const first = await firstReadingDay(registry);
  assert.equal(first, dayAgo(115));
  const filters: Array<[string, StatsFilter]> = [
    ['everything', {}],
    ...['devto', 'bluesky', 'instagram', 'threads', 'youtube', 'blog', 'github', 'search'].map((c): [string, StatsFilter] => [c, { channels: [c] }]),
    ['launch a', { launches: [a.id] }],
    ['launch b', { launches: [b.id] }],
  ];
  for (const [label, filter] of filters) {
    const totals = await Promise.all(periods(first!).map((p) => statsOverview(registry, { from: p.from, to: TODAY, ...filter })));
    for (const family of STATS_METRICS) {
      const values = totals.map((t) => t.metrics[family] ?? 0);
      for (let i = 1; i < values.length; i++) {
        assert.ok(values[i]! >= values[i - 1]!, `${label}, ${family}: ${periods(first!)[i]!.name} (${values[i]}) < ${periods(first!)[i - 1]!.name} (${values[i - 1]})`);
      }
    }
  }
});

test('"all" counts every reading, and its chart in weeks adds up to it', async () => {
  const registry = await memoryRegistry();
  const { blogDays } = await seed(registry);
  const first = (await firstReadingDay(registry))!;
  const all = await statsOverview(registry, { from: first, to: TODAY });
  const blog = Object.values(blogDays).reduce((n, d) => n + (d.views ?? 0), 0);
  // Each piece from zero to its highest; the repo's views are its days; the counter-read blog launch its highest
  assert.equal(all.metrics.views, 600 + 130 + 70 + 260 + blog + 45 + 13);
  assert.equal(all.channels.find((c) => c.channel === 'github')?.metrics.reactions, 15, 'the stars Shipcast saw arrive, not those from before it');
  assert.equal(all.channels.find((c) => c.channel === 'instagram')?.metrics.views, 130, 'the dip took nothing away');

  // A cumulative counter whose first reading is inside the period counts it whole, wherever the period starts before it
  const ninety = await statsOverview(registry, { from: dayAgo(89), to: TODAY, channels: ['devto'] });
  assert.equal(ninety.metrics.views, 600 - 40, 'dev.to was read before the 90 days: they start at that reading');
  const thirty = await statsOverview(registry, { from: dayAgo(29), to: TODAY, channels: ['bluesky'] });
  assert.equal(thirty.metrics.reactions, 10, 'Bluesky was first read inside the 30 days: from zero');

  for (const bucket of ['week', 'day'] as const) {
    const series = await statsSeries(registry, { metric: 'views', groupBy: 'channel', from: first, to: TODAY, bucket, limit: 50 });
    const charted = series.groups.reduce((n, g) => n + g.points.reduce((m, p) => m + p.increase, 0), 0);
    assert.equal(charted, all.metrics.views, `the ${bucket}s keep every reading`);
  }
});

test('periods side by side add up to the period they make, even across a dip', async () => {
  const registry = await memoryRegistry();
  await seed(registry);
  const instagram = { channels: ['instagram'] };
  const whole = await statsOverview(registry, { from: dayAgo(29), to: TODAY, ...instagram });
  const before = await statsOverview(registry, { from: dayAgo(29), to: dayAgo(7), ...instagram });
  const last = await statsOverview(registry, { from: dayAgo(6), to: TODAY, ...instagram });
  assert.equal(whole.metrics.views, 30, 'from its highest before the 30 days (100) to 130');
  assert.equal(before.metrics.views, 0, 'down to 80 and back to 90: nothing above where it had been');
  assert.equal(last.metrics.views, 30, 'climbing back to 100 is not growth: only what passed it');
  const series = await statsSeries(registry, { metric: 'views', groupBy: 'channel', from: dayAgo(6), to: TODAY, bucket: 'day', ...instagram });
  assert.equal(series.groups[0]?.baseline, 100, 'the series starts at the same place');
  assert.equal(series.groups[0]?.total, 30);
});
