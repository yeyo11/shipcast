import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import type { PageVisits } from '@shipcast/connectors';
import { collectMetrics, indexStatus, type Registry, SITEMAP_SUBMITTED_KEY, type MetricSources } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

async function published(registry: Registry) {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.8.2', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published', 'https://github.com/yeyo11/launches/pull/3');
  await registry.recordPost({ launchId: launch.id, channel: 'blog', kind: 'article:en', url: 'https://josegarrido.dev/en/claudio/', externalId: 'claudio' });
  await registry.recordPost({ launchId: launch.id, channel: 'blog', kind: 'article:es', url: 'https://josegarrido.dev/es/claudio-como-servicio/', externalId: 'claudio-como-servicio' });
  await registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '42' });
  await registry.recordPost({ launchId: launch.id, channel: 'bluesky', url: 'https://bsky.app/x', externalId: 'at://x' });
  return launch;
}

test('every source of a published launch is read and recorded under its name', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const asked: string[] = [];
  const sources: MetricSources = {
    posts: {
      devto: { metrics: async (id) => (asked.push(`devto ${id}`), { views: 310, reactions: 12 }) },
      bluesky: { metrics: async (id) => (asked.push(`bluesky ${id}`), { likes: 9 }) },
    },
    blog: {
      pageVisits: async (path): Promise<PageVisits> => {
        asked.push(`blog ${path}`);
        return path.startsWith('/en/') ? { views: 40, bySource: { bluesky: 30, direct: 10 } } : { views: 8, bySource: { direct: 8 } };
      },
    },
    search: { pageMetrics: async (url) => (url.includes('/en/') ? { clicks: 3, impressions: 90 } : { clicks: 1, impressions: 10 }) },
    github: { repoStats: async () => ({ stars: 120, forks: 9, watchers: 4 }) },
  };

  const result = await collectMetrics(registry, brand, sources, new Date('2026-10-30T12:00:00Z'));
  assert.deepEqual(result.problems, []);
  assert.ok(asked.includes('blog /en/claudio/') && asked.includes('blog /es/claudio-como-servicio/'), 'both languages of the article');

  const latest = Object.fromEntries((await registry.latestMetrics(launch.id)).map((m) => [`${m.source}.${m.name}`, m.value]));
  assert.deepEqual(latest, {
    'blog.views': 48,
    'blog.views_bluesky': 30,
    'blog.views_direct': 18,
    'blog.views_en': 40,
    'blog.views_es': 8,
    'bluesky.likes': 9,
    'devto.reactions': 12,
    'devto.views': 310,
    'github.forks': 9,
    'github.stars': 120,
    'github.watchers': 4,
    'search.clicks': 4,
    'search.impressions': 100,
  });
});

test('one source failing does not stop the others', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const result = await collectMetrics(registry, brand, {
    posts: { devto: { metrics: async () => Promise.reject(new Error('dev.to: metrics: 503')) }, bluesky: { metrics: async () => ({ likes: 2 }) } },
  });
  assert.deepEqual(result.problems, ['yeyo11/claudio v0.8.2 devto: dev.to: metrics: 503']);
  assert.deepEqual((await registry.latestMetrics(launch.id)).map((m) => `${m.source}.${m.name}=${m.value}`), ['bluesky.likes=2']);
});

test('every reading is kept, so a metric has a history', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  let likes = 3;
  const sources: MetricSources = { posts: { bluesky: { metrics: async () => ({ likes: likes++ }) } } };
  await collectMetrics(registry, brand, sources, new Date('2026-10-26T00:00:00Z'));
  await collectMetrics(registry, brand, sources, new Date('2026-10-27T00:00:00Z'));
  assert.deepEqual((await registry.metricHistory(launch.id, 'bluesky', 'likes')).map((m) => m.value), [3, 4]);
  assert.equal((await registry.latestMetrics(launch.id)).find((m) => m.name === 'likes')?.value, 4);
});

test('launches not yet published are not read', async () => {
  const registry = await memoryRegistry();
  await registry.launches.claim({ repo: 'yeyo11/x', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  let reads = 0;
  await collectMetrics(registry, brand, { github: { repoStats: async () => (reads++, { stars: 1, forks: 0, watchers: 0 }) } });
  assert.equal(reads, 0);
});

test("Google's view of each language is kept, and an article it lacks has the sitemap resubmitted once a day", async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const submitted: string[] = [];
  const sources: MetricSources = {
    search: {
      pageMetrics: async () => ({ clicks: 0, impressions: 0 }),
      inspect: async (url) =>
        url.includes('/en/')
          ? { indexed: true, coverage: 'Submitted and indexed', lastCrawl: '2026-10-29T08:00:00Z' }
          : { indexed: false, coverage: 'URL is unknown to Google' },
      submitSitemap: async (url) => void submitted.push(url),
    },
  };

  await collectMetrics(registry, brand, sources, new Date('2026-10-30T12:00:00Z'));
  assert.deepEqual(await indexStatus(registry, 'https://josegarrido.dev/en/claudio/'), {
    indexed: true,
    coverage: 'Submitted and indexed',
    lastCrawl: '2026-10-29T08:00:00Z',
    checkedAt: '2026-10-30T12:00:00.000Z',
  });
  assert.equal((await indexStatus(registry, 'https://josegarrido.dev/es/claudio-como-servicio/'))?.coverage, 'URL is unknown to Google');
  assert.equal((await registry.latestMetrics(launch.id)).find((m) => m.name === 'indexed')?.value, 1);
  assert.deepEqual(submitted, ['https://josegarrido.dev/sitemap-index.xml']);

  await collectMetrics(registry, brand, sources, new Date('2026-10-30T18:00:00Z'));
  assert.equal(submitted.length, 1, 'not again the same day');
  await collectMetrics(registry, brand, sources, new Date('2026-10-31T13:00:00Z'));
  assert.equal(submitted.length, 2, 'again the next day, while Google still lacks it');
  assert.equal(await registry.cursor(SITEMAP_SUBMITTED_KEY), '2026-10-31T13:00:00.000Z');
});

test('with every article indexed the sitemap is left alone', async () => {
  const registry = await memoryRegistry();
  await published(registry);
  const submitted: string[] = [];
  await collectMetrics(registry, brand, {
    search: {
      pageMetrics: async () => ({ clicks: 0, impressions: 0 }),
      inspect: async () => ({ indexed: true, coverage: 'Submitted and indexed' }),
      submitSitemap: async (url) => void submitted.push(url),
    },
  });
  assert.deepEqual(submitted, []);
});

test("Bing's clicks, impressions and crawl state are kept apart from Google's", async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  await collectMetrics(
    registry,
    brand,
    {
      search: { pageMetrics: async () => ({ clicks: 3, impressions: 90 }), inspect: async () => ({ indexed: true, coverage: 'Submitted and indexed' }) },
      bing: {
        pageMetrics: async (url) => (url.includes('/en/') ? { clicks: 2, impressions: 40 } : { clicks: 0, impressions: 5 }),
        inspect: async (url) => (url.includes('/en/') ? { indexed: true, coverage: 'Crawled on 2026-10-29' } : { indexed: false, coverage: 'Not known to Bing yet' }),
      },
    },
    new Date('2026-10-30T12:00:00Z'),
  );
  const latest = Object.fromEntries((await registry.latestMetrics(launch.id)).map((m) => [`${m.source}.${m.name}`, m.value]));
  assert.equal(latest['bing.clicks'], 2);
  assert.equal(latest['bing.impressions'], 45);
  assert.equal(latest['bing.crawled'], 1);
  assert.equal(latest['search.indexed'], 2, "Google's own numbers are untouched");
  assert.equal((await indexStatus(registry, 'https://josegarrido.dev/en/claudio/', 'bing'))?.coverage, 'Crawled on 2026-10-29');
  assert.equal((await indexStatus(registry, 'https://josegarrido.dev/en/claudio/'))?.coverage, 'Submitted and indexed');
});

test('each piece is read on its own and its readings point at it; the launch adds them up', async () => {
  const registry = await memoryRegistry();
  const launch = await published(registry);
  const en = (await registry.recordPost({ launchId: launch.id, channel: 'newsletter', kind: 'issue:en', url: 'https://brevo/8', externalId: '8' })).post;
  const es = (await registry.recordPost({ launchId: launch.id, channel: 'newsletter', kind: 'issue:es', url: 'https://brevo/9', externalId: '9' })).post;
  await registry.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'post', url: 'https://ig/p/1', externalId: 'p1' });
  await registry.recordPost({ launchId: launch.id, channel: 'instagram', kind: 'story', url: null, externalId: 's1' });
  const asked: string[] = [];
  await collectMetrics(
    registry,
    brand,
    {
      posts: {
        newsletter: { metrics: async (id) => (asked.push(`newsletter ${id}`), { clicks: id === '8' ? 5 : 2 }) },
        instagram: { metrics: async (id) => (asked.push(`instagram ${id}`), { likes: 7 }) },
      },
    },
    new Date('2026-10-30T12:00:00Z'),
  );
  assert.deepEqual(asked.sort(), ['instagram p1', 'newsletter 8', 'newsletter 9'], 'one campaign per issue; a story has no post numbers');
  assert.deepEqual((await registry.postMetrics(en.id)).map((m) => `${m.name}=${m.value}`), ['clicks=5']);
  assert.deepEqual((await registry.postMetrics(es.id)).map((m) => `${m.name}=${m.value}`), ['clicks=2']);
  assert.equal((await registry.latestMetrics(launch.id)).find((m) => m.source === 'newsletter')?.value, 7, 'both issues together');
  assert.deepEqual((await registry.metricHistory(launch.id, 'newsletter', 'clicks')).map((m) => m.value), [7]);
});
