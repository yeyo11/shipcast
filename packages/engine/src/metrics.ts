import type { MetricStore } from './ports.ts';
import { ConnectorError, type AnalyticsMany, type CampaignVisits, type IndexStatus, type Metrics, type MetricsMany, type PageVisits, type RepoHistory, type RepoTraffic, type SearchDay } from '@shipcast/connectors';
import { campaignOf, channelAnalyticsCadence, channelCadence, INSPECTION_MAX_AGE_DAYS, readsMetrics, SITE_CADENCES, type Brand, type Channel, type Language } from '@shipcast/schema';
import type { RepoStats } from './github.ts';
import type { CursorRepository } from './repositories/cursors.ts';
import { kindLanguage, type Post } from './repositories/posts.ts';
import type { Launch } from './repositories/launches.ts';

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
   * The network's analytics of each piece, lifetime to date from `since` to `until` (YYYY-MM-DD), read
   * on the channel's own analytics cadence (YouTube Analytics, daily); a piece missing from the answer
   * keeps its last numbers. `problems` are said while the rest counts, and the pieces in `unread` (not
   * reached, a rate limit) are asked for again the next hour
   */
  analytics?(pieces: ReadonlyArray<{ id: string; since: string }>, until: string): Promise<AnalyticsMany>;
  /**
   * A network that only tells what changed (Telegram pushes a post's reactions when they move), and
   * forgets a change once it is confirmed read. It is handed every piece that could have a change,
   * due or not, and hands back a page at a time to `store`, confirming a page only once `store` has
   * kept it. A piece missing from every page kept its numbers; a piece never told about has none.
   */
  pushed?(externalIds: string[], store: (page: Map<string, Metrics>) => Promise<void>): Promise<void>;
}

/** A pushed piece's last numbers, to read again as they were; undefined for a piece never told about */
async function keptMetrics(registry: MetricStore, postId: number): Promise<Metrics | undefined> {
  const last = await registry.metrics.postMetrics(postId);
  return last.length > 0 ? Object.fromEntries(last.map((m) => [m.name, m.value])) : undefined;
}

type PushedTarget = MetricTarget & { launchId: number };

/**
 * The pieces a push-only network could tell about: every readable one of the channel, of every
 * launch whatever its status (a launch that failed on another channel still has this one's post
 * out), since a change of a piece left out would be confirmed and lost.
 */
async function pushedTargets(registry: MetricStore, launches: readonly Launch[], piecesOf: ReadonlyMap<number, Post[]>, channel: string, readable: (post: Post) => boolean): Promise<PushedTarget[]> {
  const out: PushedTarget[] = [];
  for (const launch of launches) {
    const pieces = piecesOf.get(launch.id) ?? (await registry.posts.posts(launch.id, { channel: channel as Channel }));
    for (const p of pieces) if (p.channel === channel && readable(p)) out.push({ postId: p.id, externalId: p.externalId!, kind: p.kind, launchId: launch.id });
  }
  return out;
}

/** Reads a push-only channel's changes and keeps each page as it comes; the pieces told about */
async function readPushed(
  pushed: NonNullable<PostMetricReader['pushed']>,
  targets: readonly PushedTarget[],
  record: (launchId: number, values: Metrics, postId: number) => Promise<void>,
): Promise<Set<number>> {
  const byId = new Map(targets.map((t) => [t.externalId, t]));
  const told = new Set<number>();
  await pushed([...byId.keys()], async (page) => {
    for (const [externalId, values] of page) {
      const t = byId.get(externalId);
      if (!t) continue;
      await record(t.launchId, values, t.postId);
      told.add(t.postId);
    }
  });
  return told;
}

/** Each source the engine can read numbers from; a source left out is not read. */
export interface MetricSources {
  /** Per piece, by channel: the connectors' `metrics(externalId)`, read for each post and newsletter issue */
  posts?: Partial<Record<Channel, PostMetricReader>>;
  /** The blog's visits per article path, by source; for many paths at once in one query where it can */
  blog?: {
    pageVisits(path: string, since: string, until: string): Promise<PageVisits>;
    pageVisitsMany?(paths: readonly string[], since: string, until: string): Promise<Map<string, PageVisits>>;
    /** The same paths' page views and visits per day, kept under each day (`metric_days`) */
    pageVisitsByDay?(paths: readonly string[], since: string, until: string): Promise<Map<string, Record<string, { views: number; visits: number }>>>;
  };
  /** Google search numbers per article URL, whether Google indexed it, and resubmitting the sitemap */
  search?: {
    pageMetrics(url: string, since: string, until: string): Promise<Metrics>;
    /** The same per day, under the day the searches happened; where it exists the launch's totals are its days' */
    pageMetricsByDay?(url: string, since: string, until: string): Promise<SearchDay[]>;
    inspect?(url: string): Promise<IndexStatus>;
    submitSitemap?(sitemapUrl: string): Promise<void>;
  };
  /** Bing's clicks and impressions per article URL, and whether Bing has crawled it */
  bing?: {
    pageMetrics(url: string): Promise<Metrics>;
    inspect?(url: string): Promise<IndexStatus>;
  };
  /**
   * The blog's visits by the UTM tags of the links Shipcast published (Umami, behind the `umami`
   * flag): a launch's campaign by `utm_source`, over the launch and per day. Read by the hourly reads only
   */
  umami?: { campaignVisits(campaign: string, since: string, until: string): Promise<CampaignVisits> };
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
  /**
   * With launch-sources: each launch's further repos, besides the primary one, by launch id. Their
   * stars, forks and watchers are read like the primary's and kept apart, per repo, under
   * `github:<owner/name>` (furtherRepoSource), so the launch's own `github` numbers stay its primary repo's
   */
  furtherRepos?: (launchIds: readonly number[]) => Promise<Map<number, string[]>>;
}

/** Where a launch's further repo's numbers are kept: beside the primary repo's `github`, never added to it */
export const furtherRepoSource = (repo: string) => `github:${repo}`;

/**
 * Reads each further repo of the launches once and records its counts on every launch that has it.
 * `isDue` lets the hourly read keep to the counts' cadence; the counts come from the hourly split
 * where there is one, else from the whole stats.
 */
async function readFurtherRepos(
  launches: readonly Launch[],
  sources: MetricSources,
  attempt: (what: string, fn: () => Promise<void>) => Promise<void>,
  record: (launchId: number, source: string, values: Record<string, number | undefined>) => Promise<void>,
  isDue: (launchId: number, source: string) => boolean = () => true,
): Promise<void> {
  if (!sources.furtherRepos || (!sources.githubRepo && !sources.github)) return;
  const further = await sources.furtherRepos(launches.map((l) => l.id));
  const byRepo = new Map<string, number[]>();
  for (const [id, repos] of further) for (const repo of repos) byRepo.set(repo, [...(byRepo.get(repo) ?? []), id]);
  for (const [repo, ids] of byRepo) {
    const source = furtherRepoSource(repo);
    if (!ids.some((id) => isDue(id, source))) continue;
    await attempt(`${repo} GitHub`, async () => {
      const counts = sources.githubRepo ? await sources.githubRepo.counts(repo) : await sources.github!.repoStats(repo);
      for (const id of ids) await record(id, source, { stars: counts.stars, forks: counts.forks, watchers: counts.watchers });
    });
  }
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

/** Where a launch's article pages whose Google canonical is another URL are kept, while they are */
export const CANONICAL_PREFIX = 'search-canonical:';
export const canonicalKey = (launchId: number) => `${CANONICAL_PREFIX}${launchId}`;

/** An article page Google files under another URL: its clicks and impressions go to that one */
export interface CanonicalMismatch {
  url: string;
  googleCanonical: string;
}

const sameUrl = (a: string, b: string) => {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
};

/**
 * Keeps a launch's pages whose Google-selected canonical is not their own URL, for the bell to say
 * so, and forgets them once Google agrees again. A page not indexed has no canonical yet: not one.
 */
export async function noteCanonicals(registry: { cursors: Pick<CursorRepository, 'setCursor' | 'deleteCursor'> }, launchId: number, statuses: ReadonlyArray<{ url: string; status: IndexStatus }>): Promise<CanonicalMismatch[]> {
  const mismatches = statuses.flatMap(({ url, status }) => (status.googleCanonical && !sameUrl(status.googleCanonical, url) ? [{ url, googleCanonical: status.googleCanonical }] : []));
  if (mismatches.length > 0) await registry.cursors.setCursor(canonicalKey(launchId), JSON.stringify(mismatches));
  else await registry.cursors.deleteCursor(canonicalKey(launchId));
  return mismatches;
}

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
 * A launch's search numbers from each language's page: clicks and impressions summed, the CTR of
 * the sum, and the average position weighted by each page's impressions (Search Console's own way
 * of averaging it), where the engine gives one. Averages are not counters: never summed again.
 */
export function searchValues(pages: readonly Metrics[]): Record<string, number> {
  const clicks = pages.reduce((n, m) => n + (m.clicks ?? 0), 0);
  const impressions = pages.reduce((n, m) => n + (m.impressions ?? 0), 0);
  const ranked = pages.filter((m) => m.position !== undefined && (m.impressions ?? 0) > 0);
  const rankedImpressions = ranked.reduce((n, m) => n + m.impressions!, 0);
  return {
    clicks,
    impressions,
    ...(impressions > 0 && { ctr: clicks / impressions }),
    ...(rankedImpressions > 0 && { position: ranked.reduce((n, m) => n + m.position! * m.impressions!, 0) / rankedImpressions }),
  };
}

/** One page's search numbers over its days: clicks and impressions added up, the CTR of the sum, the position weighted by impressions */
export function daysTotal(days: readonly SearchDay[]): Metrics {
  const total = searchValues(days.map((d) => ({ clicks: d.clicks, impressions: d.impressions, position: d.position })));
  return { clicks: total.clicks ?? 0, impressions: total.impressions ?? 0, ...(total.ctr !== undefined && { ctr: total.ctr }), ...(total.position !== undefined && { position: total.position }) };
}

/** Each day's counts of a launch's pages added up (the languages' clicks, or views), for `metric_days` */
export function sumDays(pages: ReadonlyArray<Readonly<Record<string, Readonly<Record<string, number>>>>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const page of pages) {
    for (const [day, values] of Object.entries(page)) {
      const into = (out[day] ??= {});
      for (const [name, value] of Object.entries(values)) into[name] = (into[name] ?? 0) + value;
    }
  }
  return out;
}

/**
 * A launch's blog numbers from each language's page: its page views and visits, the views per
 * language (`views_<lang>`) and per source (`views_<source>`, sourceOfReferrer's names)
 */
export function blogValues(pages: ReadonlyArray<PageVisits & { lang: Language }>): Record<string, number> {
  const values: Record<string, number> = { views: 0, visits: 0 };
  const add = (name: string, n: number) => (values[name] = (values[name] ?? 0) + n);
  for (const page of pages) {
    add('views', page.views);
    add('visits', page.visits);
    add(`views_${page.lang}`, page.views);
    for (const [source, count] of Object.entries(page.bySource)) add(`views_${source}`, count);
  }
  return values;
}

/**
 * A launch's visits from its tagged links as readings: the campaign's page views and visits, and each
 * source's (`views_<utm_source>`, `visits_<utm_source>`, `visitors_<utm_source>`). The sources' unique
 * visitors are not added up: one person can come from two networks.
 */
export function campaignValues(visits: CampaignVisits): Record<string, number> {
  const sources = Object.entries(visits.bySource);
  const values: Record<string, number> = { views: sources.reduce((n, [, v]) => n + v.views, 0), visits: sources.reduce((n, [, v]) => n + v.visits, 0) };
  for (const [source, v] of sources) {
    values[`views_${source}`] = v.views;
    values[`visits_${source}`] = v.visits;
    values[`visitors_${source}`] = v.visitors;
  }
  return values;
}

/** The same per day: the campaign's page views, and each source's page views and unique visitors */
export function campaignDays(visits: CampaignVisits): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [source, days] of Object.entries(visits.days)) {
    for (const [d, v] of Object.entries(days)) {
      const of = (out[d] ??= { views: 0 });
      of.views = (of.views ?? 0) + v.views;
      of[`views_${source}`] = v.views;
      of[`visitors_${source}`] = v.visitors;
    }
  }
  return out;
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
  const recent = await registry.launches.recent(500);
  const launches = recent.filter((l) => l.status === 'published');
  const piecesOf = new Map<number, Post[]>();
  for (const launch of launches) piecesOf.set(launch.id, await registry.posts.posts(launch.id));
  // Which pieces have numbers is the channel's (readsMetrics), a story's only while it lasts. A
  // deleted piece answers nothing but not found; its last numbers stay as they were
  const readable = (post: Post) => readsMetrics(post.channel, post.kind, { publishedAt: post.publishedAt, now }) && post.externalId !== null && post.status !== 'deleted';

  // The push-only channels first: every change they tell is kept, and a piece they said nothing
  // about has its last numbers read again
  for (const [channel, reader] of Object.entries(sources.posts ?? {})) {
    if (!reader?.pushed) continue;
    const pushed = reader.pushed.bind(reader);
    const targets = await pushedTargets(registry, recent, piecesOf, channel, readable);
    if (targets.length === 0) continue;
    await attempt(channel, async () => {
      const told = await readPushed(pushed, targets, (launchId, values, postId) => record(launchId, channel, values, postId));
      for (const t of targets) {
        const kept = told.has(t.postId) ? undefined : await keptMetrics(registry, t.postId);
        if (kept) await record(t.launchId, channel, kept, t.postId);
      }
    });
  }

  // The channels that read in batches are read first, all their pieces at once
  const batched = new Map<string, Map<string, Metrics>>();
  for (const [channel, reader] of Object.entries(sources.posts ?? {})) {
    if (!reader?.metricsMany || reader.pushed) continue;
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
      if (!reader || !readable(post) || reader.pushed) continue;
      if (reader.metricsMany) {
        // Read in the batch above; a piece the answer left out is gone, and a failed batch was said once
        const values = batched.get(post.channel)?.get(post.externalId!);
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
          await record(launch.id, 'blog', blogValues(visits));
        });
      }
      if (sources.search) {
        await attempt(`${launch.repo} ${launch.ref} search`, async () => {
          const found = await Promise.all(urls.map(({ url }) => sources.search!.pageMetrics(url, since, until)));
          await record(launch.id, 'search', searchValues(found));
        });
        const inspect = sources.search.inspect?.bind(sources.search);
        if (inspect) {
          await attempt(`${launch.repo} ${launch.ref} index status`, async () => {
            const statuses = await Promise.all(urls.map(async ({ url }) => ({ url, status: await inspect(url) })));
            for (const { url, status } of statuses) await registry.cursors.setCursor(indexStatusKey(url), JSON.stringify({ ...status, checkedAt: now.toISOString() }));
            await noteCanonicals(registry, launch.id, statuses);
            await record(launch.id, 'search', { indexed: statuses.filter((s) => s.status.indexed).length });
            unindexed ||= statuses.some((s) => !s.status.indexed);
          });
        }
      }
      if (sources.bing) {
        const bing = sources.bing;
        await attempt(`${launch.repo} ${launch.ref} Bing`, async () => {
          const found = await Promise.all(urls.map(({ url }) => bing.pageMetrics(url)));
          const values = searchValues(found);
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
  await readFurtherRepos(launches, sources, attempt, record);
  // An article Google still lacks is the one case where asking it to read the sitemap again helps
  if (unindexed && sources.search) await attempt('sitemap', async () => void (await resubmitSitemap(registry, brand.site, sources.search!, now)));
  return { readings, problems };
}

const HOUR_MS = 3_600_000;
/** A run starts on the cron's minute and takes a while: a check this much short of the cadence is due */
const DUE_SLACK_MS = 10 * 60_000;
/** When a repo's traffic was last read (or answered 404); a refused read leaves it, so the next hour asks again */
export const trafficReadKey = (repo: string) => `metrics-read:github-traffic:${repo}`;
/** When a repo's stars by day and releases' downloads were last read */
export const historyReadKey = (repo: string) => `metrics-read:github-history:${repo}`;
/** The problems of a source the owner has to fix (a permission), by source and what it was about; the bell lists them */
export const METRIC_PROBLEM_PREFIX = 'metrics-problem:';
/** Why GitHub refused a repo's traffic with a 403 (a permission), kept until it is read again */
export const trafficProblemKey = (repo: string) => `${METRIC_PROBLEM_PREFIX}github-traffic:${repo}`;

/**
 * A repo's traffic as readings: the 14-day totals as before, and the top referring sites and pages
 * with their unique visitors. Its days are kept apart, under each day (trafficDays).
 */
export function trafficReadings(t: RepoTraffic): Record<string, number> {
  const out: Record<string, number> = { views: t.views, uniqueVisitors: t.uniqueVisitors, clones: t.clones, uniqueCloners: t.uniqueCloners };
  for (const r of t.referrers) Object.assign(out, { [`referrer:${r.name}`]: r.count, [`referrer_visitors:${r.name}`]: r.uniques });
  for (const p of t.paths) Object.assign(out, { [`path:${p.name}`]: p.count, [`path_visitors:${p.name}`]: p.uniques });
  return out;
}

/** A repo's traffic per day, for `metric_days`: views and clones, and each day's unique visitors and cloners */
export function trafficDays(t: RepoTraffic): Record<string, Record<string, number>> {
  return Object.fromEntries(t.days.map((d) => [d.day, { views: d.views, visitors: d.uniqueVisitors, clones: d.clones, cloners: d.uniqueCloners }]));
}

/** The stars given each day, for `metric_days` */
export const starDays = (h: RepoHistory): Record<string, Record<string, number>> => Object.fromEntries(Object.entries(h.starsByDay).map(([day, stars]) => [day, { stars }]));

/**
 * A repo's history as one launch's readings: the downloads of the launch's own release when its ref
 * is one, and of every release together. Its stars by day are kept apart (starDays).
 */
export function historyReadings(h: RepoHistory, ref: string): Record<string, number> {
  const out: Record<string, number> = {};
  const own = h.downloadsByTag[ref];
  if (own !== undefined) out.downloads = own;
  out.downloads_total = Object.values(h.downloadsByTag).reduce((n, d) => n + d, 0);
  return out;
}

/** When a channel's analytics were last asked for, answered or not (a connection without the permission answers nothing) */
export const analyticsReadKey = (channel: string) => `metrics-read:analytics:${channel}`;
/** The pieces a channel's last analytics read did not reach (a rate limit), as a JSON list of network ids */
export const analyticsPendingKey = (channel: string) => `metrics-read:analytics-pending:${channel}`;

/** The pending ids a cursor keeps; undefined for none, or for a value that is not a list of ids */
function pendingIds(value: string | undefined): Set<string> | undefined {
  if (!value) return undefined;
  try {
    const ids: unknown = JSON.parse(value);
    return Array.isArray(ids) && ids.length > 0 ? new Set(ids.filter((id): id is string => typeof id === 'string')) : undefined;
  } catch {
    return undefined;
  }
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
  // A source's days, each under the day it happened (docs/decisions/dated-metrics.md)
  const recordDays = (launchId: number, source: string, days: Record<string, Record<string, number>>) => registry.metrics.recordDays(launchId, source, days, now);
  const attempt = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const due = (last: string | undefined, hours: number) => last === undefined || now.getTime() - Date.parse(last) >= hours * HOUR_MS - DUE_SLACK_MS;

  const recent = await registry.launches.recent(500);
  const launches = recent.filter((l) => l.status === 'published');
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
    if (reader.pushed) {
      // Every piece, due or not: a change read is confirmed, so one not kept now is lost. Silence
      // moves the check of a due piece that has numbers; a piece never told about stays unread
      const pushed = reader.pushed.bind(reader);
      const targets = await pushedTargets(registry, recent, piecesOf, channel, readable);
      if (targets.length === 0) continue;
      await attempt(channel, async () => {
        const told = await readPushed(pushed, targets, (launchId, values, postId) => record(launchId, channel, values, postId));
        for (const t of targets) {
          if (told.has(t.postId) || !due(checked.get(`p:${t.postId}`), hours)) continue;
          const kept = await keptMetrics(registry, t.postId);
          if (kept) await record(t.launchId, channel, kept, t.postId);
        }
      });
      continue;
    }
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
          const values = answer.get(t.postId);
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

  // Each channel's analytics, on their own cadence: every live piece at once. Asked for once a cadence
  // whether answered or not, so a connection without the permission is said once a day, not hourly.
  // The pieces a network did not reach (a rate limit) are asked for again the next hour, alone
  for (const [channel, reader] of Object.entries(sources.posts ?? {})) {
    const cadence = channelAnalyticsCadence(channel);
    if (!reader?.analytics || !cadence) continue;
    const isDue = due(await registry.cursors.cursor(analyticsReadKey(channel)), cadence.hours);
    const pending = isDue ? undefined : pendingIds(await registry.cursors.cursor(analyticsPendingKey(channel)));
    if (!isDue && !pending) continue;
    const targets = launches
      .flatMap((launch) =>
        (piecesOf.get(launch.id) ?? []).filter((p) => p.channel === channel && readable(p)).map((p) => ({ postId: p.id, launchId: launch.id, id: p.externalId!, since: launch.createdAt.slice(0, 10) })),
      )
      .filter((t) => !pending || pending.has(t.id));
    if (targets.length === 0) {
      if (pending) await registry.cursors.deleteCursor(analyticsPendingKey(channel));
      continue;
    }
    const analytics = reader.analytics.bind(reader);
    await attempt(`${channel} analytics`, async () => {
      if (isDue) await registry.cursors.setCursor(analyticsReadKey(channel), now.toISOString());
      let answer: AnalyticsMany;
      try {
        answer = await analytics(targets.map(({ id, since }) => ({ id, since })), until);
      } catch (error) {
        // Nothing read: the whole set waits for the next cadence, not for an hourly retry of a refusal
        await registry.cursors.deleteCursor(analyticsPendingKey(channel));
        throw error;
      }
      for (const t of targets) {
        const values = answer.get(t.id);
        if (values) await record(t.launchId, channel, values, t.postId);
      }
      for (const problem of answer.problems ?? []) problems.push(`${channel} analytics: ${problem}`);
      if (answer.unread && answer.unread.length > 0) await registry.cursors.setCursor(analyticsPendingKey(channel), JSON.stringify(answer.unread));
      else if (pending || isDue) await registry.cursors.deleteCursor(analyticsPendingKey(channel));
    });
  }

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
      await record(site.launch.id, 'blog', blogValues(visits));
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
    // The same paths day by day, from each launch's day: every day read again, so an older day the
    // source rescaled takes its newest estimate
    if (blog.pageVisitsByDay) {
      const paths = [...new Set(blogDue.flatMap((s) => s.urls.map(({ url }) => new URL(url).pathname)))];
      const since = blogDue.map((s) => s.since).reduce((a, b) => (b < a ? b : a));
      await attempt('blog visits by day', async () => {
        const byDay = await blog.pageVisitsByDay!(paths, since, until);
        for (const site of blogDue) await recordDays(site.launch.id, 'blog', sumDays(site.urls.map(({ url }) => byDay.get(new URL(url).pathname) ?? {})));
      });
    }
  }

  // The blog's visits from each launch's tagged links, by its campaign: every published launch has
  // one, article or not, since its posts link to the site wherever the launch's pages are
  const umami = sources.umami;
  if (umami) {
    for (const launch of launches) {
      if (!siteDue(launch.id, 'umami', 'views', SITE_CADENCES.umami.hours)) continue;
      await attempt(`${launch.repo} ${launch.ref} Umami`, async () => {
        const visits = await umami.campaignVisits(campaignOf(launch), launch.createdAt.slice(0, 10), until);
        await record(launch.id, 'umami', campaignValues(visits));
        await recordDays(launch.id, 'umami', campaignDays(visits));
      });
    }
  }

  let unindexed = false;
  for (const { launch, urls, since } of sites) {
    const search = sources.search;
    if (search && siteDue(launch.id, 'search', 'clicks', SITE_CADENCES.searchAnalytics.hours)) {
      await attempt(`${launch.repo} ${launch.ref} search`, async () => {
        const byDay = search.pageMetricsByDay?.bind(search);
        if (!byDay) {
          const found = await Promise.all(urls.map(({ url }) => search.pageMetrics(url, since, until)));
          await record(launch.id, 'search', searchValues(found));
          return;
        }
        // Day by day: the launch's totals are its days', and each day is kept under the day searched
        const pages = await Promise.all(urls.map(({ url }) => byDay(url, since, until)));
        await record(launch.id, 'search', searchValues(pages.map(daysTotal)));
        await recordDays(launch.id, 'search', sumDays(pages.map((days) => Object.fromEntries(days.map((d) => [d.day, { clicks: d.clicks, impressions: d.impressions }])))));
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
        const statusOf = new Map<string, IndexStatus>([...known.flatMap((k) => (k.status ? [[k.url, k.status] as const] : [])), ...fresh.map((f) => [f.url, f.status] as const)]);
        await noteCanonicals(registry, launch.id, [...statusOf].map(([url, status]) => ({ url, status })));
        await record(launch.id, 'search', { indexed: [...statusOf.values()].filter((s) => s.indexed).length });
        unindexed ||= fresh.some((f) => !f.status.indexed);
      });
    }
    const bing = sources.bing;
    if (bing && siteDue(launch.id, 'bing', 'clicks', SITE_CADENCES.bing.hours)) {
      await attempt(`${launch.repo} ${launch.ref} Bing`, async () => {
        const found = await Promise.all(urls.map(({ url }) => bing.pageMetrics(url)));
        const values = searchValues(found);
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
        // A failure is said as itself. Only a 403 (the App without Administration: read on the repo)
        // is kept for the bell, which words it as that permission, and leaves the cursor, so the next
        // hour asks again once the owner grants it. A 404 (the repo renamed, deleted or out of the
        // App's reach) moves the cursor, so it is asked again on the traffic's cadence, not hourly
        await attempt(`${repo} GitHub traffic`, async () => {
          let traffic: RepoTraffic;
          try {
            traffic = await split.traffic(repo);
          } catch (error) {
            if (error instanceof ConnectorError && error.status === 403) await registry.cursors.setCursor(trafficProblemKey(repo), error.message);
            if (error instanceof ConnectorError && error.status === 404) await registry.cursors.setCursor(trafficReadKey(repo), now.toISOString());
            throw error;
          }
          await registry.cursors.setCursor(trafficReadKey(repo), now.toISOString());
          await registry.cursors.deleteCursor(trafficProblemKey(repo));
          for (const id of ids) {
            await record(id, 'github', trafficReadings(traffic));
            await recordDays(id, 'github', trafficDays(traffic));
          }
        });
      }
      if (due(await registry.cursors.cursor(historyReadKey(repo)), SITE_CADENCES.githubHistory.hours)) {
        await attempt(`${repo} GitHub stars and downloads`, async () => {
          const history = await split.history(repo);
          await registry.cursors.setCursor(historyReadKey(repo), now.toISOString());
          for (const l of of) {
            await record(l.id, 'github', historyReadings(history, l.ref));
            await recordDays(l.id, 'github', starDays(history));
          }
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
  await readFurtherRepos(launches, sources, attempt, record, (id, source) => siteDue(id, source, 'stars', SITE_CADENCES.githubCounts.hours));
  if (unindexed && sources.search) await attempt('sitemap', async () => void (await resubmitSitemap(registry, brand.site, sources.search!, now)));
  return { readings, problems };
}
