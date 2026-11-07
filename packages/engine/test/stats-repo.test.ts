import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { statsOverview, statsRanking, statsSeries, type Repositories } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

/*
 * A repo's numbers are one counter across its launches, and each part of it belongs to the launch
 * that was the repo's newest when it happened (docs/stats.md): production on 2026-11-07 gave a star
 * of 10-29 to a launch that went out on 11-03, and counted the repo's views as each launch's views.
 */

const at = (day: string, hour = 12) => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

async function launchOf(registry: Repositories, ref: string, wentOut: string) {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/shipcast', ref, trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published');
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', accountId: null, externalId: `devto-${ref}`, url: `https://dev.to/${ref}` });
  await registry.queries.selectRows(sql`UPDATE posts SET published_at = ${at(wentOut, 10).toISOString()} WHERE id = ${post.id} RETURNING id`);
  return { launch, post };
}

async function production() {
  const registry = await memoryRegistry();
  const first = await launchOf(registry, 'v0.1.0', '2026-10-25');
  // The repo had 5 stars before Shipcast; one more on 10-29
  for (const [day, stars] of [['2026-10-25', 5], ['2026-10-29', 6], ['2026-11-02', 6]] as const) {
    await registry.metrics.recordMetrics(first.launch.id, 'github', { stars }, at(day));
  }
  await registry.metrics.recordMetrics(first.launch.id, 'devto', { views: 40 }, at('2026-10-26'), first.post.id);
  const second = await launchOf(registry, 'v0.3.0', '2026-11-03');
  // From 11-03 both launches read the repo, at the same moments
  for (const l of [first.launch, second.launch]) {
    for (const day of ['2026-11-03', '2026-11-05']) await registry.metrics.recordMetrics(l.id, 'github', { stars: 6 }, at(day));
    // GitHub's 14 days, kept on every launch of the repo; the 10-20 day is from before either went out
    await registry.metrics.recordDays(l.id, 'github', { '2026-10-20': { views: 5 }, '2026-10-26': { views: 100 }, '2026-11-01': { views: 54 }, '2026-11-04': { views: 100 } }, at('2026-11-05'));
  }
  await registry.metrics.recordMetrics(second.launch.id, 'devto', { views: 230 }, at('2026-11-05'), second.post.id);
  return { registry, first: first.launch, second: second.launch };
}

const period = { from: '2026-10-01', to: '2026-11-06' };

test('each launch is credited the repo’s stars and traffic of its own time only, never those from before it went out', async () => {
  const { registry, first, second } = await production();
  const ranking = await statsRanking(registry, { by: 'launch', ...period, limit: 10 });
  const of = (id: number) => ranking.entries.find((e) => e.launchId === id);
  assert.equal(of(second.id)?.metrics.reactions, 0, 'the star of 10-29 predates the launch of 11-03');
  assert.equal(of(second.id)?.lifetime.reactions, 0);
  assert.equal(of(first.id)?.metrics.reactions, 1);
  assert.equal(of(first.id)?.lifetime.reactions, 1, 'the stars from before Shipcast are no launch’s');
  assert.equal(of(second.id)?.metrics.repoViews, 100);
  assert.equal(of(first.id)?.metrics.repoViews, 154, 'its days up to the next launch, none from before it went out');

  // Narrowed to one launch, the overview says the same
  const one = await statsOverview(registry, { ...period, launches: [second.id] });
  assert.equal(one.lifetime.reactions, 0);
  assert.equal(one.metrics.repoViews, 100);

  // A series by launch splits the repo the same way, and the newer launch starts from nothing
  const series = await statsSeries(registry, { metric: 'reactions', groupBy: 'launch', bucket: 'day', ...period });
  assert.deepEqual(series.groups.map((g) => [Number(g.key), g.baseline, g.total]).sort(), [[first.id, 0, 1], [second.id, 0, 0]].sort());
});

test('across launches the repo is counted once, and its lifetime stars are still the repo’s own number', async () => {
  const { registry } = await production();
  const overview = await statsOverview(registry, period);
  const github = overview.channels.find((c) => c.channel === 'github');
  assert.equal(github?.metrics.reactions, 1);
  assert.equal(github?.lifetime.reactions, 6, 'GitHub’s own count, stars from before Shipcast included');
  assert.equal(github?.metrics.repoViews, 254, 'each day once, from the first launch on');
});

test('a launch’s views are its pieces’ and its site’s, never the repo’s traffic, which is Repo views', async () => {
  const { registry, second } = await production();
  const ranking = await statsRanking(registry, { by: 'launch', ...period, limit: 10 });
  const entry = ranking.entries.find((e) => e.launchId === second.id);
  assert.equal(entry?.metrics.views, 230);
  assert.equal(entry?.lifetime.views, 230);
  const overview = await statsOverview(registry, period);
  assert.equal(overview.metrics.views, 270, 'dev.to’s 40 and 230, no repo views');
  assert.equal(overview.channels.find((c) => c.channel === 'github')?.metrics.views, undefined);
  const series = await statsSeries(registry, { metric: 'views', groupBy: 'channel', bucket: 'day', ...period });
  assert.deepEqual(series.groups.map((g) => g.key), ['devto']);
});
