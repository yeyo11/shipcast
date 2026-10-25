import type { IndexStatus, Metrics, PageVisits } from '@shipcast/connectors';
import type { Brand, Channel, Language } from '@shipcast/schema';
import type { RepoStats } from './github.ts';
import { kindLanguage, type Post, type Registry } from './registry.ts';

/** Each source the engine can read numbers from; a source left out is not read. */
export interface MetricSources {
  /** Per piece, by channel: the connectors' `metrics(externalId)`, read for each post and newsletter issue */
  posts?: Partial<Record<Channel, { metrics(externalId: string): Promise<Metrics> }>>;
  /** The blog's visits per article path, by source */
  blog?: { pageVisits(path: string, since: string, until: string): Promise<PageVisits> };
  /** Google search numbers per article URL, whether Google indexed it, and resubmitting the sitemap */
  search?: {
    pageMetrics(url: string, since: string, until: string): Promise<Metrics>;
    inspect?(url: string): Promise<IndexStatus>;
    submitSitemap?(sitemapUrl: string): Promise<void>;
  };
  /** Bing's clicks and impressions per article URL, and whether Bing has crawled it */
  bing?: {
    pageMetrics(url: string): Promise<Metrics>;
    inspect?(url: string): Promise<IndexStatus>;
  };
  /** The launched repo's stars, forks and traffic */
  github?: { repoStats(repo: string): Promise<RepoStats> };
}

export interface CollectResult {
  readings: number;
  problems: string[];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** A search engine whose view of each article is kept */
export type SearchEngine = 'google' | 'bing';

/** Where a search engine's view of one article URL is kept, as of the last reading */
export const indexStatusKey = (url: string, engine: SearchEngine = 'google') => (engine === 'google' ? `index-status:${url}` : `index-status:${engine}:${url}`);
/** When the sitemap was last resubmitted, so it is asked for at most once a day */
export const SITEMAP_SUBMITTED_KEY = 'sitemap-submitted-at';
const SITEMAP_EVERY_MS = 24 * 3600 * 1000;

export const sitemapUrl = (site: string) => `${site}/sitemap-index.xml`;

/** A search engine's view of an article URL, as of the last reading; undefined until it is first read */
export async function indexStatus(registry: Registry, url: string, engine: SearchEngine = 'google'): Promise<(IndexStatus & { checkedAt: string }) | undefined> {
  const raw = await registry.cursor(indexStatusKey(url, engine));
  return raw ? (JSON.parse(raw) as IndexStatus & { checkedAt: string }) : undefined;
}

/**
 * Resubmits the sitemap, unless that was done in the last day. Google ignores frequent resubmits of
 * an unchanged sitemap, and a new article is what changes it.
 */
export async function resubmitSitemap(registry: Registry, site: string, search: NonNullable<MetricSources['search']>, now = new Date(), force = false): Promise<boolean> {
  if (!search.submitSitemap) return false;
  const last = Date.parse((await registry.cursor(SITEMAP_SUBMITTED_KEY)) ?? '') || 0;
  if (!force && now.getTime() - last < SITEMAP_EVERY_MS) return false;
  await search.submitSitemap(sitemapUrl(site));
  await registry.setCursor(SITEMAP_SUBMITTED_KEY, now.toISOString());
  return true;
}

/** The article's URL in each language, from the blog's `article:<lang>` pieces of a launch */
export function articleUrls(pieces: Post[]): Array<{ lang: Language; url: string }> {
  return pieces.flatMap((p) => {
    // A deleted article has no page left to count
    const lang = p.channel === 'blog' && p.kind.startsWith('article:') && p.status !== 'deleted' ? kindLanguage(p.kind) : undefined;
    return lang && p.url ? [{ lang, url: p.url }] : [];
  });
}

/**
 * Reads every source for every published launch and records the numbers, as of `now`. One source
 * failing never stops the others: its problem is reported and the rest are still recorded.
 */
export async function collectMetrics(registry: Registry, brand: Brand, sources: MetricSources, now = new Date()): Promise<CollectResult> {
  let readings = 0;
  const problems: string[] = [];
  const record = async (launchId: number, source: string, values: Record<string, number | undefined>, postId: number | null = null) => {
    const clean = Object.fromEntries(Object.entries(values).filter((e): e is [string, number] => typeof e[1] === 'number'));
    await registry.recordMetrics(launchId, source, clean, now, postId);
    readings += Object.keys(clean).length;
  };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  let unindexed = false;
  const launches = (await registry.recent(500)).filter((l) => l.status === 'published');
  for (const launch of launches) {
    const since = launch.createdAt.slice(0, 10);
    const until = day(now);

    const pieces = await registry.posts(launch.id);
    for (const post of pieces) {
      const reader = sources.posts?.[post.channel];
      // A story or a comment has none of its post's numbers; each newsletter issue is a campaign of its own
      const read = post.kind === 'post' || post.kind.startsWith('issue:');
      // A deleted piece answers nothing but not found; its last numbers stay as they were
      if (reader && read && post.externalId && post.channel !== 'blog' && post.status !== 'deleted') {
        const what = post.kind === 'post' ? post.channel : `${post.channel} ${post.kind}`;
        await attempt(`${launch.repo} ${launch.ref} ${what}`, async () => record(launch.id, post.channel, await reader.metrics(post.externalId!), post.id));
      }
    }

    // The blog's sources are the site's, read per article URL and kept for the launch
    const urls = articleUrls(pieces);
    if (urls.length > 0) {
      if (sources.blog) {
        await attempt(`${launch.repo} ${launch.ref} blog visits`, async () => {
          const visits = await Promise.all(urls.map(async ({ lang, url }) => ({ lang, ...(await sources.blog!.pageVisits(new URL(url).pathname, since, until)) })));
          const values: Record<string, number> = { views: 0 };
          for (const v of visits) {
            values.views! += v.views;
            values[`views_${v.lang}`] = (values[`views_${v.lang}`] ?? 0) + v.views;
            for (const [source, count] of Object.entries(v.bySource)) values[`views_${source}`] = (values[`views_${source}`] ?? 0) + count;
          }
          await record(launch.id, 'blog', values);
        });
      }
      if (sources.search) {
        await attempt(`${launch.repo} ${launch.ref} search`, async () => {
          const found = await Promise.all(urls.map(({ url }) => sources.search!.pageMetrics(url, since, until)));
          await record(launch.id, 'search', {
            clicks: found.reduce((n, m) => n + (m.clicks ?? 0), 0),
            impressions: found.reduce((n, m) => n + (m.impressions ?? 0), 0),
          });
        });
        const inspect = sources.search.inspect?.bind(sources.search);
        if (inspect) {
          await attempt(`${launch.repo} ${launch.ref} index status`, async () => {
            const statuses = await Promise.all(urls.map(async ({ url }) => ({ url, status: await inspect(url) })));
            for (const { url, status } of statuses) await registry.setCursor(indexStatusKey(url), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
            await record(launch.id, 'search', { indexed: statuses.filter((s) => s.status.indexed).length });
            unindexed ||= statuses.some((s) => !s.status.indexed);
          });
        }
      }
      if (sources.bing) {
        const bing = sources.bing;
        await attempt(`${launch.repo} ${launch.ref} Bing`, async () => {
          const found = await Promise.all(urls.map(({ url }) => bing.pageMetrics(url)));
          const values: Record<string, number> = {
            clicks: found.reduce((n, m) => n + (m.clicks ?? 0), 0),
            impressions: found.reduce((n, m) => n + (m.impressions ?? 0), 0),
          };
          if (bing.inspect) {
            const statuses = await Promise.all(urls.map(async ({ url }) => ({ url, status: await bing.inspect!(url) })));
            for (const { url, status } of statuses) await registry.setCursor(indexStatusKey(url, 'bing'), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
            values.crawled = statuses.filter((s) => s.status.indexed).length;
          }
          await record(launch.id, 'bing', values);
        });
      }
    }

    // An article has no repo of its own to count stars on
    if (sources.github && !launch.ref.startsWith('article:')) {
      await attempt(`${launch.repo} GitHub`, async () => {
        const stats = await sources.github!.repoStats(launch.repo);
        await record(launch.id, 'github', { ...stats });
      });
    }
  }
  // An article Google still lacks is the one case where asking it to read the sitemap again helps
  if (unindexed && sources.search) await attempt('sitemap', async () => void (await resubmitSitemap(registry, brand.site, sources.search!, now)));
  return { readings, problems };
}
