import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexStatusKey, type Registry } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { DEFAULTS, parseStatsInput } from '../src/server/stats-search.ts';
import { loadGrowth, loadSearch, loadStats, PAGE_SIZE, sortRanking } from '../src/server/stats.server.ts';

const at = (day: string, hour = 6) => new Date(`2026-10-${day}T${String(hour).padStart(2, '0')}:00:00Z`);
const TODAY = '2026-10-25';

async function seed(registry: Registry) {
  const account = await registry.accounts.addAccount({ network: 'bluesky', brand: 'personal', label: '@me', settings: {} });
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', kind: 'post', accountId: account.id, externalId: 'b1', url: 'https://bsky.example/1' });
  for (const [day, likes] of [['10', 2], ['15', 10], ['20', 30]] as const) await registry.metrics.recordMetrics(launch.id, 'bluesky', { likes, reposts: 1 }, at(day), post.id);
  await registry.accounts.recordSnapshot(account.id, { followers: 100, following: 10, posts: 3 }, at('18', 4));
  await registry.accounts.recordSnapshot(account.id, { followers: 112, following: 10, posts: 4 }, at('24', 4));
  return { account, launch };
}

test('the page reads its chart, totals, ranking and options from the registry', async () => {
  const registry = await memoryRegistry();
  const { account, launch } = await seed(registry);
  const view = await loadStats(registry, { ...DEFAULTS, metric: 'reactions' }, TODAY);

  assert.equal(view.period.days, 30);
  assert.equal(view.chart.buckets.length, 30);
  assert.equal(view.chart.groups.length, 1, 'channels that stayed at zero are left out');
  assert.equal(view.chart.groups[0]?.key, 'bluesky');
  assert.equal(view.chart.groups[0]?.label, 'Bluesky');
  assert.equal(view.chart.groups[0]?.total, 30);
  assert.equal(view.chart.groups[0]?.values.length, view.chart.buckets.length);
  assert.equal(view.chart.groups[0]?.comparison, null, 'no comparison unless asked');
  assert.equal(view.totals.previous, null);
  assert.equal(view.ranking.total, 1);
  assert.equal(view.ranking.entries[0]?.launchId, launch.id);
  assert.deepEqual(view.options.accounts, [{ value: String(account.id), label: '@me', hint: 'Bluesky', group: 'Bluesky' }]);
  assert.ok(view.options.channels.some((c) => c.value === 'bluesky'));
});

test('comparing lays the previous period over the same buckets and reports its totals', async () => {
  const registry = await memoryRegistry();
  await seed(registry);
  // 7 days ending the 25th: the 19th to the 25th; before it, the 12th to the 18th, where 8 likes arrived
  const view = await loadStats(registry, { ...DEFAULTS, period: '7d', metric: 'reactions', compare: true }, TODAY);
  assert.deepEqual(view.comparePeriod, { from: '2026-10-12', to: '2026-10-18' });
  const group = view.chart.groups[0];
  assert.equal(group?.comparison?.length, view.chart.buckets.length);
  assert.equal(group?.comparison?.reduce((a, b) => a + b, 0), 8);
  assert.equal(group?.total, 20);
  assert.equal(view.totals.previous?.reactions, 8);
});

test('filters narrow the view and a channel with nothing is an empty one', async () => {
  const registry = await memoryRegistry();
  const { account, launch } = await seed(registry);
  const mastodon = await loadStats(registry, { ...DEFAULTS, metric: 'reactions', channels: ['mastodon'] }, TODAY);
  assert.equal(mastodon.ranking.total, 0);
  assert.ok(mastodon.chart.groups.every((g) => g.total === 0));
  const mine = await loadStats(registry, { ...DEFAULTS, metric: 'reactions', groupBy: 'account', accounts: [account.id] }, TODAY);
  assert.equal(mine.chart.groups[0]?.id, account.id);
  assert.equal(mine.chart.groups[0]?.channel, 'bluesky');
  const other = await loadStats(registry, { ...DEFAULTS, metric: 'reactions', launches: [launch.id + 1] }, TODAY);
  assert.equal(other.ranking.total, 0, 'a launch filter leaves the other launches out');
  const one = await loadStats(registry, { ...DEFAULTS, metric: 'reactions', groupBy: 'launch', launches: [launch.id] }, TODAY);
  assert.equal(one.chart.groups[0]?.id, launch.id);
  assert.deepEqual(one.options.launches, [{ value: String(launch.id), label: 'yeyo11/claudio v1.0.0', hint: launch.createdAt.slice(0, 10), group: 'yeyo11/claudio' }]);
});

test('the ranking is sorted over every row, then paged', () => {
  const rows = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => ({ score: i, metrics: { views: i % 2 === 0 ? 100 : i } }));
  const byViews = sortRanking(rows, 'views', 'desc');
  assert.equal(byViews[0]?.metrics.views, 100);
  assert.equal(byViews[0]?.score, rows.length - 1 - ((rows.length - 1) % 2), 'equal views keep the popularity order');
  assert.equal(sortRanking(rows, 'score', 'asc')[0]?.score, 0);
  assert.equal(sortRanking([{ score: 1, metrics: {} }, { score: 2, metrics: { views: 0 } }], 'views', 'desc')[0]?.score, 2, 'a source that does not count a metric ranks below a zero');
});

test('growth lists the accounts with snapshots, their change and their freshness', async () => {
  const registry = await memoryRegistry();
  const { account } = await seed(registry);
  await registry.accounts.addAccount({ network: 'brevo', brand: 'personal', label: 'newsletter', settings: {} });
  const growth = await loadGrowth(registry, { from: '2026-10-01', to: '2026-10-25' }, new Date('2026-10-25T12:00:00Z'));
  assert.equal(growth.accounts.length, 1, 'an account with no snapshots has no growth to show');
  const [a] = growth.accounts;
  assert.equal(a?.id, account.id);
  assert.equal(a?.latest?.followers, 112);
  assert.equal(a?.change.followers, 12);
  assert.equal(a?.points.length, 2);
  assert.equal(a?.stale, false);
  assert.equal(a?.channel, 'bluesky');
});

test('a view the server function parsed always loads', async () => {
  const registry = await memoryRegistry();
  const view = await loadStats(registry, parseStatsInput({ period: 'custom', from: '2026-01-01', to: '2026-10-25' }), TODAY);
  assert.equal(view.period.bucket, 'week', 'a long period is charted in weeks');
  assert.equal(view.ranking.pages, 1);
  assert.deepEqual(view.chart.groups, []);
});

test('the search tab lists each article page with what each engine said, and the launch\'s numbers in the period', async () => {
  const registry = await memoryRegistry();
  const { launch } = await seed(registry);
  const url = 'https://blog.example/en/claudio/';
  await registry.posts.recordPost({ launchId: launch.id, channel: 'blog', kind: 'article:en', externalId: 'a1', url });
  await registry.cursors.setCursor(indexStatusKey(url), JSON.stringify({ indexed: true, coverage: 'Submitted and indexed', checkedAt: '2026-10-24T06:00:00.000Z' }));
  for (const [day, impressions] of [['12', 5], ['22', 40]] as const) await registry.metrics.recordMetrics(launch.id, 'search', { impressions, clicks: 1 }, at(day));

  const view = await loadSearch(registry, { from: '2026-09-26', to: TODAY });
  assert.equal(view.launches.length, 1);
  const [entry] = view.launches;
  assert.equal(entry?.label, 'yeyo11/claudio v1.0.0');
  assert.deepEqual(entry?.pages, [{ lang: 'en', url, google: { indexed: true, coverage: 'Submitted and indexed', checkedAt: '2026-10-24T06:00:00.000Z' }, bing: null }]);
  assert.equal(entry?.google?.impressions, 40, 'what grew in the period');
  assert.equal(entry?.bing, null, 'Bing never read');
  assert.deepEqual((await loadSearch(registry, { from: '2026-09-26', to: TODAY, launches: [launch.id + 1] })).launches, []);
});
