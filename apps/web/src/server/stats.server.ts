import {
  accountGrowth,
  articleUrls,
  DETAIL_METRICS,
  indexStatus,
  METRIC_FAMILIES,
  previousWindow,
  statsOverview,
  statsRanking,
  statsSeries,
  statsWindow,
  type AverageMetric,
  type DetailMetric,
  type MetricTotals,
  type Repositories,
  type SeriesGroup,
  type SeriesGroupBy,
  type StatsMetric,
  STATS_METRICS,
} from '@shipcast/engine';
import { isStale, lastSynced, network } from '@shipcast/runtime';
import { effectiveBucket, resolvePeriod, type StatsSearch } from './stats-search.ts';
import { CHANNEL_NAMES } from './view.ts';
import { accountAvatar } from './pieces.ts';

/*
 * What the Stats page shows, read from the engine's stats queries in the app's own process
 * (packages/engine/src/stats.ts, docs/stats.md). Takes the registry rather than the app's context,
 * so the tests run it on PGlite; stats.functions.ts is the thin server-function layer over it.
 */

/** How many series a chart shows one by one: the palette's slots and the ink (components/charts/palette.ts) */
const SERIES_LIMIT = 8;
export const PAGE_SIZE = 10;
/** The ranking is sorted by any column here, so it is read whole up to this many entries */
const RANKING_CAP = 1000;
/** How many launches the chart marks at most: the newest; more would be a row of "+N" */
const MARK_LIMIT = 20;
/** The launches offered as a filter, newest first: only a published launch has numbers */
const LAUNCH_OPTIONS = 500;

/** Networks whose accounts publish pieces that have numbers; the rest (search consoles, the CDN) have no stats to filter by */
const MEASURED_NETWORKS = new Set([...Object.keys(METRIC_FAMILIES), 'brevo']);

/** An account's network as a channel: Brevo sends the newsletter */
export const channelOfNetwork = (network: string) => (network === 'brevo' ? 'newsletter' : network);

export interface ChartGroup {
  key: string;
  label: string;
  /** The channel the series belongs to, for its colour: a channel, or an account's network */
  channel: string | null;
  /** The account or launch id, so a colour can follow it */
  id: number | null;
  total: number;
  values: number[];
  comparison: number[] | null;
  /** How many groups an "other" series adds up */
  groups?: number;
}

export interface StatsView {
  search: StatsSearch;
  period: { from: string; to: string; days: number; bucket: 'day' | 'week' };
  comparePeriod: { from: string; to: string } | null;
  totals: { metrics: MetricTotals; previous: MetricTotals | null; lifetime: MetricTotals };
  /**
   * The second tier, each family the sources picked count: what grew in the period, against the
   * previous one when comparing, and its lifetime, with each channel's part
   */
  details: Array<{ metric: DetailMetric; value: number; previous: number | null; lifetime: number; channels: Array<{ channel: string; label: string; value: number; lifetime: number }> }>;
  /** The averages and ratios as the period ends, by source: never added up */
  averages: Array<{ source: string; label: string; metric: AverageMetric; value: number; pieces: number }>;
  chart: { buckets: string[]; groups: ChartGroup[] };
  /** The launch that did best in the period (by score), with the charted number and the day it went out */
  best: { launchId: number; title: string; name: string; ref: string | null; value: number; publishedOn: string | null } | null;
  /** The launches that went out in the period, by the day of their first live piece: the chart's marks */
  marks: Array<{ launchId: number; title: string; day: string }>;
  /** The three most popular pieces of the period, by score: the desktop's "Top this period" */
  top: RankedEntry[];
  ranking: {
    total: number;
    page: number;
    pages: number;
    entries: RankedEntry[];
  };
  options: {
    channels: Array<{ value: string; label: string }>;
    accounts: Array<{ value: string; label: string; hint: string }>;
    launches: Array<{ value: string; label: string; hint: string }>;
  };
}

export interface RankedEntry {
  rank: number;
  score: number;
  metrics: MetricTotals;
  lifetime: MetricTotals;
  pieces: number;
  channel: string | null;
  launchId: number | null;
  postId: number | null;
  accountId: number | null;
  label: string;
  /** The launch's own name (its title, or the project and its tag) for a piece or a launch; the account for an account */
  title: string;
  /** What the piece's network calls each family ("likes", "favourites", "reposts"), where it names it */
  words: Partial<Record<StatsMetric, string>>;
  url: string | null;
  kind: string | null;
  /** The day a piece went out: what tells two pieces of one launch on one channel apart */
  publishedOn: string | null;
}

/** What a network calls a family: the first of its raw counters ("likes" for Bluesky's reactions) */
export function familyWords(channel: string | null): Partial<Record<StatsMetric, string>> {
  const families = channel ? METRIC_FAMILIES[channel] : undefined;
  if (!families) return {};
  const out: Partial<Record<StatsMetric, string>> = {};
  for (const [family, raw] of Object.entries(families)) {
    const first = raw?.[0];
    if (first && (STATS_METRICS as readonly string[]).includes(family)) out[family as StatsMetric] = first.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  }
  return out;
}

/** A launch's name as the owner reads it: its title, an article's slug in words, or the project and its tag */
export function launchTitle(launch: { repo: string; ref: string }, title: string | null | undefined): { title: string; name: string; ref: string | null } {
  if (title) return { title, name: title, ref: null };
  if (launch.ref.startsWith('article:')) {
    const words = launch.ref.slice('article:'.length).replace(/-/g, ' ');
    const text = words.charAt(0).toUpperCase() + words.slice(1);
    return { title: text, name: text, ref: null };
  }
  const name = launch.repo.split('/')[1] ?? launch.repo;
  return { title: `${name} ${launch.ref}`, name, ref: launch.ref };
}

/** The day of a launch's first live piece: where the chart marks it went out */
async function firstPublished(registry: Pick<Repositories, 'posts'>, launchId: number): Promise<string | null> {
  const days = (await registry.posts.posts(launchId))
    .filter((p) => p.status === 'live' || p.status === 'edited')
    .map((p) => p.publishedAt.slice(0, 10))
    .sort();
  return days[0] ?? null;
}

/** The day the first published launch was made: where "all" starts */
const firstLaunchDay = (launches: ReadonlyArray<{ status: string; createdAt: string }>): string | undefined =>
  launches.reduce<string | undefined>((first, l) => (l.status === 'published' && (first === undefined || l.createdAt.slice(0, 10) < first) ? l.createdAt.slice(0, 10) : first), undefined);

const lastDay = (iso: string) => new Date(Date.parse(iso) - 1).toISOString().slice(0, 10);

export async function loadStats(registry: Pick<Repositories, 'launches' | 'accounts' | 'posts' | 'queries'>, search: StatsSearch, today = new Date().toISOString().slice(0, 10)): Promise<StatsView> {
  const [accounts, launches] = await Promise.all([registry.accounts.accounts(), registry.launches.recent(LAUNCH_OPTIONS)]);
  const period = resolvePeriod(search, today, firstLaunchDay(launches));
  const bucket = effectiveBucket(search.bucket, period.days);
  const filters = {
    ...(search.channels && { channels: search.channels }),
    ...(search.accounts && { accounts: search.accounts }),
    ...(search.launches && { launches: search.launches }),
  };
  const previous = search.compare ? previousWindow(statsWindow(period.from, period.to)) : null;
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  // The total is every channel's line added up: read by channel with room for all of them
  const total = search.groupBy === 'total';
  const groupBy: SeriesGroupBy = search.groupBy === 'total' ? 'channel' : search.groupBy;
  const seriesLimit = total ? 50 : SERIES_LIMIT;

  const [overview, series, before, ranking, bestLaunch] = await Promise.all([
    // The totals always carry the previous period: each number says how it moved (the board's KPIs)
    statsOverview(registry, { from: period.from, to: period.to, ...filters, compareTo: 'previous' as const }),
    statsSeries(registry, { metric: search.metric, groupBy, from: period.from, to: period.to, bucket, limit: seriesLimit, ...filters }),
    // The previous period with room for every group, so a series that was small then still finds its line
    previous ? statsSeries(registry, { metric: search.metric, groupBy, from: previous.from, to: previous.to, bucket, limit: 50, ...filters }) : null,
    statsRanking(registry, { by: search.rank, from: period.from, to: period.to, limit: 100, ...filters }).then(async (first) => {
      const entries = [...first.entries];
      for (let next = first.next; next !== null && entries.length < RANKING_CAP; ) {
        const more = await statsRanking(registry, { by: search.rank, from: period.from, to: period.to, limit: 100, offset: next, ...filters });
        entries.push(...more.entries);
        next = more.next;
      }
      return entries;
    }),
    statsRanking(registry, { by: 'launch', from: period.from, to: period.to, limit: 1, ...filters }).then((r) => r.entries[0] ?? null),
  ]);

  const previousByKey = new Map<string, SeriesGroup>((before ? [...before.groups, ...(before.other ? [before.other] : [])] : []).map((g) => [g.key, g]));
  const toGroup = (g: SeriesGroup, extra: { groups?: number } = {}): ChartGroup => {
    const id = groupBy === 'channel' || g.key === 'other' || g.key === 'none' ? null : Number(g.key);
    const account = groupBy === 'account' && id !== null ? accountById.get(id) : undefined;
    const channel = groupBy === 'channel' ? g.key : account ? channelOfNetwork(account.network) : null;
    const was = previousByKey.get(g.key);
    return {
      key: g.key,
      label: groupBy === 'channel' ? (CHANNEL_NAMES[g.key] ?? g.label) : g.key === 'other' ? `${extra.groups ?? 0} more` : g.label,
      channel,
      id,
      total: g.total,
      values: g.points.map((p) => p.increase),
      // Laid over by position: both periods have the same length and the same bucket size
      comparison: before ? before.buckets.map((_, i) => was?.points[i]?.increase ?? 0) : null,
      ...extra,
    };
  };
  // A series that stayed at zero is a flat line on the axis that only crowds the legend
  const moving = series.groups.filter((g) => g.total > 0);
  let groups = (moving.length > 0 ? moving : series.groups).map((g) => toGroup(g));
  if (series.other) groups.push(toGroup(series.other, { groups: series.other.groups }));
  if (total) groups = groups.length > 0 ? [sumGroups(groups, series.buckets.length)] : [];

  // The launches named on the page, by their own titles: one read each, only for the few shown
  const launchById = new Map(launches.map((l) => [l.id, l]));
  const titleCache = new Map<number, Promise<string | null>>();
  const titleOf = (id: number) => {
    if (!titleCache.has(id)) titleCache.set(id, registry.launches.modelFields(id).then((f) => f?.title ?? null));
    return titleCache.get(id)!;
  };
  const postsCache = new Map<number, Promise<Map<number, string>>>();
  const postDay = async (launchId: number, postId: number) => {
    if (!postsCache.has(launchId)) postsCache.set(launchId, registry.posts.posts(launchId).then((ps) => new Map(ps.map((p) => [p.id, p.publishedAt.slice(0, 10)]))));
    return (await postsCache.get(launchId)!).get(postId) ?? null;
  };
  const named = async (e: Omit<RankedEntry, 'title' | 'words' | 'rank' | 'publishedOn'> & { rank?: number }, rank: number): Promise<RankedEntry> => {
    const launch = e.launchId !== null ? launchById.get(e.launchId) : undefined;
    const account = e.accountId !== null ? accountById.get(e.accountId) : undefined;
    const title = launch ? launchTitle(launch, await titleOf(launch.id)).title : account ? account.label : e.label;
    const publishedOn = e.launchId !== null && e.postId !== null ? await postDay(e.launchId, e.postId) : null;
    return { ...e, rank, title, words: familyWords(e.channel), publishedOn };
  };

  const sorted = sortRanking(ranking, search.sort, search.order);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(search.page, pages);
  const topPieces = search.rank === 'post' ? sortRanking(ranking, 'score', 'desc').slice(0, 3) : (await statsRanking(registry, { by: 'post', from: period.from, to: period.to, limit: 3, ...filters })).entries;
  // A launch can only have gone out in the period if it was made before its end; the newest few are enough to mark
  const candidates = launches.filter((l) => l.status === 'published' && l.createdAt.slice(0, 10) <= period.to).slice(0, MARK_LIMIT);
  const [entries, top, best, marks] = await Promise.all([
    Promise.all(sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((e, i) => named(e, (page - 1) * PAGE_SIZE + i + 1))),
    Promise.all(topPieces.map((e, i) => named(e, i + 1))),
    (async () => {
      const launch = bestLaunch?.launchId != null ? launchById.get(bestLaunch.launchId) : undefined;
      if (!bestLaunch || !launch) return null;
      const [title, publishedOn] = await Promise.all([titleOf(launch.id), firstPublished(registry, launch.id)]);
      return { launchId: launch.id, ...launchTitle(launch, title), value: bestLaunch.metrics[search.metric] ?? 0, publishedOn };
    })(),
    Promise.all(
      candidates.map(async (l) => {
        const [title, day] = await Promise.all([titleOf(l.id), firstPublished(registry, l.id)]);
        return day && day >= period.from && day <= period.to ? [{ launchId: l.id, title: launchTitle(l, title).title, day }] : [];
      }),
    ).then((found) => found.flat().sort((a, b) => a.day.localeCompare(b.day))),
  ]);

  return {
    search,
    period: { ...period, bucket },
    comparePeriod: previous ? { from: previous.from.slice(0, 10), to: lastDay(previous.to) } : null,
    totals: { metrics: overview.metrics, previous: overview.previous ?? null, lifetime: overview.lifetime },
    details: DETAIL_METRICS.flatMap((metric) => {
      const value = overview.metrics[metric];
      if (value === undefined) return [];
      const channels = overview.channels.flatMap((c) =>
        c.metrics[metric] === undefined ? [] : [{ channel: c.channel, label: CHANNEL_NAMES[c.channel] ?? c.channel, value: c.metrics[metric] ?? 0, lifetime: c.lifetime[metric] ?? 0 }],
      );
      return [{ metric, value, previous: overview.previous?.[metric] ?? null, lifetime: overview.lifetime[metric] ?? 0, channels }];
    }),
    averages: overview.averages.map((a) => ({ ...a, label: CHANNEL_NAMES[a.source] ?? a.source })),
    chart: { buckets: series.buckets, groups },
    best,
    marks,
    top,
    ranking: { total: sorted.length, page, pages, entries },
    options: {
      // The channels there is something to count on: an account's network, the blog, and any already picked
      channels: Object.keys(METRIC_FAMILIES)
        .filter((c) => c === 'blog' || accounts.some((a) => channelOfNetwork(a.network) === c) || search.channels?.includes(c))
        .map((c) => ({ value: c, label: CHANNEL_NAMES[c] ?? c })),
      accounts: accounts
        .filter((a) => MEASURED_NETWORKS.has(a.network))
        .map((a) => {
          const network = CHANNEL_NAMES[channelOfNetwork(a.network)] ?? a.network;
          return { value: String(a.id), label: a.label, hint: network, group: network };
        }),
      // Grouped by project in the filter's list, so a project's many releases sit together
      launches: launches.filter((l) => l.status === 'published').map((l) => ({ value: String(l.id), label: `${l.repo} ${l.ref}`, hint: l.createdAt.slice(0, 10), group: l.repo })),
    },
  };
}

/** Every series added up, bucket by bucket: the chart's Total line */
export function sumGroups(groups: readonly ChartGroup[], length: number): ChartGroup {
  const add = (pick: (g: ChartGroup) => readonly number[] | null) => Array.from({ length }, (_, i) => groups.reduce((sum, g) => sum + (pick(g)?.[i] ?? 0), 0));
  const comparing = groups.some((g) => g.comparison !== null);
  return { key: 'total', label: 'Total', channel: null, id: null, total: groups.reduce((sum, g) => sum + g.total, 0), values: add((g) => g.values), comparison: comparing ? add((g) => g.comparison) : null };
}

/**
 * The ranking by the column asked for. The engine ranks by score; any other column is a raw number,
 * sorted here over the whole ranking (never just the page, which would sort the wrong rows), the
 * score breaking ties so equal numbers keep the popularity order.
 */
export function sortRanking<E extends { score: number; metrics: MetricTotals }>(entries: readonly E[], sort: 'score' | StatsMetric, order: 'asc' | 'desc'): E[] {
  const value = (e: E) => (sort === 'score' ? e.score : (e.metrics[sort] ?? -1));
  const sign = order === 'asc' ? 1 : -1;
  return [...entries].sort((a, b) => sign * (value(a) - value(b)) || b.score - a.score);
}

export interface GrowthView {
  from: string;
  to: string;
  accounts: Array<{
    id: number;
    label: string;
    network: string;
    networkName: string;
    channel: string;
    avatarUrl: string | null;
    syncedAt: string | null;
    stale: boolean;
    /** Its credential failed its last check: the numbers stop until it is connected again */
    failing: boolean;
    latest: { followers: number | null; following: number | null; posts: number | null } | null;
    change: { followers: number | null; following: number | null; posts: number | null };
    points: Array<{ day: string; followers: number | null; following: number | null; posts: number | null }>;
  }>;
}

/**
 * Every account with numbers to grow: its daily snapshots over the page's period, its latest
 * numbers and how fresh they are (the same "last synced" and staleness as the Channels page).
 * Accounts on networks that count nothing (a webhook, a search console) have no snapshots and are
 * left out.
 */
export async function loadGrowth(registry: Pick<Repositories, 'accounts' | 'queries'>, range: { from: string; to: string }, now = new Date()): Promise<GrowthView> {
  const [accounts, latest] = await Promise.all([registry.accounts.accounts(), registry.accounts.lastSnapshots()]);
  // Only accounts with an audience (a channel's network): the sources of numbers (search consoles,
  // Bing, Cloudflare, Umami, GitHub's profile) have no followers to grow and live under Channels
  const measured = accounts.filter((a) => latest.has(a.id) && network(a.network)?.channel !== undefined);
  const growth = await Promise.all(measured.map((a) => accountGrowth(registry, a.id, range)));
  return {
    ...range,
    accounts: measured.map((a, i) => {
      const snapshot = latest.get(a.id);
      const syncedAt = lastSynced(a, snapshot?.takenAt);
      const g = growth[i]!;
      return {
        id: a.id,
        label: a.label,
        network: a.network,
        /** The network's name for the page ("LinkedIn"), never its connector key */
        networkName: CHANNEL_NAMES[channelOfNetwork(a.network)] ?? network(a.network)?.name ?? a.network,
        channel: channelOfNetwork(a.network),
        avatarUrl: accountAvatar(a),
        syncedAt,
        stale: isStale(syncedAt, now),
        failing: a.status === 'failed',
        latest: snapshot ? { followers: snapshot.followers ?? null, following: snapshot.following ?? null, posts: snapshot.posts ?? null } : null,
        change: g.change,
        points: g.points.map((p) => ({ day: p.day, followers: p.followers, following: p.following, posts: p.posts })),
      };
    }),
  };
}

/** What one search engine says of one page: null until the engine has been read for it */
export interface IndexView {
  indexed: boolean;
  /** The engine's own words ("Submitted and indexed", "Crawled on 2026-10-20") */
  coverage: string;
  checkedAt: string;
}

/** One engine's numbers of a launch: the period's growth, and the lifetime the engine's own report shows */
export interface EngineNumbers {
  impressions: number;
  clicks: number;
  lifetime: { impressions: number; clicks: number };
}

export interface SearchView {
  from: string;
  to: string;
  launches: Array<{
    id: number;
    label: string;
    /** The launch's own name (its title, or the project and its tag) */
    title: string;
    /** The day its article went out; null for a launch that published no article (nothing to index) */
    publishedOn: string | null;
    /** What grew in the period per engine, and where it stood at the period's end; null when the engine has no reading for the launch */
    google: EngineNumbers | null;
    bing: EngineNumbers | null;
    pages: Array<{ lang: string; url: string; google: IndexView | null; bing: IndexView | null }>;
  }>;
}

/** The launches whose articles are looked up: one query per launch, so a long history is cut here */
const SEARCH_LAUNCHES = 100;

/**
 * The blog's articles in search engines: each published launch's article pages, what Google and
 * Bing last said of each (docs/search-indexing.md; the same reading as a launch's page), and the
 * impressions and clicks each engine counted for the launch in the period. The engines count a
 * launch's pages together, so the numbers are per launch, not per page.
 */
export async function loadSearch(registry: Pick<Repositories, 'launches' | 'posts' | 'accounts' | 'cursors' | 'queries'>, range: { from: string; to: string; launches?: readonly number[] }): Promise<SearchView> {
  const wanted = range.launches ? new Set(range.launches) : null;
  const published = (await registry.launches.recent(LAUNCH_OPTIONS)).filter((l) => l.status === 'published' && (!wanted || wanted.has(l.id))).slice(0, SEARCH_LAUNCHES);
  const read = async (url: string, engine: 'google' | 'bing'): Promise<IndexView | null> => {
    const status = await indexStatus(registry, url, engine);
    return status ? { indexed: status.indexed, coverage: status.coverage, checkedAt: status.checkedAt } : null;
  };
  const launches = await Promise.all(
    published.map(async (l) => {
      const [articles, title] = await Promise.all([registry.posts.posts(l.id, { channel: 'blog' }), registry.launches.modelFields(l.id).then((f) => f?.title ?? null)]);
      const urls = articleUrls(articles);
      const named = { id: l.id, label: `${l.repo} ${l.ref}`, title: launchTitle(l, title).title };
      // A launch without an article stays on the list: there is simply nothing of it to index
      if (urls.length === 0) return { ...named, publishedOn: null, google: null, bing: null, pages: [] };
      const publishedOn = articles.map((a) => a.publishedAt.slice(0, 10)).sort()[0] ?? null;
      const [pages, overview] = await Promise.all([
        Promise.all(urls.map(async ({ lang, url }) => ({ lang, url, google: await read(url, 'google'), bing: await read(url, 'bing') }))),
        statsOverview(registry, { from: range.from, to: range.to, channels: ['search', 'bing'], launches: [l.id] }),
      ]);
      const engine = (source: string) => {
        const found = overview.channels.find((c) => c.channel === source);
        return found
          ? { impressions: found.metrics.impressions ?? 0, clicks: found.metrics.clicks ?? 0, lifetime: { impressions: found.lifetime.impressions ?? 0, clicks: found.lifetime.clicks ?? 0 } }
          : null;
      };
      return { ...named, publishedOn, google: engine('search'), bing: engine('bing'), pages };
    }),
  );
  return { from: range.from, to: range.to, launches };
}
