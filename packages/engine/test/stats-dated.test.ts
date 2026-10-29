import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statsAverages, statsOverview, statsRanking, statsSeries, statsWindow, type PostKind, type Repositories } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const at = (day: string, hour = 6) => new Date(`2026-10-${day}T${String(hour).padStart(2, '0')}:00:00Z`);

async function launch(registry: Repositories, repo = 'yeyo11/claudio', ref = 'v1.0.0') {
  const { launch } = await registry.launches.claim({ repo, ref, trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  return launch;
}

async function piece(registry: Repositories, launchId: number, channel: 'bluesky' | 'instagram' | 'youtube' | 'devto', kind: PostKind = 'post') {
  return (await registry.posts.recordPost({ launchId, channel, kind, accountId: null, externalId: `${channel}-${launchId}-${kind}`, url: `https://${channel}.example/${launchId}/${kind}` })).post;
}

test('a day read again takes its new value; the days of a launch come back oldest first', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  assert.equal(await registry.metrics.recordDays(l.id, 'search', { '2026-10-19': { clicks: 2, impressions: 40 }, '2026-10-18': { clicks: 1 } }, at('20')), 3);
  await registry.metrics.recordDays(l.id, 'search', { '2026-10-19': { clicks: 3 } }, at('21'));
  assert.deepEqual(
    (await registry.metrics.metricDays(l.id, 'search')).map((d) => [d.day, d.name, d.value, d.readAt]),
    [
      ['2026-10-18', 'clicks', 1, at('20').toISOString()],
      ['2026-10-19', 'clicks', 3, at('21').toISOString()],
      ['2026-10-19', 'impressions', 40, at('20').toISOString()],
    ],
  );
  assert.equal(await registry.metrics.recordDays(l.id, 'search', { '2026-10-19': { clicks: Number.NaN } }, at('22')), 0);
});

test('a dated source counts its days in the period, wherever its readings were taken, and its lifetime is every day up to the end', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  // The since-launch total read on the 25th holds clicks from the 18th, 19th and 22nd: the stats place them on those days
  await registry.metrics.recordMetrics(l.id, 'search', { clicks: 15, impressions: 300 }, at('25'));
  await registry.metrics.recordDays(l.id, 'search', { '2026-10-18': { clicks: 5, impressions: 100 }, '2026-10-19': { clicks: 7, impressions: 120 }, '2026-10-22': { clicks: 3, impressions: 80 } }, at('25'));

  const overview = await statsOverview(registry, { from: '2026-10-18', to: '2026-10-19', compareTo: 'previous' });
  const search = overview.channels.find((c) => c.channel === 'search');
  assert.deepEqual(search?.metrics, { clicks: 12, impressions: 220 }, 'read on the 25th, counted on the 18th and 19th');
  assert.deepEqual(search?.lifetime, { clicks: 12, impressions: 220 }, 'every day up to the period’s end');
  assert.deepEqual(search?.previous, { clicks: 0, impressions: 0 });

  const series = await statsSeries(registry, { metric: 'clicks', groupBy: 'channel', from: '2026-10-19', to: '2026-10-22', bucket: 'day' });
  assert.deepEqual(
    series.groups[0]?.points.map((p) => [p.bucket, p.increase, p.cumulative]),
    [['2026-10-19', 7, 12], ['2026-10-20', 0, 12], ['2026-10-21', 0, 12], ['2026-10-22', 3, 15]],
    'the 18th is where it stood when the period began',
  );
  assert.equal(series.groups[0]?.baseline, 5);

  // A launch whose source kept no days yet is read as a counter, as before
  const old = await launch(registry, 'yeyo11/shipcast', 'v0.1.0');
  await registry.metrics.recordMetrics(old.id, 'search', { clicks: 4 }, at('10'));
  await registry.metrics.recordMetrics(old.id, 'search', { clicks: 9 }, at('19'));
  const both = await statsOverview(registry, { from: '2026-10-18', to: '2026-10-19', launches: [old.id] });
  assert.deepEqual(both.channels[0]?.metrics, { clicks: 5, impressions: 0 });
  assert.deepEqual(both.channels[0]?.lifetime, { clicks: 9, impressions: 0 });
});

test('a repo’s traffic counts from its days only, each day once whatever number of launches keeps it', async () => {
  const registry = await memoryRegistry();
  const v1 = await launch(registry, 'yeyo11/claudio', 'v1.0.0');
  const v2 = await launch(registry, 'yeyo11/claudio', 'v2.0.0');
  for (const l of [v1, v2]) {
    // The rolling 14-day count is no counter: never read as one
    await registry.metrics.recordMetrics(l.id, 'github', { stars: 10, views: 70 }, at('20'));
    await registry.metrics.recordDays(l.id, 'github', { '2026-10-19': { views: 30, clones: 2, visitors: 9 }, '2026-10-20': { views: 40, clones: 0, visitors: 12 } }, at('20'));
  }
  const overview = await statsOverview(registry, { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(overview.channels.find((c) => c.channel === 'github')?.metrics, { reactions: 0, shares: 0, views: 40, clones: 0 });
  assert.deepEqual(overview.channels.find((c) => c.channel === 'github')?.lifetime, { reactions: 10, shares: 0, views: 70, clones: 2 });

  const undated = await memoryRegistry();
  const l = await launch(undated);
  await undated.metrics.recordMetrics(l.id, 'github', { stars: 10, views: 70 }, at('20'));
  assert.deepEqual((await statsOverview(undated, { from: '2026-10-20', to: '2026-10-20' })).channels[0]?.metrics, { reactions: 0, shares: 0, views: 0, clones: 0 }, 'no days, no views: never the rolling count');
});

test('the lifetime stands beside the period: a post published before it shows only its growth in it, and all of it as lifetime', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  const post = await piece(registry, l.id, 'bluesky');
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 40 }, at('01'));
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 46 }, at('20'));
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 60 }, at('28'), post.id);

  const ranking = await statsRanking(registry, { by: 'post', from: '2026-10-15', to: '2026-10-25' });
  assert.deepEqual(ranking.entries.map((e) => [e.metrics.reactions, e.lifetime.reactions]), []);
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 41 }, at('02'), post.id);
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 47 }, at('20'), post.id);
  const ranked = await statsRanking(registry, { by: 'post', from: '2026-10-15', to: '2026-10-25' });
  assert.deepEqual(ranked.entries.map((e) => [e.metrics.reactions, e.lifetime.reactions]), [[6, 47]], 'a reading after the period is not its lifetime');
  const overview = await statsOverview(registry, { from: '2026-10-15', to: '2026-10-25' });
  assert.deepEqual([overview.metrics.reactions, overview.lifetime.reactions], [6, 47]);
});

test('the second tier adds up like the first: saves across networks, a story’s navigation, YouTube’s watch time', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  const ig = await piece(registry, l.id, 'instagram');
  const story = await piece(registry, l.id, 'instagram', 'story');
  const sky = await piece(registry, l.id, 'bluesky');
  const video = await piece(registry, l.id, 'youtube', 'post:horizontal');
  await registry.metrics.recordMetrics(l.id, 'instagram', { likes: 5, saved: 3, reach: 80 }, at('20'), ig.id);
  await registry.metrics.recordMetrics(l.id, 'instagram', { views: 30, taps_forward: 12, taps_back: 2, exits: 4, swipes_forward: 1 }, at('20'), story.id);
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 2, saves: 4 }, at('20'), sky.id);
  await registry.metrics.recordMetrics(l.id, 'youtube', { views: 90, watchMinutes: 45, engagedViews: 70, subscribersGained: 2 }, at('20'), video.id);

  const overview = await statsOverview(registry, { from: '2026-10-20', to: '2026-10-20' });
  assert.equal(overview.metrics.saves, 7);
  assert.equal(overview.metrics.navigation, 19);
  assert.equal(overview.metrics.reach, 80, 'reach is its own family, never impressions');
  assert.equal(overview.metrics.impressions, undefined);
  assert.deepEqual([overview.metrics.watchMinutes, overview.metrics.engagedViews, overview.metrics.follows], [45, 70, 2]);
  const ranking = await statsRanking(registry, { by: 'post', from: '2026-10-20', to: '2026-10-20' });
  assert.equal(ranking.entries.find((e) => e.postId === sky.id)?.score, 1, 'the second tier never enters the score');
});

test('an average is where its pieces stood at the period’s end, their mean, never their growth', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  // YouTube's videos are `post:<format>`: its own pieces, counted as a post is
  const [a, b] = [await piece(registry, l.id, 'youtube', 'post:horizontal'), await piece(registry, l.id, 'youtube', 'post:short')];
  await registry.metrics.recordMetrics(l.id, 'youtube', { avgViewSeconds: 20 }, at('10'), a.id);
  await registry.metrics.recordMetrics(l.id, 'youtube', { avgViewSeconds: 30 }, at('18'), a.id);
  await registry.metrics.recordMetrics(l.id, 'youtube', { avgViewSeconds: 50, avgViewPercent: 40 }, at('19'), b.id);
  await registry.metrics.recordMetrics(l.id, 'youtube', { avgViewSeconds: 90 }, at('25'), b.id);
  await registry.metrics.recordMetrics(l.id, 'youtube', { avgViewSeconds: 30 }, at('25'), a.id);
  await registry.metrics.recordMetrics(l.id, 'search', { ctr: 0.05, position: 7.5 }, at('19'));

  const averages = await statsAverages(registry, statsWindow('2026-10-15', '2026-10-20'), {});
  assert.deepEqual(averages, [
    { source: 'youtube', metric: 'avgViewSeconds', value: 40, pieces: 2 },
    { source: 'youtube', metric: 'avgViewPercent', value: 40, pieces: 1 },
    { source: 'search', metric: 'ctr', value: 0.05, pieces: 1 },
    { source: 'search', metric: 'position', value: 7.5, pieces: 1 },
  ]);
  assert.deepEqual((await statsOverview(registry, { from: '2026-10-15', to: '2026-10-20', channels: ['search'] })).averages.map((x) => x.metric), ['ctr', 'position']);
  // And a launch's latest numbers average them across its pieces rather than adding them up
  assert.equal((await registry.metrics.latestMetrics(l.id)).find((m) => m.name === 'avgViewSeconds')?.value, 60);
});
