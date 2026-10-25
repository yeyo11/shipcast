import type { Metrics, PageVisits } from '@shipcast/connectors';
import type { Brand, Channel } from '@shipcast/schema';
import type { RepoStats } from './github.ts';
import type { Registry } from './registry.ts';

/** Each source the engine can read numbers from; a source left out is not read. */
export interface MetricSources {
  /** Per post, by channel: the connectors' `metrics(externalId)` */
  posts?: Partial<Record<Channel, { metrics(externalId: string): Promise<Metrics> }>>;
  /** The blog's visits per article path, by source */
  blog?: { pageVisits(path: string, since: string, until: string): Promise<PageVisits> };
  /** Google search numbers per article URL */
  search?: { pageMetrics(url: string, since: string, until: string): Promise<Metrics> };
  /** The launched repo's stars, forks and traffic */
  github?: { repoStats(repo: string): Promise<RepoStats> };
}

export interface CollectResult {
  readings: number;
  problems: string[];
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The article's URL in each language. The blog post records both slugs (`en:a-slug,es:un-slug`),
 * since each language has its own; an older record with one slug shared by both is read too.
 */
function articleUrls(externalId: string | null | undefined, url: string, site: string): Array<{ lang: string; url: string }> {
  const pairs = (externalId ?? '').split(',').map((p) => /^(en|es):(.+)$/.exec(p)).filter((m): m is RegExpExecArray => m !== null);
  if (pairs.length > 0) return pairs.map(([, lang, slug]) => ({ lang: lang!, url: `${site}/${lang}/${slug}/` }));
  return [
    { lang: 'en', url },
    { lang: 'es', url: url.replace(`${site}/en/`, `${site}/es/`) },
  ];
}

/**
 * Reads every source for every published launch and records the numbers, as of `now`. One source
 * failing never stops the others: its problem is reported and the rest are still recorded.
 */
export async function collectMetrics(registry: Registry, brand: Brand, sources: MetricSources, now = new Date()): Promise<CollectResult> {
  let readings = 0;
  const problems: string[] = [];
  const record = (launchId: number, source: string, values: Record<string, number | undefined>) => {
    const clean = Object.fromEntries(Object.entries(values).filter((e): e is [string, number] => typeof e[1] === 'number'));
    registry.recordMetrics(launchId, source, clean, now);
    readings += Object.keys(clean).length;
  };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launches = registry.recent(500).filter((l) => l.status === 'published');
  for (const launch of launches) {
    const since = launch.createdAt.slice(0, 10);
    const until = day(now);

    for (const post of registry.posts(launch.id)) {
      const reader = sources.posts?.[post.channel];
      if (reader && post.externalId && post.channel !== 'blog') {
        await attempt(`${launch.repo} ${launch.ref} ${post.channel}`, async () => record(launch.id, post.channel, await reader.metrics(post.externalId!)));
      }
      if (post.channel === 'blog' && post.url) {
        const urls = articleUrls(post.externalId, post.url, brand.site);
        if (sources.blog) {
          await attempt(`${launch.repo} ${launch.ref} blog visits`, async () => {
            const visits = await Promise.all(urls.map(async ({ lang, url }) => ({ lang, ...(await sources.blog!.pageVisits(new URL(url).pathname, since, until)) })));
            const values: Record<string, number> = { views: 0 };
            for (const v of visits) {
              values.views! += v.views;
              values[`views_${v.lang}`] = (values[`views_${v.lang}`] ?? 0) + v.views;
              for (const [source, count] of Object.entries(v.bySource)) values[`views_${source}`] = (values[`views_${source}`] ?? 0) + count;
            }
            record(launch.id, 'blog', values);
          });
        }
        if (sources.search) {
          await attempt(`${launch.repo} ${launch.ref} search`, async () => {
            const found = await Promise.all(urls.map(({ url }) => sources.search!.pageMetrics(url, since, until)));
            record(launch.id, 'search', {
              clicks: found.reduce((n, m) => n + (m.clicks ?? 0), 0),
              impressions: found.reduce((n, m) => n + (m.impressions ?? 0), 0),
            });
          });
        }
      }
    }

    // An article has no repo of its own to count stars on
    if (sources.github && !launch.ref.startsWith('article:')) {
      await attempt(`${launch.repo} GitHub`, async () => {
        const stats = await sources.github!.repoStats(launch.repo);
        record(launch.id, 'github', { ...stats });
      });
    }
  }
  return { readings, problems };
}
