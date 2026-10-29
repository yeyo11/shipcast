import type { MetricStore } from './ports.ts';
import { ConnectorError, type IndexStatus, type Metrics, type MetricsMany, type PageVisits, type RepoHistory, type RepoTraffic } from '@shipcast/connectors';
import { channelCadence, INSPECTION_MAX_AGE_DAYS, readsMetrics, SITE_CADENCES, type Brand, type Channel, type Language } from '@shipcast/schema';
import type { RepoStats } from './github.ts';
import type { CursorRepository } from './repositories/cursors.ts';
import { kindLanguage, type Post } from './repositories/posts.ts';

/** A piece whose numbers are asked for: the registry's id, the network's, and its kind (a story's are not a post's) */
export interface MetricTarget {
  postId: number;
  externalId: string;
  kind?: string;
}

/** Many pieces' numbers by their registry ids; `problems` says what part could not be read, while the rest counts */
export type MetricAnswer = Map<number, Metrics> & { problems?: string[] };

/**
 * The batch-first capability of docs/plans/performance-refactor.md ("One definition per channel"):
 * every piece of a channel asked for at once, answered in as few calls as the network allows. A
 * piece missing from the answer is gone (or hidden), and keeps its last numbers.
 */
export interface MetricReader {
  read(posts: readonly MetricTarget[]): Promise<MetricAnswer>;
}

/** A MetricReader over a network's read of many ids at once */
export function batchReader(many: (externalIds: string[]) => Promise<MetricsMany>): MetricReader {
  return {
    async read(posts) {
      const answer = await many([...new Set(posts.map((p) => p.externalId))]);
      const out: MetricAnswer = new Map();
      for (const post of posts) {
        const values = answer.get(post.externalId);
        if (values) out.set(post.postId, values);
      }
      if (answer.problems) out.problems = answer.problems;
      return out;
    },
  };
}

/**
 * A channel's reader of its pieces' numbers: one piece a call, or many at once where the network
 * reads them in batches (YouTube, 50 videos a call), which a round then uses instead. The hourly
 * reads use `read`, the batch-first MetricReader, wherever the adapter gives one.
 */
export interface PostMetricReader extends Partial<MetricReader> {
  /** One piece's numbers; `kind` tells a piece whose numbers are not a post's (an Instagram story) */
  metrics(externalId: string, kind?: string): Promise<Metrics>;
  /** The numbers of many pieces in as few calls as the network allows; a piece missing from the answer is gone */
  metricsMany?(externalIds: string[]): Promise<MetricsMany>;
  /**
   * A network that only tells what changed (Telegram pushes a post's reactions when they move): a
   * piece missing from its answer kept its numbers, which are read again as they were, and a piece
   * never read has `initial`, since every change since it was published would have been told.
   */
  pushOnly?: { initial: Metrics };
}

/** The numbers a push-only network said nothing new about: the piece's last ones, or its first */
async function keptMetrics(registry: MetricStore, postId: number, initial: Metrics): Promise<Metrics> {
  const last = await registry.metrics.postMetrics(postId);
  return last.length > 0 ? Object.fromEntries(last.map((m) => [m.name, m.value])) : initial;
}

/** Each source the engine can read numbers from; a source left out is not read. */
export interface MetricSources {
  /** Per piece, by channel: the connectors' `metrics(externalId)`, read for each post and newsletter issue */
  posts?: Partial<Record<Channel, PostMetricReader>>;
  /** The blog's visits per article path, by source; for many paths at once in one query where it can */
  blog?: {
    pageVisits(path: string, since: string, until: string): Promise<PageVisits>;
    pageVisitsMany?(paths: readonly string[], since: string, until: string): Promise<Map<string, PageVisits>>;
  };
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
  /**
   * The same, apart, for the hourly reads: the counts through a conditional request each hour, the
   * traffic and the history once a day (GitHub buckets them by day). Without it, `github` is read
   * hourly whole.
   */
  githubRepo?: {
    counts(repo: string): Promise<{ stars: number; forks: number; watchers: number }>;
    /** Throws when GitHub refuses it (403 without the App's Administration: read) */
    traffic(repo: string): Promise<RepoTraffic>;
    history(repo: string): Promise<RepoHistory>;
  };
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
export async function indexStatus(registry: { cursors: Pick<CursorRepository, 'cursor'> }, url: string, engine: SearchEngine = 'google'): Promise<(IndexStatus & { checkedAt: string }) | undefined> {
  const raw = await registry.cursors.cursor(indexStatusKey(url, engine));
  return raw ? (JSON.parse(raw) as IndexStatus & { checkedAt: string }) : undefined;
}

/**
 * Resubmits the sitemap, unless that was done in the last day. Google ignores frequent resubmits of
 * an unchanged sitemap, and a new article is what changes it.
 */
export async function resubmitSitemap(registry: { cursors: Pick<CursorRepository, 'cursor' | 'setCursor'> }, site: string, search: NonNullable<MetricSources['search']>, now = new Date(), force = false): Promise<boolean> {
  if (!search.submitSitemap) return false;
  const last = Date.parse((await registry.cursors.cursor(SITEMAP_SUBMITTED_KEY)) ?? '') || 0;
  if (!force && now.getTime() - last < SITEMAP_EVERY_MS) return false;
  await search.submitSitemap(sitemapUrl(site));
  await registry.cursors.setCursor(SITEMAP_SUBMITTED_KEY, now.toISOString());
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
export async function collectMetrics(registry: MetricStore, brand: Brand, sources: MetricSources, now = new Date()): Promise<CollectResult> {
  let readings = 0;
  const problems: string[] = [];
  const record = async (launchId: number, source: string, values: Record<string, number | undefined>, postId: number | null = null) => {
    const clean = Object.fromEntries(Object.entries(values).filter((e): e is [string, number] => typeof e[1] === 'number'));
    await registry.metrics.recordMetrics(launchId, source, clean, now, postId);
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
  const launches = (await registry.launches.recent(500)).filter((l) => l.status === 'published');
  const piecesOf = new Map<number, Post[]>();
  for (const launch of launches) piecesOf.set(launch.id, await registry.posts.posts(launch.id));
  // Which pieces have numbers is the channel's (readsMetrics), a story's only while it lasts. A
  // deleted piece answers nothing but not found; its last numbers stay as they were
  const readable = (post: Post) => readsMetrics(post.channel, post.kind, { publishedAt: post.publishedAt, now }) && post.externalId !== null && post.status !== 'deleted';

  // The channels that read in batches are read first, all their pieces at once
  const batched = new Map<string, Map<string, Metrics>>();
  for (const [channel, reader] of Object.entries(sources.posts ?? {})) {
    if (!reader?.metricsMany) continue;
    const ids = [...piecesOf.values()].flat().filter((p) => p.channel === channel && readable(p)).map((p) => p.externalId!);
    if (ids.length === 0) continue;
    const many = reader.metricsMany.bind(reader);
    await attempt(channel, async () => {
      const answer = await many(ids);
      batched.set(channel, answer);
      for (const problem of answer.problems ?? []) problems.push(`${channel}: ${problem}`);
    });
  }

  for (const launch of launches) {
    const since = launch.createdAt.slice(0, 10);
    const until = day(now);

    const pieces = piecesOf.get(launch.id) ?? [];
    for (const post of pieces) {
      const reader = sources.posts?.[post.channel];
      if (!reader || !readable(post)) continue;
      if (reader.metricsMany) {
        // Read in the batch above; a piece the answer left out is gone (or, from a push-only network,
        // unchanged), and a failed batch was said once
        const answer = batched.get(post.channel);
        const values = answer?.get(post.externalId!) ?? (answer && reader.pushOnly ? await keptMetrics(registry, post.id, reader.pushOnly.initial) : undefined);
        if (values) await record(launch.id, post.channel, values, post.id);
        continue;
      }
      const what = post.kind === 'post' ? post.channel : `${post.channel} ${post.kind}`;
      await attempt(`${launch.repo} ${launch.ref} ${what}`, async () => record(launch.id, post.channel, await reader.metrics(post.externalId!, post.kind), post.id));
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
            for (const { url, status } of statuses) await registry.cursors.setCursor(indexStatusKey(url), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
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
            for (const { url, status } of statuses) await registry.cursors.setCursor(indexStatusKey(url, 'bing'), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
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

const HOUR_MS = 3_600_000;
/** A run starts on the cron's minute and takes a while: a check this much short of the cadence is due */
const DUE_SLACK_MS = 10 * 60_000;
/** When a repo's traffic was last read; a refused read leaves it, so the next hour asks again */
export const trafficReadKey = (repo: string) => `metrics-read:github-traffic:${repo}`;
/** When a repo's stars by day and releases' downloads were last read */
export const historyReadKey = (repo: string) => `metrics-read:github-history:${repo}`;
/** The problems of a source the owner has to fix (a permission), by source and what it was about; the bell lists them */
export const METRIC_PROBLEM_PREFIX = 'metrics-problem:';
/** Why GitHub refused a repo's traffic, kept until it is read again */
export const trafficProblemKey = (repo: string) => `${METRIC_PROBLEM_PREFIX}github-traffic:${repo}`;

/**
 * A repo's traffic as readings: the 14-day totals as before, each day's views and clones under the
 * day (`views:2026-10-28`), and the top referring sites and pages with their unique visitors.
 */
export function trafficReadings(t: RepoTraffic): Record<string, number> {
  const out: Record<string, number> = { views: t.views, uniqueVisitors: t.uniqueVisitors, clones: t.clones, uniqueCloners: t.uniqueCloners };
  for (const d of t.days) Object.assign(out, { [`views:${d.day}`]: d.views, [`visitors:${d.day}`]: d.uniqueVisitors, [`clones:${d.day}`]: d.clones, [`cloners:${d.day}`]: d.uniqueCloners });
  for (const r of t.referrers) Object.assign(out, { [`referrer:${r.name}`]: r.count, [`referrer_visitors:${r.name}`]: r.uniques });
  for (const p of t.paths) Object.assign(out, { [`path:${p.name}`]: p.count, [`path_visitors:${p.name}`]: p.uniques });
  return out;
}

/**
 * A repo's history as one launch's readings: the stars given each day (`stars:2026-10-28`), the
 * downloads of the launch's own release when its ref is one, and of every release together.
 */
export function historyReadings(h: RepoHistory, ref: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [day, stars] of Object.entries(h.starsByDay)) out[`stars:${day}`] = stars;
  const own = h.downloadsByTag[ref];
  if (own !== undefined) out.downloads = own;
  out.downloads_total = Object.values(h.downloadsByTag).reduce((n, d) => n + d, 0);
  return out;
}

/**
 * Whether a Google URL inspection is due for an article (docs/plans/performance-refactor.md, "5.
 * Metrics"): daily until Google has it, weekly after, and never once its launch is older than
 * INSPECTION_MAX_AGE_DAYS, whose last status stays as it was read.
 */
export function inspectionDue(status: { indexed: boolean; checkedAt: string } | undefined, launchCreatedAt: string, now: Date): boolean {
  if (now.getTime() - Date.parse(launchCreatedAt) > INSPECTION_MAX_AGE_DAYS * 24 * HOUR_MS) return false;
  if (!status) return true;
  const hours = status.indexed ? SITE_CADENCES.urlInspectionIndexed.hours : SITE_CADENCES.urlInspection.hours;
  return now.getTime() - Date.parse(status.checkedAt) >= hours * HOUR_MS - DUE_SLACK_MS;
}

export interface HourlyOptions {
  /**
   * Only these pieces, read whether due or not, and nothing of the site: the last read of a piece
   * whose numbers expire (an Instagram story), just before they go
   */
  posts?: readonly number[];
}

/**
 * The hourly reads of phase 8 (behind the `batched-metrics` flag): every live piece of every
 * published launch, each source only when its last check is older than its cadence (the channel
 * definitions' `metrics.cadence`, SITE_CADENCES for the site), each channel's due pieces asked for
 * at once through its MetricReader, the blog's paths in one query, each repo once whatever number of
 * launches it has. A value read again unchanged moves its reading's `checked_at` instead of adding a
 * row. One source failing never stops the others.
 */
export async function collectHourly(registry: MetricStore, brand: Brand, sources: MetricSources, now = new Date(), options: HourlyOptions = {}): Promise<CollectResult> {
  let readings = 0;
  const problems: string[] = [];
  const record = async (launchId: number, source: string, values: Record<string, number | undefined>, postId: number | null = null) => {
    const clean = Object.fromEntries(Object.entries(values).filter((e): e is [string, number] => typeof e[1] === 'number'));
    const stored = await registry.metrics.recordMetrics(launchId, source, clean, now, postId, { unchangedMovesCheck: true });
    readings += stored.inserted + stored.checked;
  };
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const due = (last: string | undefined, hours: number) => last === undefined || now.getTime() - Date.parse(last) >= hours * HOUR_MS - DUE_SLACK_MS;

  const launches = (await registry.launches.recent(500)).filter((l) => l.status === 'published');
  const piecesOf = new Map<number, Post[]>();
  for (const launch of launches) piecesOf.set(launch.id, await registry.posts.posts(launch.id));
  const checked = new Map<string, string>();
  const keep = (key: string, at: string) => {
    const was = checked.get(key);
    if (was === undefined || at > was) checked.set(key, at);
  };
  for (const c of await registry.metrics.lastChecked(launches.map((l) => l.id))) {
    if (c.postId !== null) keep(`p:${c.postId}`, c.at);
    else keep(`l:${c.launchId}:${c.source}:${c.name}`, c.at);
  }
  const only = options.posts ? new Set(options.posts) : undefined;
  const readable = (post: Post) =>
    readsMetrics(post.channel, post.kind, { publishedAt: post.publishedAt, now }) && post.externalId !== null && post.status !== 'deleted' && (!only || only.has(post.id));

  // Each channel: its due pieces, all at once. A launch's pieces of a channel are read together, so
  // its sum (latestMetrics) always adds up readings of one moment
  for (const [channel, reader] of Object.entries(sources.posts ?? {})) {
    if (!reader) continue;
    const hours = channelCadence(channel)?.hours ?? 1;
    const targets: Array<MetricTarget & { launchId: number }> = [];
    for (const launch of launches) {
      const pieces = (piecesOf.get(launch.id) ?? []).filter((p) => p.channel === channel && readable(p));
      if (only || pieces.some((p) => due(checked.get(`p:${p.id}`), hours))) targets.push(...pieces.map((p) => ({ postId: p.id, externalId: p.externalId!, kind: p.kind, launchId: launch.id })));
    }
    if (targets.length === 0) continue;
    if (reader.read || reader.metricsMany) {
      const read = reader.read ? reader.read.bind(reader) : batchReader(reader.metricsMany!.bind(reader)).read;
      await attempt(channel, async () => {
        const answer = await read(targets);
        for (const t of targets) {
          const values = answer.get(t.postId) ?? (reader.pushOnly ? await keptMetrics(registry, t.postId, reader.pushOnly.initial) : undefined);
          if (values) await record(t.launchId, channel, values, t.postId);
        }
        for (const problem of answer.problems ?? []) problems.push(`${channel}: ${problem}`);
      });
      continue;
    }
    // A network with no read of many: one call a piece, as the six-hourly reads do
    for (const t of targets) await attempt(`${channel} ${t.externalId}`, async () => record(t.launchId, channel, await reader.metrics(t.externalId, t.kind), t.postId));
  }
  if (only) return { readings, problems };

  const until = day(now);
  const sites = launches.flatMap((launch) => {
    const urls = articleUrls(piecesOf.get(launch.id) ?? []);
    return urls.length > 0 ? [{ launch, urls, since: launch.createdAt.slice(0, 10) }] : [];
  });
  const siteDue = (launchId: number, source: string, name: string, hours: number) => due(checked.get(`l:${launchId}:${source}:${name}`), hours);

  // The blog's visits: every due launch's paths in one query where the source can
  const blog = sources.blog;
  const blogDue = sites.filter((s) => siteDue(s.launch.id, 'blog', 'views', channelCadence('blog')?.hours ?? 1));
  if (blog && blogDue.length > 0) {
    const visitsOf = async (site: (typeof blogDue)[number], many: Map<string, PageVisits> | undefined) => {
      const visits = await Promise.all(site.urls.map(async ({ lang, url }) => ({ lang, ...(many?.get(new URL(url).pathname) ?? (await blog.pageVisits(new URL(url).pathname, site.since, until))) })));
      const values: Record<string, number> = { views: 0 };
      for (const v of visits) {
        values.views! += v.views;
        values[`views_${v.lang}`] = (values[`views_${v.lang}`] ?? 0) + v.views;
        for (const [source, count] of Object.entries(v.bySource)) values[`views_${source}`] = (values[`views_${source}`] ?? 0) + count;
      }
      await record(site.launch.id, 'blog', values);
    };
    if (blog.pageVisitsMany) {
      const paths = [...new Set(blogDue.flatMap((s) => s.urls.map(({ url }) => new URL(url).pathname)))];
      const since = blogDue.map((s) => s.since).reduce((a, b) => (b < a ? b : a));
      await attempt('blog visits', async () => {
        const many = await blog.pageVisitsMany!(paths, since, until);
        for (const site of blogDue) await visitsOf(site, many);
      });
    } else {
      for (const site of blogDue) await attempt(`${site.launch.repo} ${site.launch.ref} blog visits`, () => visitsOf(site, undefined));
    }
  }

  let unindexed = false;
  for (const { launch, urls, since } of sites) {
    const search = sources.search;
    if (search && siteDue(launch.id, 'search', 'clicks', SITE_CADENCES.searchAnalytics.hours)) {
      await attempt(`${launch.repo} ${launch.ref} search`, async () => {
        const found = await Promise.all(urls.map(({ url }) => search.pageMetrics(url, since, until)));
        await record(launch.id, 'search', { clicks: found.reduce((n, m) => n + (m.clicks ?? 0), 0), impressions: found.reduce((n, m) => n + (m.impressions ?? 0), 0) });
      });
    }
    const inspect = search?.inspect?.bind(search);
    if (inspect) {
      await attempt(`${launch.repo} ${launch.ref} index status`, async () => {
        const known = await Promise.all(urls.map(async ({ url }) => ({ url, status: await indexStatus(registry, url) })));
        const toInspect = known.filter((k) => inspectionDue(k.status, launch.createdAt, now));
        if (toInspect.length === 0) return;
        const fresh = await Promise.all(toInspect.map(async ({ url }) => ({ url, status: await inspect(url) })));
        for (const { url, status } of fresh) await registry.cursors.setCursor(indexStatusKey(url), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
        const statusOf = new Map([...known.flatMap((k) => (k.status ? [[k.url, k.status.indexed] as const] : [])), ...fresh.map((f) => [f.url, f.status.indexed] as const)]);
        await record(launch.id, 'search', { indexed: [...statusOf.values()].filter(Boolean).length });
        unindexed ||= fresh.some((f) => !f.status.indexed);
      });
    }
    const bing = sources.bing;
    if (bing && siteDue(launch.id, 'bing', 'clicks', SITE_CADENCES.bing.hours)) {
      await attempt(`${launch.repo} ${launch.ref} Bing`, async () => {
        const found = await Promise.all(urls.map(({ url }) => bing.pageMetrics(url)));
        const values: Record<string, number> = { clicks: found.reduce((n, m) => n + (m.clicks ?? 0), 0), impressions: found.reduce((n, m) => n + (m.impressions ?? 0), 0) };
        if (bing.inspect) {
          const statuses = await Promise.all(urls.map(async ({ url }) => ({ url, status: await bing.inspect!(url) })));
          for (const { url, status } of statuses) await registry.cursors.setCursor(indexStatusKey(url, 'bing'), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
          values.crawled = statuses.filter((s) => s.status.indexed).length;
        }
        await record(launch.id, 'bing', values);
      });
    }
  }

  // Each repo once, its numbers recorded on every launch of it (the stats count a repo once anyway)
  const repos = new Map<string, Array<{ id: number; ref: string }>>();
  for (const launch of launches) if (!launch.ref.startsWith('article:')) repos.set(launch.repo, [...(repos.get(launch.repo) ?? []), { id: launch.id, ref: launch.ref }]);
  for (const [repo, of] of repos) {
    const ids = of.map((l) => l.id);
    const split = sources.githubRepo;
    const countsDue = ids.some((id) => siteDue(id, 'github', 'stars', SITE_CADENCES.githubCounts.hours));
    if (split) {
      if (countsDue) await attempt(`${repo} GitHub`, async () => {
        const counts = await split.counts(repo);
        for (const id of ids) await record(id, 'github', counts);
      });
      if (due(await registry.cursors.cursor(trafficReadKey(repo)), SITE_CADENCES.githubTraffic.hours)) {
        // A refusal is said, kept for the bell when it needs the owner (a missing permission rather
        // than GitHub having a bad hour), and leaves the cursor, so the next hour asks again
        await attempt(`${repo} GitHub traffic`, async () => {
          let traffic: RepoTraffic;
          try {
            traffic = await split.traffic(repo);
          } catch (error) {
            if (error instanceof ConnectorError && !error.retryable) await registry.cursors.setCursor(trafficProblemKey(repo), error.message);
            throw error;
          }
          await registry.cursors.setCursor(trafficReadKey(repo), now.toISOString());
          await registry.cursors.deleteCursor(trafficProblemKey(repo));
          for (const id of ids) await record(id, 'github', trafficReadings(traffic));
        });
      }
      if (due(await registry.cursors.cursor(historyReadKey(repo)), SITE_CADENCES.githubHistory.hours)) {
        await attempt(`${repo} GitHub stars and downloads`, async () => {
          const history = await split.history(repo);
          await registry.cursors.setCursor(historyReadKey(repo), now.toISOString());
          for (const l of of) await record(l.id, 'github', historyReadings(history, l.ref));
        });
      }
    } else if (sources.github && countsDue) {
      const github = sources.github;
      await attempt(`${repo} GitHub`, async () => {
        const stats = await github.repoStats(repo);
        for (const id of ids) await record(id, 'github', { ...stats });
      });
    }
  }
  if (unindexed && sources.search) await attempt('sitemap', async () => void (await resubmitSitemap(registry, brand.site, sources.search!, now)));
  return { readings, problems };
}
