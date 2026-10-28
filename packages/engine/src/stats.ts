import { sql, type SQL } from 'drizzle-orm';
import { CHANNEL_METRIC_FAMILIES, STATS_METRICS, type StatsMetric } from '@shipcast/schema';
import type { Registry } from './registry.ts';

/*
 * The stats section's queries: totals per channel and account with a comparison period, time
 * series for the charts, a ranking by popularity normalised per network, and an account's growth.
 * See docs/stats.md for the model and the formula.
 *
 * Readings are cumulative counters (a post's likes so far, a blog article's visits since the
 * launch), read every round. What happened in a period is therefore a difference of readings, never
 * a sum of them, and every query here reads the history up to the end of its period to find where
 * each counter stood when the period began.
 */

/** The families every network's numbers are folded into, so a chart can put networks side by side */
export { STATS_METRICS, type StatsMetric };
export type MetricTotals = Partial<Record<StatsMetric, number>>;

/**
 * Which readings of each source make up each family; a reading left out (Instagram's `saved`, the
 * newsletter's bounces, the blog's per-source split) is not a stat. GitHub's views are left out on
 * purpose: they are a rolling 14-day count, not a counter, and the high-water mark would misread them.
 */
export const METRIC_FAMILIES: Readonly<Record<string, Partial<Record<StatsMetric, readonly string[]>>>> = {
  // Each channel's, from its definition
  ...CHANNEL_METRIC_FAMILIES,
  search: { clicks: ['clicks'], impressions: ['impressions'] },
  bing: { clicks: ['clicks'], impressions: ['impressions'] },
  github: { reactions: ['stars'], shares: ['forks'] },
};

/** The families popularity is scored on; impressions say how often something was shown, not that anyone cared */
export const POPULARITY_METRICS: readonly StatsMetric[] = ['views', 'reactions', 'comments', 'shares', 'clicks'];

/** Sources read for a launch as a whole rather than for one of its pieces */
export const SITE_SOURCES = ['blog', 'search', 'bing', 'github'] as const;

/** What a query is narrowed to; a filter left out is everything */
export interface StatsFilter {
  channels?: readonly string[];
  accounts?: readonly number[];
  launches?: readonly number[];
}

/** A period: `from` included, `to` excluded, both ISO 8601 in UTC with milliseconds, as readings are stamped */
export interface StatsWindow {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A period from what a client sends: whole UTC days (`2026-10-01` to `2026-10-31`, both days
 * included) or timestamps (`from` included, `to` excluded). Throws a RangeError for anything else.
 */
export function statsWindow(from: string, to: string): StatsWindow {
  const start = DATE.test(from) ? Date.parse(`${from}T00:00:00Z`) : Date.parse(from);
  const end = DATE.test(to) ? Date.parse(`${to}T00:00:00Z`) + DAY_MS : Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new RangeError('from and to are dates (YYYY-MM-DD) or ISO 8601 timestamps');
  if (end <= start) throw new RangeError('to comes after from');
  return { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
}

/** The period of the same length just before, what "compared with the previous period" means */
export function previousWindow(window: StatsWindow): StatsWindow {
  const length = Date.parse(window.to) - Date.parse(window.from);
  return { from: new Date(Date.parse(window.from) - length).toISOString(), to: window.from };
}

const values = (items: readonly (string | number)[]) => sql.join(
  items.map((item) => sql`${item}`),
  sql`, `,
);

/** `column IN (…)`, or false for an empty list, which SQL cannot write */
const inList = (column: SQL, items: readonly (string | number)[]) => (items.length === 0 ? sql`false` : sql`${column} IN (${values(items)})`);

const familyPairs = (only?: StatsMetric) =>
  Object.entries(METRIC_FAMILIES).flatMap(([source, families]) =>
    Object.entries(families).flatMap(([family, names]) => (only === undefined || family === only ? names.map((name) => ({ source, name, family: family as StatsMetric })) : [])),
  );

const familyOf = new Map(familyPairs().map((p) => [`${p.source}.${p.name}`, p.family]));

/**
 * The counters a query reads, as `fam` and `c` CTEs, listed from the posts and launches rather than
 * from the readings, so each one is then read through `metrics_by_launch` (launch, source, name,
 * taken_at) instead of a pass over the whole history. A counter's unit is what it counts:
 *
 * - `p:<post>`: one piece, the usual case for a channel (a post, a newsletter issue);
 * - `l:<launch>:<source>`: a site-level source of one launch (the blog's visits, Search Console, Bing);
 * - `r:<repo>`: GitHub, whose numbers are the repo's, read again for each launch of the same repo,
 *   so they are one unit per repo, attributed to its newest launch.
 *
 * A channel's reading with no piece is left out: those are the newsletter's readings from before
 * readings pointed at their piece, each the sum of both issues, and every such launch has its issues
 * as pieces since the post model. Counting both would count the issues twice.
 */
function counterSet(filter: StatsFilter, only?: StatsMetric): SQL {
  const site = values(SITE_SOURCES);
  const pieces: SQL[] = [sql`p.channel NOT IN (${site})`, sql`(p.kind = 'post' OR p.kind LIKE 'issue:%')`];
  const launchWide: SQL[] = [sql`f.source IN (${site})`];
  if (filter.channels) {
    pieces.push(inList(sql`p.channel`, filter.channels));
    launchWide.push(inList(sql`f.source`, filter.channels));
  }
  if (filter.launches) {
    pieces.push(inList(sql`p.launch_id`, filter.launches));
    launchWide.push(inList(sql`l.id`, filter.launches));
  }
  if (filter.accounts) {
    pieces.push(inList(sql`p.account_id`, filter.accounts));
    // No account publishes the site-level numbers
    launchWide.push(sql`false`);
  }
  return sql`
    fam(source, name) AS (VALUES ${sql.join(
      familyPairs(only).map((p) => sql`(${p.source}::text, ${p.name}::text)`),
      sql`, `,
    )}),
    c AS (
      SELECT 'p:' || p.id AS unit, p.launch_id, p.id AS post_id, p.channel AS source, f.name, p.account_id
      FROM posts p JOIN fam f ON f.source = p.channel
      WHERE ${sql.join(pieces, sql` AND `)}
      UNION ALL
      SELECT CASE WHEN f.source = 'github' THEN 'r:' || l.repo ELSE 'l:' || l.id || ':' || f.source END, l.id, NULL, f.source, f.name, NULL
      FROM launches l CROSS JOIN fam f
      WHERE ${sql.join(launchWide, sql` AND `)}
    )`;
}

/** A counter's readings, for a LATERAL join from `c` that the (launch, source, name, taken_at) index answers */
const ofCounter = sql`m.launch_id = c.launch_id AND m.source = c.source AND m.name = c.name AND m.post_id IS NOT DISTINCT FROM c.post_id`;

interface CounterRow {
  unit: string;
  source: string;
  name: string;
  launchId: number;
  postId: number | null;
  accountId: number | null;
  /** The increase in each window asked, in order */
  increase: number[];
  /** Readings taken inside each window */
  readings: number[];
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * Every counter's increase in each window. Where a counter stood when a window began is its last
 * reading before it, or zero for a piece that had none yet (pieces start at zero when they go out);
 * GitHub's repo had its stars before Shipcast watched it, so its first reading is where it stood. The
 * increase is the highest reading in the window above that, never below zero: a dip (an unlike, a
 * network recounting) takes nothing away, and a reading missed is caught up by the next one.
 */
async function counters(registry: Registry, windows: readonly StatsWindow[], filter: StatsFilter): Promise<CounterRow[]> {
  const joins = windows.map((w, i) => {
    const [b, x, f] = [`b${i}`, `x${i}`, `f${i}`].map((name) => sql.raw(name)) as [SQL, SQL, SQL];
    return sql`
      LEFT JOIN LATERAL (SELECT m.taken_at, m.value FROM metrics m WHERE ${ofCounter} AND m.taken_at < ${w.from} ORDER BY m.taken_at DESC LIMIT 1) ${b} ON true
      LEFT JOIN LATERAL (SELECT max(m.value) AS hi, count(*) AS n FROM metrics m WHERE ${ofCounter} AND m.taken_at >= ${w.from} AND m.taken_at < ${w.to}) ${x} ON true
      LEFT JOIN LATERAL (
        SELECT m.taken_at, m.value FROM metrics m
        WHERE c.source = 'github' AND ${ofCounter} AND m.taken_at >= ${w.from} AND m.taken_at < ${w.to} ORDER BY m.taken_at LIMIT 1
      ) ${f} ON true`;
  });
  const columns = windows.map((_, i) =>
    // A repo's launches are counters of one unit: its start is the latest reading before the window
    // among them, its first reading the earliest in it
    sql.raw(
      `,
      (array_agg(b#.value ORDER BY b#.taken_at DESC NULLS LAST))[1]::float8 AS base#,
      max(x#.hi)::float8 AS hi#,
      sum(x#.n)::int AS n#,
      (array_agg(f#.value ORDER BY f#.taken_at NULLS LAST))[1]::float8 AS first#`.replaceAll('#', String(i)),
    ),
  );
  const rows = await registry.selectRows<Record<string, unknown>>(sql`
    WITH ${counterSet(filter)}
    SELECT c.unit, c.source, c.name, max(c.launch_id)::int AS launch_id, max(c.post_id)::int AS post_id, max(c.account_id)::int AS account_id
      ${sql.join(columns, sql``)}
    FROM c ${sql.join(joins, sql``)}
    GROUP BY c.unit, c.source, c.name`);
  return rows.flatMap((row) => {
    const readings = windows.map((_, i) => num(row[`n${i}`]));
    const started = windows.some((_, i) => numOrNull(row[`base${i}`]) !== null);
    // A counter never read up to the end of the windows is not there at all
    if (!started && readings.every((n) => n === 0)) return [];
    const source = String(row.source);
    return [
      {
        unit: String(row.unit),
        source,
        name: String(row.name),
        launchId: num(row.launch_id),
        postId: numOrNull(row.post_id),
        accountId: numOrNull(row.account_id),
        increase: windows.map((_, i) => {
          const hi = numOrNull(row[`hi${i}`]);
          if (hi === null) return 0;
          const start = numOrNull(row[`base${i}`]) ?? (source === 'github' ? num(row[`first${i}`]) : 0);
          return Math.max(0, hi - start);
        }),
        readings,
      },
    ];
  });
}

/** The families a source counts, so a channel shows a zero where it counts and nothing where it does not */
const familiesOf = (source: string) => Object.keys(METRIC_FAMILIES[source] ?? {}) as StatsMetric[];

function add(totals: MetricTotals, family: StatsMetric, value: number) {
  totals[family] = (totals[family] ?? 0) + value;
}

function emptyFor(sources: Iterable<string>): MetricTotals {
  const totals: MetricTotals = {};
  for (const source of sources) for (const family of familiesOf(source)) totals[family] = 0;
  return totals;
}

export interface Delta {
  absolute: number;
  /** The change as a fraction of the previous period; null when it started from zero */
  relative: number | null;
}

function deltas(current: MetricTotals, previous: MetricTotals): Partial<Record<StatsMetric, Delta>> {
  const out: Partial<Record<StatsMetric, Delta>> = {};
  for (const family of STATS_METRICS) {
    const now = current[family];
    if (now === undefined) continue;
    const before = previous[family] ?? 0;
    out[family] = { absolute: now - before, relative: before === 0 ? null : (now - before) / before };
  }
  return out;
}

export interface StatsBreakdown {
  metrics: MetricTotals;
  previous?: MetricTotals;
  delta?: Partial<Record<StatsMetric, Delta>>;
}

export interface ChannelStats extends StatsBreakdown {
  channel: string;
}

export interface AccountStats extends StatsBreakdown {
  accountId: number;
  network: string | null;
  label: string | null;
}

export interface StatsOverview extends StatsBreakdown {
  window: StatsWindow;
  compareTo?: StatsWindow;
  channels: ChannelStats[];
  /** Only what an account published; the blog and the site-level sources have no account */
  accounts: AccountStats[];
}

export interface OverviewOptions extends StatsFilter {
  from: string;
  to: string;
  /** Another period to compare with: `previous` is the same length just before */
  compareTo?: StatsWindow | 'previous';
}

/** Totals per channel and per account in a period, and against another period when asked */
export async function statsOverview(registry: Registry, options: OverviewOptions): Promise<StatsOverview> {
  const window = statsWindow(options.from, options.to);
  const compareTo = options.compareTo === 'previous' ? previousWindow(window) : options.compareTo;
  const windows = compareTo ? [window, compareTo] : [window];
  const rows = await counters(registry, windows, options);

  type Acc = { sources: Set<string>; current: MetricTotals; previous: MetricTotals };
  const fresh = (): Acc => ({ sources: new Set(), current: {}, previous: {} });
  const all = fresh();
  const byChannel = new Map<string, Acc>();
  const byAccount = new Map<number, Acc>();
  for (const row of rows) {
    const family = familyOf.get(`${row.source}.${row.name}`);
    if (!family) continue;
    const targets = [all, byChannel.get(row.source) ?? byChannel.set(row.source, fresh()).get(row.source)!];
    if (row.accountId !== null) targets.push(byAccount.get(row.accountId) ?? byAccount.set(row.accountId, fresh()).get(row.accountId)!);
    for (const acc of targets) {
      acc.sources.add(row.source);
      add(acc.current, family, row.increase[0] ?? 0);
      if (compareTo) add(acc.previous, family, row.increase[1] ?? 0);
    }
  }

  const breakdown = (acc: Acc): StatsBreakdown => {
    const metrics = { ...emptyFor(acc.sources), ...acc.current };
    if (!compareTo) return { metrics };
    const previous = { ...emptyFor(acc.sources), ...acc.previous };
    return { metrics, previous, delta: deltas(metrics, previous) };
  };
  const accounts = new Map((await registry.accounts()).map((a) => [a.id, a]));
  return {
    window,
    ...(compareTo && { compareTo }),
    ...breakdown(all),
    channels: [...byChannel].map(([channel, acc]) => ({ channel, ...breakdown(acc) })).sort((a, b) => a.channel.localeCompare(b.channel)),
    accounts: [...byAccount]
      .map(([accountId, acc]) => ({ accountId, network: accounts.get(accountId)?.network ?? null, label: accounts.get(accountId)?.label ?? null, ...breakdown(acc) }))
      .sort((a, b) => (a.network ?? '').localeCompare(b.network ?? '') || a.accountId - b.accountId),
  };
}

/** `launchChannel` keys a series `<launch id>:<channel>`: each launch's channels apart, in one query for a list of launches */
export type SeriesGroupBy = 'channel' | 'account' | 'launch' | 'launchChannel';
export type SeriesBucket = 'day' | 'week';

export interface SeriesPoint {
  /** The bucket's first day, YYYY-MM-DD (a Monday for weeks) */
  bucket: string;
  /** How much the metric grew in the bucket */
  increase: number;
  /** Where it stood at the bucket's end: everything before the period plus the increases so far */
  cumulative: number;
}

export interface SeriesGroup {
  /** The channel, the account id or the launch id, as text; `none` for what no account published */
  key: string;
  label: string;
  /** The increase over the whole period, what the groups are ordered by */
  total: number;
  /** Where it stood when the period began */
  baseline: number;
  points: SeriesPoint[];
}

export interface StatsSeries {
  metric: StatsMetric;
  groupBy: SeriesGroupBy;
  bucket: SeriesBucket;
  window: StatsWindow;
  buckets: string[];
  groups: SeriesGroup[];
  /** The groups past `limit`, added up, so a chart's stack still adds up to the whole */
  other: (SeriesGroup & { groups: number }) | null;
}

export interface SeriesOptions extends StatsFilter {
  metric: StatsMetric;
  groupBy: SeriesGroupBy;
  from: string;
  to: string;
  bucket: SeriesBucket;
  /** How many groups come one by one, the largest first; 10 unless said */
  limit?: number;
}

/** The most buckets one series returns, a little over a year of days */
export const MAX_BUCKETS = 400;

const dayOf = (iso: string) => iso.slice(0, 10);

function bucketStart(day: string, bucket: SeriesBucket): string {
  if (bucket === 'day') return day;
  const date = new Date(`${day}T00:00:00Z`);
  // getUTCDay is 0 for Sunday; ISO weeks start on Monday
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return dayOf(date.toISOString());
}

/** The buckets a period covers, the first one holding `from` and the last one before `to` */
export function bucketsOf(window: StatsWindow, bucket: SeriesBucket): string[] {
  const out: string[] = [];
  const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS;
  const last = new Date(Date.parse(window.to) - 1).toISOString();
  for (let at = Date.parse(`${bucketStart(dayOf(window.from), bucket)}T00:00:00Z`); at <= Date.parse(last); at += step) {
    if (out.length >= MAX_BUCKETS) throw new RangeError(`a series has at most ${MAX_BUCKETS} buckets; ask for a shorter period or weeks`);
    out.push(dayOf(new Date(at).toISOString()));
  }
  return out;
}

/**
 * A metric over time, one series per channel, account or launch: the increase in each bucket and
 * the running total. A counter starts the period where its last reading before it stood (see
 * counters); where it stands at a bucket's end is its highest reading since, so a bucket's increase
 * never goes below zero, a day with no reading shows no growth and the next reading carries what
 * happened in between. Only the period's readings are read, plus one per counter before it.
 */
export async function statsSeries(registry: Registry, options: SeriesOptions): Promise<StatsSeries> {
  const window = statsWindow(options.from, options.to);
  const buckets = bucketsOf(window, options.bucket);
  const limit = options.limit ?? 10;
  const day = sql`left(taken_at, 10)`;
  const bucketOf = options.bucket === 'day' ? day : sql`to_char(${day}::date - (extract(isodow FROM ${day}::date)::int - 1), 'YYYY-MM-DD')`;
  const key =
    options.groupBy === 'channel'
      ? sql`u.source`
      : options.groupBy === 'account'
        ? sql`coalesce(u.account_id::text, 'none')`
        : options.groupBy === 'launchChannel'
          ? sql`u.launch_id::text || ':' || u.source`
          : sql`u.launch_id::text`;
  const rows = await registry.selectRows<{ key: string; bucket: string | null; increase: number }>(sql`
    WITH ${counterSet(options, options.metric)},
    w AS (
      SELECT c.unit, c.name, m.taken_at, m.value FROM c
      JOIN LATERAL (SELECT m.taken_at, m.value FROM metrics m WHERE ${ofCounter} AND m.taken_at >= ${window.from} AND m.taken_at < ${window.to}) m ON true
    ),
    base AS (
      SELECT c.unit, c.name, m.taken_at, m.value FROM c
      JOIN LATERAL (SELECT m.taken_at, m.value FROM metrics m WHERE ${ofCounter} AND m.taken_at < ${window.from} ORDER BY m.taken_at DESC LIMIT 1) m ON true
    ),
    start AS (
      -- A repo's launches are counters of one unit: it starts at the latest reading among them
      SELECT DISTINCT ON (unit, name) unit, name, value FROM base ORDER BY unit, name, taken_at DESC
    ),
    repo_first AS (
      SELECT DISTINCT ON (unit, name) unit, name, value FROM w WHERE unit LIKE 'r:%' ORDER BY unit, name, taken_at
    ),
    readings AS (
      SELECT unit, name, NULL::text AS bucket, value FROM start
      UNION ALL
      -- A repo first seen in the period starts at its first reading: its stars predate Shipcast
      SELECT f.unit, f.name, NULL, f.value FROM repo_first f WHERE NOT EXISTS (SELECT 1 FROM start s WHERE s.unit = f.unit AND s.name = f.name)
      UNION ALL
      SELECT unit, name, ${bucketOf}, value FROM w
    ),
    b AS (SELECT unit, name, bucket, max(value) AS hi FROM readings GROUP BY unit, name, bucket),
    hw AS (SELECT unit, name, bucket, max(hi) OVER (PARTITION BY unit, name ORDER BY bucket NULLS FIRST ROWS UNBOUNDED PRECEDING) AS hw FROM b),
    inc AS (SELECT unit, bucket, hw - coalesce(lag(hw) OVER (PARTITION BY unit, name ORDER BY bucket NULLS FIRST), 0) AS increase FROM hw),
    u AS (SELECT unit, max(source) AS source, max(launch_id) AS launch_id, max(account_id) AS account_id FROM c GROUP BY unit)
    SELECT ${key} AS key, i.bucket, sum(i.increase)::float8 AS increase
    FROM inc i JOIN u ON u.unit = i.unit
    GROUP BY 1, 2`);

  const byKey = new Map<string, { baseline: number; increases: Map<string, number> }>();
  for (const row of rows) {
    const entry = byKey.get(row.key) ?? byKey.set(row.key, { baseline: 0, increases: new Map() }).get(row.key)!;
    if (row.bucket === null) entry.baseline += num(row.increase);
    else entry.increases.set(row.bucket, (entry.increases.get(row.bucket) ?? 0) + num(row.increase));
  }

  const labels = await groupLabels(registry, options.groupBy, [...byKey.keys()]);
  const series = (key: string, label: string, baseline: number, increases: Map<string, number>): SeriesGroup => {
    let cumulative = baseline;
    const points = buckets.map((bucket) => {
      const increase = increases.get(bucket) ?? 0;
      cumulative += increase;
      return { bucket, increase, cumulative };
    });
    return { key, label, total: cumulative - baseline, baseline, points };
  };
  const groups = [...byKey]
    .map(([key, entry]) => series(key, labels.get(key) ?? key, entry.baseline, entry.increases))
    .sort((a, b) => b.total - a.total || b.baseline - a.baseline || a.key.localeCompare(b.key));
  const rest = groups.slice(limit);
  let other: StatsSeries['other'] = null;
  if (rest.length > 0) {
    const increases = new Map<string, number>();
    for (const group of rest) for (const point of group.points) increases.set(point.bucket, (increases.get(point.bucket) ?? 0) + point.increase);
    other = { ...series('other', 'Other', rest.reduce((n, g) => n + g.baseline, 0), increases), groups: rest.length };
  }
  return { metric: options.metric, groupBy: options.groupBy, bucket: options.bucket, window, buckets, groups: groups.slice(0, limit), other };
}

/** What a group is called on a chart, read in one query per kind rather than one per group */
async function groupLabels(registry: Registry, groupBy: SeriesGroupBy, keys: string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (groupBy === 'channel' || groupBy === 'launchChannel') for (const key of keys) labels.set(key, key);
  if (groupBy === 'account') {
    const accounts = new Map((await registry.accounts()).map((a) => [String(a.id), a]));
    for (const key of keys) {
      const account = accounts.get(key);
      labels.set(key, key === 'none' ? 'No account' : account ? `${account.network} ${account.label}` : `Account ${key}`);
    }
  }
  if (groupBy === 'launch') {
    const launches = await launchNames(registry, keys.map(Number));
    for (const key of keys) labels.set(key, launches.get(Number(key)) ?? `Launch ${key}`);
  }
  return labels;
}

async function launchNames(registry: Registry, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await registry.selectRows<{ id: number; repo: string; ref: string }>(sql`SELECT id, repo, ref FROM launches WHERE ${inList(sql`id`, ids)}`);
  return new Map(rows.map((r) => [Number(r.id), `${r.repo} ${r.ref}`]));
}

export type RankBy = 'post' | 'launch' | 'account';

export interface RankingEntry {
  rank: number;
  /**
   * Popularity normalised per network: 1 is the network's typical piece in the period, 2 twice that.
   * For a launch or an account, the mean of its pieces' scores.
   */
  score: number;
  /** The raw increases in the period, beside the score */
  metrics: MetricTotals;
  /** How many counted pieces it is made of */
  pieces: number;
  /** The piece's network; for an account, its network */
  channel: string | null;
  launchId: number | null;
  /** The piece, when it is one; site-level numbers (the blog's visits, search) have none */
  postId: number | null;
  accountId: number | null;
  /** `owner/name ref` for a piece or a launch; `network label` for an account */
  label: string;
  url: string | null;
  /** A piece's kind (`post`, `issue:en`…), `site` for site-level numbers, `pieces` for a channel's pieces read as one; null for a launch or an account */
  kind: string | null;
}

export interface StatsRanking {
  by: RankBy;
  window: StatsWindow;
  /** How many entries there are, across every page */
  total: number;
  entries: RankingEntry[];
  /** The offset of the next page, or null on the last one */
  next: number | null;
  /** Each network's median increase per active family in the period: the yardstick of the scores */
  medians: Record<string, MetricTotals>;
}

export interface RankingOptions extends StatsFilter {
  by: RankBy;
  from: string;
  to: string;
  /** 20 unless said */
  limit?: number;
  offset?: number;
  /** The most popular first unless `asc` */
  order?: 'asc' | 'desc';
}

// Map.groupBy is ES2024, past the lib the packages compile against
function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const members = out.get(key);
    if (members) members.push(item);
    else out.set(key, [item]);
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Pieces, launches or accounts ranked by popularity normalised per network. A piece's score is the
 * mean, over its network's active families (views, reactions, comments, shares or clicks in which
 * some piece of that network grew during the period), of (its increase + 1) / (the network's median
 * increase + 1): a like on Bluesky and a visit to dev.to are each measured against what that network
 * usually gives, so they compare. The +1 keeps a network whose typical piece got nothing from
 * dividing by zero; a family nobody grew in says nothing and would only pull every score to 1, and a
 * network with no active family has no yardstick, so its pieces are not ranked.
 */
export async function statsRanking(registry: Registry, options: RankingOptions): Promise<StatsRanking> {
  const window = statsWindow(options.from, options.to);
  const rows = await counters(registry, [window], options);

  interface Unit {
    unit: string;
    source: string;
    launchId: number;
    postId: number | null;
    accountId: number | null;
    metrics: MetricTotals;
    read: boolean;
  }
  const units = new Map<string, Unit>();
  for (const row of rows) {
    const family = familyOf.get(`${row.source}.${row.name}`);
    if (!family) continue;
    const unit = units.get(row.unit) ?? units.set(row.unit, { unit: row.unit, source: row.source, launchId: row.launchId, postId: row.postId, accountId: row.accountId, metrics: {}, read: false }).get(row.unit)!;
    add(unit.metrics, family, row.increase[0] ?? 0);
    // Only what was read in the period is ranked: a piece with no reading there says nothing of it
    unit.read ||= (row.readings[0] ?? 0) > 0;
  }
  const candidates = [...units.values()].filter((u) => u.read);

  const medians: Record<string, MetricTotals> = {};
  for (const [source, members] of groupBy(candidates, (u) => u.source)) {
    const m: MetricTotals = {};
    for (const family of familiesOf(source)) {
      const increases = members.map((u) => u.metrics[family] ?? 0);
      if (POPULARITY_METRICS.includes(family) && increases.some((x) => x > 0)) m[family] = median(increases);
    }
    if (Object.keys(m).length > 0) medians[source] = m;
  }
  const ranked = candidates.filter((u) => medians[u.source] !== undefined);
  const scoreOf = (u: Unit) => {
    const yardstick = medians[u.source] ?? {};
    const ratios = (Object.keys(yardstick) as StatsMetric[]).map((family) => ((u.metrics[family] ?? 0) + 1) / ((yardstick[family] ?? 0) + 1));
    return ratios.reduce((a, b) => a + b, 0) / ratios.length;
  };

  type Draft = Omit<RankingEntry, 'rank' | 'label' | 'url' | 'kind'> & { engagement: number; key: string };
  // The tie-break: raw engagement, impressions left out as they are from the score
  const sum = (metrics: MetricTotals) => POPULARITY_METRICS.reduce((n, family) => n + (metrics[family] ?? 0), 0);
  let drafts: Draft[];
  if (options.by === 'post') {
    drafts = ranked.map((u) => ({
      key: u.unit,
      score: scoreOf(u),
      metrics: { ...emptyFor([u.source]), ...u.metrics },
      pieces: 1,
      channel: u.source,
      launchId: u.launchId,
      postId: u.postId,
      accountId: u.accountId,
      engagement: sum(u.metrics),
    }));
  } else {
    const groups = groupBy(
      ranked.filter((u) => options.by === 'launch' || u.accountId !== null),
      (u) => (options.by === 'launch' ? u.launchId : u.accountId!),
    );
    drafts = [...groups].map(([id, members]) => {
      const metrics: MetricTotals = emptyFor(members.map((m) => m.source));
      for (const member of members) for (const [family, value] of Object.entries(member.metrics)) add(metrics, family as StatsMetric, value);
      const channels = [...new Set(members.map((m) => m.source))];
      return {
        key: String(id),
        score: members.reduce((n, m) => n + scoreOf(m), 0) / members.length,
        metrics,
        pieces: members.length,
        channel: options.by === 'account' && channels.length === 1 ? channels[0]! : null,
        launchId: options.by === 'launch' ? id : null,
        postId: null,
        accountId: options.by === 'account' ? id : null,
        engagement: sum(metrics),
      };
    });
  }

  const direction = options.order === 'asc' ? -1 : 1;
  drafts.sort((a, b) => direction * (b.score - a.score) || direction * (b.engagement - a.engagement) || a.key.localeCompare(b.key));
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const page = drafts.slice(offset, offset + limit);

  // The labels of one page only, in one query per table
  const postIds = page.flatMap((d) => (d.postId === null ? [] : [d.postId]));
  const posts = new Map(
    postIds.length === 0
      ? []
      : (await registry.selectRows<{ id: number; kind: string; url: string | null }>(sql`SELECT id, kind, url FROM posts WHERE ${inList(sql`id`, postIds)}`)).map((p) => [Number(p.id), p]),
  );
  const launches = await launchNames(registry, [...new Set(page.flatMap((d) => (d.launchId === null ? [] : [d.launchId])))]);
  const accounts = options.by === 'account' ? new Map((await registry.accounts()).map((a) => [a.id, a])) : new Map();

  const entries = page.map(({ key, engagement, ...d }, i): RankingEntry => {
    const post = d.postId === null ? undefined : posts.get(d.postId);
    const account = d.accountId === null ? undefined : accounts.get(d.accountId);
    const label =
      options.by === 'account'
        ? account
          ? `${account.network} ${account.label}`
          : `Account ${key}`
        : (d.launchId !== null && launches.get(d.launchId)) || (key.startsWith('r:') ? key.slice(2) : key);
    // A group is several pieces of one channel added up (see readings); l: and r: are site-level
    const kind = options.by !== 'post' ? null : (post?.kind ?? (key.startsWith('g:') ? 'pieces' : key.startsWith('p:') ? null : 'site'));
    return { rank: offset + i + 1, ...d, channel: d.channel ?? (account ? account.network : null), label, url: post?.url ?? null, kind };
  });
  return { by: options.by, window, total: drafts.length, entries, next: offset + limit < drafts.length ? offset + limit : null, medians };
}

export interface GrowthPoint {
  /** YYYY-MM-DD, UTC */
  day: string;
  takenAt: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  /** The change since the previous snapshot; null where either side is not counted */
  change: { followers: number | null; following: number | null; posts: number | null };
  /** Days since the previous snapshot: 1 normally, more after a day missed, null for the first one ever */
  days: number | null;
}

export interface AccountGrowth {
  accountId: number;
  from: string;
  to: string;
  points: GrowthPoint[];
  /** The change over the period: the last point against the snapshot before the period, or its first */
  change: { followers: number | null; following: number | null; posts: number | null };
}

/** The most days one growth query returns */
export const MAX_GROWTH_DAYS = 1000;

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);

/**
 * An account's followers, following and posts from its daily snapshots, `from` to `to` (days, both
 * included), with the change since the snapshot before each one, so the first day of the period
 * still has its change.
 */
export async function accountGrowth(registry: Registry, accountId: number, range: { from: string; to: string }): Promise<AccountGrowth> {
  if (!DATE.test(range.from) || !DATE.test(range.to)) throw new RangeError('from and to are days, YYYY-MM-DD');
  if (range.to < range.from) throw new RangeError('to comes after from');
  const rows = await registry.selectRows<Record<string, unknown>>(sql`
    SELECT * FROM (
      SELECT day, taken_at, followers, following, posts,
        lag(day) OVER w AS prev_day, lag(followers) OVER w AS prev_followers, lag(following) OVER w AS prev_following, lag(posts) OVER w AS prev_posts
      FROM account_snapshots
      WHERE account_id = ${accountId} AND day <= ${range.to}
      WINDOW w AS (ORDER BY day)
    ) s
    WHERE day >= ${range.from}
    ORDER BY day
    LIMIT ${MAX_GROWTH_DAYS}`);
  const points = rows.map((row): GrowthPoint => {
    const followers = numOrNull(row.followers);
    const following = numOrNull(row.following);
    const posts = numOrNull(row.posts);
    const prevDay = row.prev_day === null ? null : String(row.prev_day);
    return {
      day: String(row.day),
      takenAt: String(row.taken_at),
      followers,
      following,
      posts,
      change: { followers: diff(followers, numOrNull(row.prev_followers)), following: diff(following, numOrNull(row.prev_following)), posts: diff(posts, numOrNull(row.prev_posts)) },
      days: prevDay === null ? null : Math.round((Date.parse(`${String(row.day)}T00:00:00Z`) - Date.parse(`${prevDay}T00:00:00Z`)) / DAY_MS),
    };
  });
  const first = rows[0];
  const last = points.at(-1);
  const start = (field: 'followers' | 'following' | 'posts') => (first ? (numOrNull(first[`prev_${field}`]) ?? numOrNull(first[field])) : null);
  return {
    accountId,
    from: range.from,
    to: range.to,
    points,
    change: {
      followers: diff(last?.followers ?? null, start('followers')),
      following: diff(last?.following ?? null, start('following')),
      posts: diff(last?.posts ?? null, start('posts')),
    },
  };
}
