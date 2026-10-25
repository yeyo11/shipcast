import { InvalidInput } from './input.ts';

/*
 * What a view of the Stats page is: its period, metric, grouping, chart, comparison, filters and the
 * ranking's sort and page. It lives in the address (TanStack Router's search params), so a view can
 * be shared or bookmarked, and the same shape is what the page's server function receives. Two
 * readings of it: the address is read leniently (a value that is not valid falls back to the
 * default, so an old or hand-edited link still opens), the server function strictly (anything not
 * valid is refused, since only the page sends it). No server imports: the route uses it in the browser.
 */

export const METRICS = ['views', 'reactions', 'comments', 'shares', 'clicks', 'impressions'] as const;
export const PERIODS = ['7d', '30d', '90d', 'custom'] as const;
export const GROUPS = ['channel', 'account', 'launch'] as const;
export const KINDS = ['line', 'area', 'bar'] as const;
export const BUCKETS = ['day', 'week'] as const;
export const RANK_BY = ['post', 'launch', 'account'] as const;
export const SORTS = ['score', ...METRICS] as const;

export type Metric = (typeof METRICS)[number];
export type Period = (typeof PERIODS)[number];
export type GroupBy = (typeof GROUPS)[number];
export type Kind = (typeof KINDS)[number];
export type Bucket = (typeof BUCKETS)[number];
export type RankBy = (typeof RANK_BY)[number];
export type Sort = (typeof SORTS)[number];

export interface StatsSearch {
  period: Period;
  /** Days, YYYY-MM-DD, only with a custom period */
  from?: string;
  to?: string;
  metric: Metric;
  groupBy: GroupBy;
  chart: Kind;
  bucket: Bucket;
  compare: boolean;
  channels?: string[];
  accounts?: number[];
  rank: RankBy;
  sort: Sort;
  order: 'desc' | 'asc';
  page: number;
}

export const DEFAULTS: StatsSearch = { period: '30d', metric: 'views', groupBy: 'channel', chart: 'line', bucket: 'day', compare: false, rank: 'post', sort: 'score', order: 'desc', page: 1 };

/** The longest custom period, two years: past that a chart of weeks gets too dense to read */
export const MAX_DAYS = 731;
/** Past this many days a period is charted in weeks whatever the address says: 120 bars of days stop being readable */
export const DAYS_LIMIT = 120;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHANNEL = /^[a-z][\w-]{0,39}$/;
const DAY_MS = 86_400_000;

export const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** A list from the address: an array as the router writes it, or comma-separated as a person would type it */
function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(',').filter((s) => s !== '');
  if (typeof value === 'number') return [value];
  return [];
}

/** The address read leniently: what is valid is kept, the rest is the default; defaults are left out so links stay short */
export function readStatsSearch(raw: Record<string, unknown>): Partial<StatsSearch> {
  const out: Partial<StatsSearch> = {};
  const period = pick(raw.period, PERIODS);
  if (period === 'custom' && isDay(raw.from) && isDay(raw.to) && raw.from <= raw.to && daysBetween(raw.from, raw.to) <= MAX_DAYS) {
    Object.assign(out, { period, from: raw.from, to: raw.to });
  } else if (period && period !== 'custom') out.period = period;
  const metric = pick(raw.metric, METRICS);
  if (metric) out.metric = metric;
  const groupBy = pick(raw.groupBy, GROUPS);
  if (groupBy) out.groupBy = groupBy;
  const chart = pick(raw.chart, KINDS);
  if (chart) out.chart = chart;
  const bucket = pick(raw.bucket, BUCKETS);
  if (bucket) out.bucket = bucket;
  if (raw.compare === true || raw.compare === 'true' || raw.compare === '1') out.compare = true;
  const channels = [...new Set(items(raw.channels).filter((c): c is string => typeof c === 'string' && CHANNEL.test(c)))].slice(0, 30);
  if (channels.length > 0) out.channels = channels;
  const accounts = [...new Set(items(raw.accounts).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 2 ** 31))].slice(0, 50);
  if (accounts.length > 0) out.accounts = accounts;
  const rank = pick(raw.rank, RANK_BY);
  if (rank) out.rank = rank;
  const sort = pick(raw.sort, SORTS);
  if (sort) out.sort = sort;
  if (raw.order === 'asc') out.order = 'asc';
  const page = Number(raw.page);
  if (Number.isInteger(page) && page > 1 && page <= 10_000) out.page = page;
  return out;
}

/** The address with its defaults filled in: what the page works with */
export const withDefaults = (search: Partial<StatsSearch>): StatsSearch => ({ ...DEFAULTS, ...search });

/** The period's days, both included; `today` is the server's UTC day */
export function resolvePeriod(search: Pick<StatsSearch, 'period' | 'from' | 'to'>, today: string): { from: string; to: string; days: number } {
  if (search.period === 'custom' && search.from && search.to) return { from: search.from, to: search.to, days: daysBetween(search.from, search.to) };
  const days = search.period === '7d' ? 7 : search.period === '90d' ? 90 : 30;
  return { from: addDays(today, -(days - 1)), to: today, days };
}

/** Days unless the address asks for weeks, and weeks whatever it asks past DAYS_LIMIT */
export const effectiveBucket = (bucket: Bucket, days: number): Bucket => (days > DAYS_LIMIT ? 'week' : bucket);

/**
 * The server function's reading: the same shape, every field checked, nothing guessed. A field left
 * out is the default; a field that is there and not valid is an InvalidInput naming it.
 */
export function parseStatsInput(input: unknown): StatsSearch {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidInput('the view must be an object');
  const o = input as Record<string, unknown>;
  const one = <T extends string>(name: string, allowed: readonly T[], fallback: T): T => {
    const value = o[name];
    if (value === undefined) return fallback;
    const ok = pick(value, allowed);
    if (!ok) throw new InvalidInput(`${name} is one of ${allowed.join(', ')}`);
    return ok;
  };
  const period = one('period', PERIODS, DEFAULTS.period);
  let from: string | undefined;
  let to: string | undefined;
  if (period === 'custom') {
    if (!isDay(o.from) || !isDay(o.to)) throw new InvalidInput('a custom period needs from and to as days, YYYY-MM-DD');
    if (o.to < o.from) throw new InvalidInput('to comes after from');
    if (daysBetween(o.from, o.to) > MAX_DAYS) throw new InvalidInput(`a period is at most ${MAX_DAYS} days`);
    from = o.from;
    to = o.to;
  } else if (o.from !== undefined || o.to !== undefined) throw new InvalidInput('from and to go with a custom period only');
  if (o.compare !== undefined && typeof o.compare !== 'boolean') throw new InvalidInput('compare is true or false');
  const list = <T>(name: string, max: number, check: (v: unknown) => v is T): T[] | undefined => {
    const value = o[name];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > max) throw new InvalidInput(`${name} is a list of at most ${max}`);
    for (const v of value) if (!check(v)) throw new InvalidInput(`${name} has an item that is not valid`);
    return value.length > 0 ? [...new Set(value as T[])] : undefined;
  };
  const channels = list('channels', 30, (v): v is string => typeof v === 'string' && CHANNEL.test(v));
  const accounts = list('accounts', 50, (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 2 ** 31);
  const page = o.page === undefined ? 1 : o.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10_000) throw new InvalidInput('page is an integer from 1');
  return {
    period,
    ...(from && to && { from, to }),
    metric: one('metric', METRICS, DEFAULTS.metric),
    groupBy: one('groupBy', GROUPS, DEFAULTS.groupBy),
    chart: one('chart', KINDS, DEFAULTS.chart),
    bucket: one('bucket', BUCKETS, DEFAULTS.bucket),
    compare: o.compare === true,
    ...(channels && { channels }),
    ...(accounts && { accounts }),
    rank: one('rank', RANK_BY, DEFAULTS.rank),
    sort: one('sort', SORTS, DEFAULTS.sort),
    order: one('order', ['desc', 'asc'] as const, DEFAULTS.order),
    page,
  };
}

/** The account-growth section's period: two days, the page's own */
export function parseGrowthInput(input: unknown): { from: string; to: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidInput('the period must be an object');
  const { from, to } = input as Record<string, unknown>;
  if (!isDay(from) || !isDay(to)) throw new InvalidInput('from and to are days, YYYY-MM-DD');
  if (to < from) throw new InvalidInput('to comes after from');
  if (daysBetween(from, to) > MAX_DAYS) throw new InvalidInput(`a period is at most ${MAX_DAYS} days`);
  return { from, to };
}

/** The view as the address keeps it: only what differs from the defaults, so the default view is plain `/stats` */
export function compactSearch(search: StatsSearch): Partial<StatsSearch> {
  const out: Partial<StatsSearch> = {};
  for (const key of Object.keys(search) as Array<keyof StatsSearch>) {
    const value = search[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    if (key === 'from' || key === 'to') {
      if (search.period !== 'custom') continue;
    } else if (key !== 'channels' && key !== 'accounts' && value === DEFAULTS[key]) continue;
    Object.assign(out, { [key]: value });
  }
  return out;
}
