import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PageVisits } from '@shipcast/connectors';
import { Brand } from '@shipcast/schema';
import { collectMetrics } from '../src/index.ts';
import { aLaunch, aPublishedLaunch, FakeConnectors, FakeGitHub, memoryRegistry, withPosts } from '../src/testing/index.ts';

/*
 * Characterisation: one metrics run over several launches and channels, as it is today, before the
 * MetricReader capability reads many posts per call (docs/plans/performance-refactor.md, phase 3):
 * which pieces are asked for numbers, one call each, which are not, and what one failing source
 * leaves.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

test('one run over several launches: each readable piece is asked once, the rest never; a failing source is one problem', async () => {
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, [
    { channel: 'blog', kind: 'article:en', externalId: 'claudio', url: 'https://josegarrido.dev/en/claudio/' },
    { channel: 'blog', kind: 'article:es', externalId: 'claudio-es', url: 'https://josegarrido.dev/es/claudio-es/' },
    { channel: 'devto', externalId: '42' },
    { channel: 'bluesky', externalId: 'at://b1', status: 'deleted' },
    { channel: 'instagram', externalId: 'ig1' },
    { channel: 'instagram', kind: 'story', externalId: 'st1' },
    { channel: 'instagram', kind: 'comment', externalId: 'c1' },
    { channel: 'newsletter', kind: 'issue:en', externalId: '900' },
    { channel: 'reddit', kind: 'post:claudeai', externalId: 'r1' },
    { channel: 'telegram', externalId: null },
  ]);
  const { launch: article } = await aPublishedLaunch(registry, [{ channel: 'blog', kind: 'article:en', externalId: 'hello', url: 'https://josegarrido.dev/en/hello/' }], { repo: 'yeyo11/launches', ref: 'article:hello', trigger: 'article' });
  const drafted = await aLaunch(registry, { ref: 'v2.0.0' });
  await withPosts(registry, drafted.id, [{ channel: 'devto', externalId: '43' }]);

  const fake = new FakeConnectors();
  fake.metrics = { devto: { views: 10 }, instagram: { likes: 3 }, newsletter: { opens: 5 }, reddit: { upvotes: 1 }, bluesky: { likes: 9 }, telegram: { views: 1 } };
  const github = new FakeGitHub({ stats: { stars: 7, forks: 1, watchers: 2 } });
  const visited: string[] = [];
  const result = await collectMetrics(
    registry,
    brand,
    {
      posts: fake.metricReaders(['devto', 'bluesky', 'instagram', 'newsletter', 'reddit', 'telegram']),
      blog: {
        pageVisits: async (path): Promise<PageVisits> => {
          visited.push(path);
          if (path === '/en/hello/') throw new Error('Cloudflare: 500');
          return path.startsWith('/en/') ? { views: 4, bySource: { direct: 4 } } : { views: 2, bySource: {} };
        },
      },
      github,
    },
    new Date('2026-11-10T12:00:00Z'),
  );

  // A subreddit's post (`post:<subreddit>`) is its channel's main piece, read since Reddit has metrics
  assert.deepEqual([...fake.log].sort(), ['devto metrics 42', 'instagram metrics ig1', 'newsletter metrics 900', 'reddit metrics r1'], 'no deleted, story, comment, id-less or drafted piece');
  assert.deepEqual(github.called('repoStats'), [['yeyo11/claudio']], 'an article has no repo to count stars on');
  assert.deepEqual(visited.sort(), ['/en/claudio/', '/en/hello/', '/es/claudio-es/']);
  assert.deepEqual(result.problems, ['yeyo11/launches article:hello blog visits: Cloudflare: 500']);
  assert.equal(result.readings, 11, 'four pieces, four blog numbers, three of GitHub');

  const latest = Object.fromEntries((await registry.metrics.latestMetrics(launch.id)).map((m) => [`${m.source}.${m.name}`, m.value]));
  assert.deepEqual(latest, {
    'blog.views': 6,
    'blog.views_direct': 4,
    'blog.views_en': 4,
    'blog.views_es': 2,
    'devto.views': 10,
    'github.forks': 1,
    'github.stars': 7,
    'github.watchers': 2,
    'instagram.likes': 3,
    'newsletter.opens': 5,
    'reddit.upvotes': 1,
  });
  assert.deepEqual(await registry.metrics.latestMetrics(article.id), []);
  assert.deepEqual(await registry.metrics.latestMetrics(drafted.id), []);
});
