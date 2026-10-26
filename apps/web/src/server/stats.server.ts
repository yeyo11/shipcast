import {
  accountGrowth,
  articleUrls,
  indexStatus,
  METRIC_FAMILIES,
  previousWindow,
  statsOverview,
  statsRanking,
  statsSeries,
  statsWindow,
  type MetricTotals,
  type Registry,
  type SeriesGroup,
  type StatsMetric,
} from '@shipcast/engine';
import { isStale, lastSynced } from '@shipcast/runtime';
import { effectiveBucket, resolvePeriod, type StatsSearch } from './stats-search.ts';
import { CHANNEL_NAMES } from './view.ts';

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
  totals: { metrics: MetricTotals; previous: MetricTotals | null };
  chart: { buckets: string[]; groups: ChartGroup[] };
  ranking: {
    total: number;
    page: number;
    pages: number;
    entries: Array<{
      rank: number;
      score: number;
      metrics: MetricTotals;
      pieces: number;
      channel: string | null;
      launchId: number | null;
      postId: number | null;
      accountId: number | null;
      label: string;
      url: string | null;
      kind: string | null;
    }>;
  };
  options: {
    channels: Array<{ value: string; label: string }>;
    accounts: Array<{ value: string; label: string; hint: string }>;
    launches: Array<{ value: string; label: string; hint: string }>;
  };
}

/** The day the first published launch was made: where "all" starts */
const firstPublished = (launches: ReadonlyArray<{ status: string; createdAt: string }>): string | undefined =>
  launches.reduce<string | undefined>((first, l) => (l.status === 'published' && (first === undefined || l.createdAt.slice(0, 10) < first) ? l.createdAt.slice(0, 10) : first), undefined);

const lastDay = (iso: string) => new Date(Date.parse(iso) - 1).toISOString().slice(0, 10);

export async function loadStats(registry: Registry, search: StatsSearch, today = new Date().toISOString().slice(0, 10)): Promise<StatsView> {
  const [accounts, launches] = await Promise.all([registry.accounts(), registry.recent(LAUNCH_OPTIONS)]);
  const period = resolvePeriod(search, today, firstPublished(launches));
  const bucket = effectiveBucket(search.bucket, period.days);
  const filters = {
    ...(search.channels && { channels: search.channels }),
    ...(search.accounts && { accounts: search.accounts }),
    ...(search.launches && { launches: search.launches }),
  };
  const previous = search.compare ? previousWindow(statsWindow(period.from, period.to)) : null;
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const [overview, series, before, ranking] = await Promise.all([
    statsOverview(registry, { from: period.from, to: period.to, ...filters, ...(search.compare && { compareTo: 'previous' as const }) }),
    statsSeries(registry, { metric: search.metric, groupBy: search.groupBy, from: period.from, to: period.to, bucket, limit: SERIES_LIMIT, ...filters }),
    // The previous period with room for every group, so a series that was small then still finds its line
    previous ? statsSeries(registry, { metric: search.metric, groupBy: search.groupBy, from: previous.from, to: previous.to, bucket, limit: 50, ...filters }) : null,
    statsRanking(registry, { by: search.rank, from: period.from, to: period.to, limit: 100, ...filters }).then(async (first) => {
      const entries = [...first.entries];
      for (let next = first.next; next !== null && entries.length < RANKING_CAP; ) {
        const more = await statsRanking(registry, { by: search.rank, from: period.from, to: period.to, limit: 100, offset: next, ...filters });
        entries.push(...more.entries);
        next = more.next;
      }
      return entries;
    }),
  ]);

  const previousByKey = new Map<string, SeriesGroup>((before ? [...before.groups, ...(before.other ? [before.other] : [])] : []).map((g) => [g.key, g]));
  const toGroup = (g: SeriesGroup, extra: { groups?: number } = {}): ChartGroup => {
    const id = search.groupBy === 'channel' || g.key === 'other' || g.key === 'none' ? null : Number(g.key);
    const account = search.groupBy === 'account' && id !== null ? accountById.get(id) : undefined;
    const channel = search.groupBy === 'channel' ? g.key : account ? channelOfNetwork(account.network) : null;
    const was = previousByKey.get(g.key);
    return {
      key: g.key,
      label: search.groupBy === 'channel' ? (CHANNEL_NAMES[g.key] ?? g.label) : g.key === 'other' ? `${extra.groups ?? 0} more` : g.label,
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
  const groups = (moving.length > 0 ? moving : series.groups).map((g) => toGroup(g));
  if (series.other) groups.push(toGroup(series.other, { groups: series.other.groups }));

  const sorted = sortRanking(ranking, search.sort, search.order);
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(search.page, pages);

  return {
    search,
    period: { ...period, bucket },
    comparePeriod: previous ? { from: previous.from.slice(0, 10), to: lastDay(previous.to) } : null,
    totals: { metrics: overview.metrics, previous: overview.previous ?? null },
    chart: { buckets: series.buckets, groups },
    ranking: {
      total: sorted.length,
      page,
      pages,
      entries: sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((e, i) => ({ ...e, rank: (page - 1) * PAGE_SIZE + i + 1 })),
    },
    options: {
      channels: Object.keys(METRIC_FAMILIES).map((c) => ({ value: c, label: CHANNEL_NAMES[c] ?? c })),
      accounts: accounts
        .filter((a) => MEASURED_NETWORKS.has(a.network))
        .map((a) => ({ value: String(a.id), label: a.label, hint: CHANNEL_NAMES[channelOfNetwork(a.network)] ?? a.network })),
      launches: launches.filter((l) => l.status === 'published').map((l) => ({ value: String(l.id), label: `${l.repo} ${l.ref}`, hint: l.createdAt.slice(0, 10) })),
    },
  };
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
    channel: string;
    avatarUrl: string | null;
    syncedAt: string | null;
    stale: boolean;
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
export async function loadGrowth(registry: Registry, range: { from: string; to: string }, now = new Date()): Promise<GrowthView> {
  const [accounts, latest] = await Promise.all([registry.accounts(), registry.lastSnapshots()]);
  const measured = accounts.filter((a) => latest.has(a.id));
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
        channel: channelOfNetwork(a.network),
        avatarUrl: a.avatarUrl,
        syncedAt,
        stale: isStale(syncedAt, now),
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

export interface SearchView {
  from: string;
  to: string;
  launches: Array<{
    id: number;
    label: string;
    /** What grew in the period, per engine; null when the engine has no reading for the launch */
    google: { impressions: number; clicks: number } | null;
    bing: { impressions: number; clicks: number } | null;
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
export async function loadSearch(registry: Registry, range: { from: string; to: string; launches?: readonly number[] }): Promise<SearchView> {
  const wanted = range.launches ? new Set(range.launches) : null;
  const published = (await registry.recent(LAUNCH_OPTIONS)).filter((l) => l.status === 'published' && (!wanted || wanted.has(l.id))).slice(0, SEARCH_LAUNCHES);
  const read = async (url: string, engine: 'google' | 'bing'): Promise<IndexView | null> => {
    const status = await indexStatus(registry, url, engine);
    return status ? { indexed: status.indexed, coverage: status.coverage, checkedAt: status.checkedAt } : null;
  };
  const launches = await Promise.all(
    published.map(async (l) => {
      const urls = articleUrls(await registry.posts(l.id, { channel: 'blog' }));
      if (urls.length === 0) return null;
      const [pages, overview] = await Promise.all([
        Promise.all(urls.map(async ({ lang, url }) => ({ lang, url, google: await read(url, 'google'), bing: await read(url, 'bing') }))),
        statsOverview(registry, { from: range.from, to: range.to, channels: ['search', 'bing'], launches: [l.id] }),
      ]);
      const engine = (source: string) => {
        const found = overview.channels.find((c) => c.channel === source);
        return found ? { impressions: found.metrics.impressions ?? 0, clicks: found.metrics.clicks ?? 0 } : null;
      };
      return { id: l.id, label: `${l.repo} ${l.ref}`, google: engine('search'), bing: engine('bing'), pages };
    }),
  );
  return { from: range.from, to: range.to, launches: launches.filter((l) => l !== null) };
}
