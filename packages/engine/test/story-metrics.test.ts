import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { batchReader, collectHourly, collectMetrics, runChecks, statsOverview, statsRanking, TelemetryStore, type MetricSources } from '../src/index.ts';
import { aPublishedLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * An Instagram story's numbers (docs/stats.md): Meta keeps them 24 hours, so the story is read with
 * its kind while they last and never after; its last read is one piece alone; its views count with
 * the post's on /stats, where it is a row of its own. And a batch reader's partial failures are said.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const HOUR = 3_600_000;

async function withStory() {
  const registry = await memoryRegistry();
  const { launch, posts } = await aPublishedLaunch(registry, [
    { channel: 'instagram', externalId: 'ig-post' },
    { channel: 'instagram', kind: 'story', externalId: 'ig-story' },
    { channel: 'instagram', kind: 'comment', externalId: 'ig-comment', url: null },
  ]);
  const asked: Array<[string, string | undefined]> = [];
  const sources: MetricSources = {
    posts: {
      instagram: {
        metrics: async (id: string, kind?: string): Promise<Record<string, number>> => {
          asked.push([id, kind]);
          return kind === 'story' ? { views: 40, reach: 30, taps_forward: 5 } : { views: 100, likes: 4 };
        },
      },
    },
  };
  return { registry, launch, posts, sources, asked, publishedAt: Date.parse(posts[1]!.publishedAt) };
}

test('a story is read with its kind while Meta keeps its numbers, and never after 24 hours', async () => {
  const { registry, sources, asked, publishedAt } = await withStory();
  await collectHourly(registry, brand, sources, new Date(publishedAt + HOUR));
  assert.deepEqual(asked, [
    ['ig-post', 'post'],
    ['ig-story', 'story'],
  ]);

  asked.length = 0;
  await collectHourly(registry, brand, sources, new Date(publishedAt + 25 * HOUR));
  assert.deepEqual(asked, [['ig-post', 'post']], 'the story is gone from Meta: not asked');

  asked.length = 0;
  await collectMetrics(registry, brand, sources, new Date(publishedAt + 2 * HOUR));
  assert.deepEqual(asked, [
    ['ig-post', 'post'],
    ['ig-story', 'story'],
  ], 'the six-hourly reads too');
});

test('a last read asks for its piece alone, due or not, and nothing of the site', async () => {
  const { registry, posts, sources, asked, publishedAt } = await withStory();
  const at = new Date(publishedAt + 23.5 * HOUR);
  await collectHourly(registry, brand, sources, at);
  asked.length = 0;
  const result = await collectHourly(registry, brand, { ...sources, github: { repoStats: async () => assert.fail('the site is not read') } }, new Date(at.getTime() + 60_000), { posts: [posts[1]!.id] });
  assert.deepEqual(asked, [['ig-story', 'story']], 'read again a minute later, though not due');
  assert.deepEqual(result.problems, []);
});

test('a story’s views count with the post’s on /stats, and it is a row of its own in the ranking', async () => {
  const { registry, sources, publishedAt } = await withStory();
  const at = new Date(publishedAt + HOUR);
  await collectHourly(registry, brand, sources, at);
  const day = at.toISOString().slice(0, 10);
  const overview = await statsOverview(registry, { from: day, to: day });
  const instagram = overview.channels.find((c) => c.channel === 'instagram');
  assert.equal(instagram?.metrics.views, 140);
  assert.equal(instagram?.metrics.impressions, undefined, 'reach is no family’s');
  const ranking = await statsRanking(registry, { by: 'post', from: day, to: day });
  assert.deepEqual(ranking.entries.map((e) => e.kind).sort(), ['post', 'story']);
});

test('freshness counts a story while it lasts, and not one fewer than five accounts saw', async () => {
  const { registry, sources, publishedAt } = await withStory();
  const freshness = async (now: Date) => (await runChecks(registry, new TelemetryStore(registry.database), { now, cadenceHours: 1 })).find((r) => r.name === 'freshness')!;
  // Meta answers #10 for the story: the connector gives no numbers
  const quiet: MetricSources = { posts: { instagram: { metrics: async (id: string, kind?: string) => (kind === 'story' ? {} : sources.posts!.instagram!.metrics(id)) } } };
  await collectHourly(registry, brand, quiet, new Date(publishedAt + HOUR));
  let check = await freshness(new Date(publishedAt + HOUR + 60_000));
  assert.equal((check.detail as { posts: number }).posts, 1, 'the story with nothing to read yet is left out');
  await collectHourly(registry, brand, sources, new Date(publishedAt + 2 * HOUR));
  check = await freshness(new Date(publishedAt + 2 * HOUR + 60_000));
  assert.equal((check.detail as { posts: number }).posts, 2);
  assert.equal(check.ok, true);
  check = await freshness(new Date(publishedAt + 30 * HOUR));
  assert.equal((check.detail as { posts: number }).posts, 1, 'a story past its 24 hours is never stale');
});

test('a batch reader’s partial failures are said, and what it read is recorded', async () => {
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, [{ channel: 'threads', externalId: 't1' }]);
  const many = async (ids: string[]) => Object.assign(new Map(ids.map((id) => [id, { views: 3 }])), { problems: ['link clicks: denied'] });
  const sources: MetricSources = { posts: { threads: { metrics: async () => ({}), read: batchReader(many).read } } };
  const hourly = await collectHourly(registry, brand, sources, new Date());
  assert.deepEqual(hourly.problems, ['threads: link clicks: denied']);
  const six = await collectMetrics(registry, brand, { posts: { threads: { metrics: async () => ({}), metricsMany: many } } }, new Date());
  assert.deepEqual(six.problems, ['threads: link clicks: denied']);
  assert.equal((await registry.metrics.postMetricHistory(launch.id)).filter((r) => r.name === 'views').length >= 1, true);
});
