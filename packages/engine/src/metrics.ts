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
        const path = new URL(post.url).pathname;
        const spanish = post.url.replace(`${brand.site}/en/`, `${brand.site}/es/`);
        if (sources.blog) {
          await attempt(`${launch.repo} ${launch.ref} blog visits`, async () => {
            const [en, es] = await Promise.all([
              sources.blog!.pageVisits(path, since, until),
              sources.blog!.pageVisits(new URL(spanish).pathname, since, until),
            ]);
            const values: Record<string, number> = { views: en.views + es.views, views_en: en.views, views_es: es.views };
            for (const visits of [en, es]) {
              for (const [source, count] of Object.entries(visits.bySource)) values[`views_${source}`] = (values[`views_${source}`] ?? 0) + count;
            }
            record(launch.id, 'blog', values);
          });
        }
        if (sources.search) {
          await attempt(`${launch.repo} ${launch.ref} search`, async () => {
            const [en, es] = await Promise.all([sources.search!.pageMetrics(post.url!, since, until), sources.search!.pageMetrics(spanish, since, until)]);
            record(launch.id, 'search', { clicks: (en.clicks ?? 0) + (es.clicks ?? 0), impressions: (en.impressions ?? 0) + (es.impressions ?? 0) });
          });
        }
      }
    }

    if (sources.github) {
      await attempt(`${launch.repo} GitHub`, async () => {
        const stats = await sources.github!.repoStats(launch.repo);
        record(launch.id, 'github', { ...stats });
      });
    }
  }
  return { readings, problems };
}
