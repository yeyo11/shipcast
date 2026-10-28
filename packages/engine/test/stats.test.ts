import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountGrowth, InvalidPeriod, statsOverview, statsRanking, statsSeries, statsWindow, type Registry } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const at = (day: string, hour = 6) => new Date(`2026-10-${day}T${String(hour).padStart(2, '0')}:00:00Z`);

async function launch(registry: Registry, repo = 'yeyo11/claudio', ref = 'v1.0.0') {
  const { launch } = await registry.launches.claim({ repo, ref, trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  return launch;
}

async function piece(registry: Registry, launchId: number, channel: 'devto' | 'bluesky' | 'mastodon' | 'newsletter', accountId: number | null, kind: 'post' | 'issue:en' = 'post') {
  return (await registry.posts.recordPost({ launchId, channel, kind, accountId, externalId: `${channel}-${launchId}-${kind}`, url: `https://${channel}.example/${launchId}` })).post;
}

test('a period is whole UTC days or timestamps, and nonsense is refused', () => {
  assert.deepEqual(statsWindow('2026-10-01', '2026-10-31'), { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(statsWindow('2026-10-01T12:00:00Z', '2026-10-02T00:00:00Z'), { from: '2026-10-01T12:00:00.000Z', to: '2026-10-02T00:00:00.000Z' });
  assert.throws(() => statsWindow('yesterday', '2026-10-02'), InvalidPeriod);
  assert.throws(() => statsWindow('2026-10-05', '2026-10-01'), InvalidPeriod);
});

test('cumulative readings become increases per bucket, carried over a missing day and never negative', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  const post = await piece(registry, l.id, 'bluesky', null);
  // Two rounds on the 20th, none on the 22nd, an unlike on the 23rd that the 24th passes again
  for (const [day, hour, likes] of [['20', 6, 4], ['20', 18, 10], ['21', 6, 15], ['23', 6, 12], ['24', 6, 18]] as const) {
    await registry.metrics.recordMetrics(l.id, 'bluesky', { likes, reposts: 1 }, at(day, hour), post.id);
  }

  const series = await statsSeries(registry, { metric: 'reactions', groupBy: 'channel', from: '2026-10-20', to: '2026-10-24', bucket: 'day' });
  assert.deepEqual(series.buckets, ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
  const [bluesky] = series.groups;
  assert.equal(bluesky?.key, 'bluesky');
  assert.deepEqual(
    bluesky?.points.map((p) => [p.increase, p.cumulative]),
    [[10, 10], [5, 15], [0, 15], [0, 15], [3, 18]],
    'the piece started at zero; the 22nd had no reading and the dip took nothing away',
  );
  assert.equal(bluesky?.total, 18);

  // A later period starts where the counter stood before it
  const later = await statsSeries(registry, { metric: 'reactions', groupBy: 'channel', from: '2026-10-21', to: '2026-10-24', bucket: 'day' });
  assert.equal(later.groups[0]?.baseline, 10);
  assert.deepEqual(later.groups[0]?.points.map((p) => p.increase), [5, 0, 0, 3]);
  assert.equal(later.groups[0]?.points.at(-1)?.cumulative, 18);

  // Weeks start on Monday; the 20th of October 2026 is a Tuesday
  const weekly = await statsSeries(registry, { metric: 'reactions', groupBy: 'channel', from: '2026-10-20', to: '2026-10-27', bucket: 'week' });
  assert.deepEqual(weekly.buckets, ['2026-10-19', '2026-10-26']);
  assert.deepEqual(weekly.groups[0]?.points.map((p) => p.increase), [18, 0]);

  // The overview agrees with the series' sum
  const overview = await statsOverview(registry, { from: '2026-10-21', to: '2026-10-24' });
  assert.equal(overview.channels.find((c) => c.channel === 'bluesky')?.metrics.reactions, 8);
  assert.equal(overview.channels.find((c) => c.channel === 'bluesky')?.metrics.shares, 0, 'reposts count as shares, and no growth is a zero');
});

test('popularity is normalised per network: two networks with very different scales rank sensibly', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  const l2 = await launch(registry, 'yeyo11/claudio', 'v1.1.0');
  const l3 = await launch(registry, 'yeyo11/claudio', 'v1.2.0');
  const devA = await piece(registry, l.id, 'devto', null);
  const devB = await piece(registry, l2.id, 'devto', null);
  const sky6 = await piece(registry, l.id, 'bluesky', null);
  const sky1 = await piece(registry, l2.id, 'bluesky', null);
  const sky2 = await piece(registry, l3.id, 'bluesky', null);
  await registry.metrics.recordMetrics(l.id, 'devto', { views: 1000, reactions: 20, comments: 0 }, at('20'), devA.id);
  await registry.metrics.recordMetrics(l2.id, 'devto', { views: 500, reactions: 10, comments: 0 }, at('20'), devB.id);
  await registry.metrics.recordMetrics(l.id, 'bluesky', { likes: 6, reposts: 0, replies: 0 }, at('20'), sky6.id);
  await registry.metrics.recordMetrics(l2.id, 'bluesky', { likes: 1, reposts: 0, replies: 0 }, at('20'), sky1.id);
  await registry.metrics.recordMetrics(l3.id, 'bluesky', { likes: 2, reposts: 0, replies: 0 }, at('20'), sky2.id);

  const ranking = await statsRanking(registry, { by: 'post', from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(
    ranking.entries.map((e) => e.postId),
    [sky6.id, devA.id, sky2.id, devB.id, sky1.id],
    'six likes where two is typical beats a thousand views where 750 is; raw numbers would put both dev.to posts first',
  );
  const [top, second] = ranking.entries;
  // bluesky: likes median 2, so (6 + 1) / (2 + 1); comments and shares nobody got are left out
  assert.ok(Math.abs((top?.score ?? 0) - 7 / 3) < 1e-9);
  // dev.to: the mean of views (1001 / 751) and reactions (21 / 16)
  assert.ok(Math.abs((second?.score ?? 0) - (1001 / 751 + 21 / 16) / 2) < 1e-9);
  assert.deepEqual(second?.metrics, { views: 1000, reactions: 20, comments: 0 }, 'the raw numbers come beside the score');
  assert.deepEqual(ranking.medians, { devto: { views: 750, reactions: 15 }, bluesky: { reactions: 2 } });
  assert.equal(ranking.entries.find((e) => e.postId === sky2.id)?.score, 1, 'the typical piece scores 1');
  assert.equal(top?.label, 'yeyo11/claudio v1.0.0');
  assert.equal(top?.url, `https://bluesky.example/${l.id}`);
  assert.equal(top?.kind, 'post');

  // Ascending, and paged
  const worst = await statsRanking(registry, { by: 'post', from: '2026-10-20', to: '2026-10-20', order: 'asc', limit: 2 });
  assert.deepEqual(worst.entries.map((e) => e.postId), [sky1.id, devB.id]);
  assert.equal(worst.total, 5);
  assert.equal(worst.next, 2);
  const page2 = await statsRanking(registry, { by: 'post', from: '2026-10-20', to: '2026-10-20', order: 'asc', limit: 2, offset: 2 });
  assert.deepEqual(page2.entries.map((e) => [e.rank, e.postId]), [[3, sky2.id], [4, devA.id]]);
  const last = await statsRanking(registry, { by: 'post', from: '2026-10-20', to: '2026-10-20', order: 'asc', limit: 2, offset: 4 });
  assert.equal(last.next, null);

  // Launches are ranked by the mean of their pieces' scores, with their raw sums
  const launches = await statsRanking(registry, { by: 'launch', from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(launches.entries.map((e) => e.launchId), [l.id, l3.id, l2.id]);
  assert.equal(launches.entries[0]?.pieces, 2);
  assert.equal(launches.entries[0]?.metrics.views, 1000);
  assert.equal(launches.entries[0]?.metrics.reactions, 26);
});

test('a network nobody engaged with has no yardstick and is not ranked', async () => {
  const registry = await memoryRegistry();
  const l = await launch(registry);
  const post = await piece(registry, l.id, 'mastodon', null);
  await registry.metrics.recordMetrics(l.id, 'mastodon', { favourites: 0, boosts: 0, replies: 0 }, at('20'), post.id);
  const ranking = await statsRanking(registry, { by: 'post', from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(ranking.entries, []);
});

test('the overview compares with the previous period, per channel and per account, and filters', async () => {
  const registry = await memoryRegistry();
  const devto = await registry.addAccount({ network: 'devto', brand: 'personal', label: '@me', settings: {} });
  const bluesky = await registry.addAccount({ network: 'bluesky', brand: 'personal', label: '@me.bsky.social', settings: {} });
  const l1 = await launch(registry);
  const l2 = await launch(registry, 'yeyo11/shipcast', 'v0.1.0');
  const dev = await piece(registry, l1.id, 'devto', devto.id);
  const sky = await piece(registry, l2.id, 'bluesky', bluesky.id);
  // The 10th to the 14th is the previous period of the 15th to the 19th
  await registry.metrics.recordMetrics(l1.id, 'devto', { views: 100, reactions: 2, comments: 0 }, at('12'), dev.id);
  await registry.metrics.recordMetrics(l1.id, 'devto', { views: 400, reactions: 5, comments: 1 }, at('17'), dev.id);
  await registry.metrics.recordMetrics(l2.id, 'bluesky', { likes: 3 }, at('16'), sky.id);
  await registry.metrics.recordMetrics(l1.id, 'blog', { views: 40 }, at('13'));
  await registry.metrics.recordMetrics(l1.id, 'blog', { views: 90 }, at('18'));

  const overview = await statsOverview(registry, { from: '2026-10-15', to: '2026-10-19', compareTo: 'previous' });
  assert.deepEqual(overview.compareTo, { from: '2026-10-10T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z' });
  const devtoStats = overview.channels.find((c) => c.channel === 'devto');
  assert.deepEqual(devtoStats?.metrics, { views: 300, reactions: 3, comments: 1 });
  assert.deepEqual(devtoStats?.previous, { views: 100, reactions: 2, comments: 0 });
  assert.deepEqual(devtoStats?.delta?.views, { absolute: 200, relative: 2 });
  assert.deepEqual(devtoStats?.delta?.comments, { absolute: 1, relative: null }, 'from zero there is no ratio');
  assert.deepEqual(overview.channels.find((c) => c.channel === 'blog')?.metrics, { views: 50 });
  assert.equal(overview.metrics.views, 350, 'dev.to and the blog');
  assert.deepEqual(
    overview.accounts.map((a) => [a.network, a.label, a.metrics.reactions]),
    [['bluesky', '@me.bsky.social', 3], ['devto', '@me', 3]],
    'the blog has no account, so it is in no account’s numbers',
  );

  const onlyBluesky = await statsOverview(registry, { from: '2026-10-15', to: '2026-10-19', channels: ['bluesky'] });
  assert.deepEqual(onlyBluesky.channels.map((c) => c.channel), ['bluesky']);
  const byAccount = await statsOverview(registry, { from: '2026-10-15', to: '2026-10-19', accounts: [devto.id] });
  assert.deepEqual(byAccount.channels.map((c) => c.channel), ['devto'], 'an account filter leaves the site-level numbers out');
  const byLaunch = await statsOverview(registry, { from: '2026-10-15', to: '2026-10-19', launches: [l1.id] });
  assert.deepEqual(byLaunch.channels.map((c) => c.channel), ['blog', 'devto']);
  const nothing = await statsOverview(registry, { from: '2026-10-15', to: '2026-10-19', launches: [] });
  assert.deepEqual(nothing.channels, []);
});

test('GitHub counts once per repo and starts at its first reading; old launch-wide newsletter readings are not counted twice', async () => {
  const registry = await memoryRegistry();
  const v1 = await launch(registry, 'yeyo11/claudio', 'v1.0.0');
  const v2 = await launch(registry, 'yeyo11/claudio', 'v2.0.0');
  // Both launches read the same repo at the same moments
  for (const l of [v1, v2]) {
    await registry.metrics.recordMetrics(l.id, 'github', { stars: 120, forks: 9 }, at('20'));
    await registry.metrics.recordMetrics(l.id, 'github', { stars: 130, forks: 9 }, at('21'));
  }
  const overview = await statsOverview(registry, { from: '2026-10-20', to: '2026-10-21' });
  assert.deepEqual(overview.channels.find((c) => c.channel === 'github')?.metrics, { reactions: 10, shares: 0 }, 'the stars it had before are not growth');
  const series = await statsSeries(registry, { metric: 'reactions', groupBy: 'launch', from: '2026-10-20', to: '2026-10-21', bucket: 'day' });
  assert.deepEqual(series.groups.map((g) => [g.label, g.baseline, g.total]), [['yeyo11/claudio v2.0.0', 120, 10]], 'attributed to the newest launch of the repo');

  // A newsletter launch from before readings pointed at their piece: the sum of both issues, then each issue
  const issueEn = await piece(registry, v1.id, 'newsletter', null, 'issue:en');
  await registry.metrics.recordMetrics(v1.id, 'newsletter', { opens: 7 }, at('20'));
  await registry.metrics.recordMetrics(v1.id, 'newsletter', { opens: 8 }, at('21'), issueEn.id);
  const news = await statsOverview(registry, { from: '2026-10-20', to: '2026-10-21', channels: ['newsletter'] });
  assert.deepEqual(news.channels[0]?.metrics, { views: 8, clicks: 0, impressions: 0 });
});

test('a series groups by account and launch with labels, and folds what passes the limit into other', async () => {
  const registry = await memoryRegistry();
  const account = await registry.addAccount({ network: 'mastodon', brand: 'personal', label: '@me@mastodon.social', settings: {} });
  const launches = [await launch(registry, 'yeyo11/a', 'v1'), await launch(registry, 'yeyo11/b', 'v1'), await launch(registry, 'yeyo11/c', 'v1')];
  for (const [i, l] of launches.entries()) {
    const post = await piece(registry, l.id, 'mastodon', i === 0 ? account.id : null);
    await registry.metrics.recordMetrics(l.id, 'mastodon', { favourites: (i + 1) * 10 }, at('20'), post.id);
  }
  const byLaunch = await statsSeries(registry, { metric: 'reactions', groupBy: 'launch', from: '2026-10-20', to: '2026-10-20', bucket: 'day', limit: 2 });
  assert.deepEqual(byLaunch.groups.map((g) => [g.label, g.total]), [['yeyo11/c v1', 30], ['yeyo11/b v1', 20]]);
  assert.equal(byLaunch.other?.groups, 1);
  assert.equal(byLaunch.other?.total, 10);

  const byAccount = await statsSeries(registry, { metric: 'reactions', groupBy: 'account', from: '2026-10-20', to: '2026-10-20', bucket: 'day' });
  assert.deepEqual(byAccount.groups.map((g) => [g.key, g.label, g.total]), [['none', 'No account', 50], [String(account.id), 'mastodon @me@mastodon.social', 10]]);

  const byLaunchChannel = await statsSeries(registry, { metric: 'reactions', groupBy: 'launchChannel', from: '2026-10-20', to: '2026-10-20', bucket: 'day', limit: 2 });
  assert.match(byLaunchChannel.groups[0]?.key ?? '', /^\d+:mastodon$/, 'each launch and channel apart, keyed launch:channel');
  assert.equal(byLaunchChannel.groups[0]?.total, 30);

  await assert.rejects(statsSeries(registry, { metric: 'reactions', groupBy: 'launch', from: '2020-01-01', to: '2026-10-20', bucket: 'day' }), InvalidPeriod);
});

test('an account’s growth comes from its snapshots, with the change since the one before, across a missed day', async () => {
  const registry = await memoryRegistry();
  const a = await registry.addAccount({ network: 'bluesky', brand: 'personal', label: '@me', settings: {} });
  await registry.recordSnapshot(a.id, { followers: 10, following: 5, posts: 1 }, at('19', 4));
  await registry.recordSnapshot(a.id, { followers: 12, following: 5, posts: 2 }, at('20', 4));
  await registry.recordSnapshot(a.id, { followers: 20, posts: 2 }, at('23', 4));

  const growth = await accountGrowth(registry, a.id, { from: '2026-10-20', to: '2026-10-31' });
  assert.deepEqual(
    growth.points.map((p) => [p.day, p.followers, p.change.followers, p.change.following, p.days]),
    [['2026-10-20', 12, 2, 0, 1], ['2026-10-23', 20, 8, null, 3]],
    'the first day of the period still has its change; following stopped being counted',
  );
  assert.deepEqual(growth.change, { followers: 10, following: null, posts: 1 });
  assert.deepEqual((await accountGrowth(registry, a.id, { from: '2026-11-01', to: '2026-11-30' })).points, []);
  await assert.rejects(accountGrowth(registry, a.id, { from: '2026-10-20', to: 'later' }), InvalidPeriod);
});
