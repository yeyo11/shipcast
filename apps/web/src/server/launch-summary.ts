/*
 * A launch at a glance, as plain data the launch page, the launches list and the tests share: its
 * totals, its views per day since it went out, and each channel's state as one mark. Only types and
 * plain values here, so the module is safe in the browser bundle (docs/web-app.md).
 */
import { CHANNEL_NAMES } from './view.ts';

export interface Totals {
  views: number;
  reactions: number;
  comments: number;
  clicks: number;
  stars: number;
}

export const TOTAL_LABELS: ReadonlyArray<[keyof Totals, string]> = [
  ['views', 'Views'],
  ['reactions', 'Reactions'],
  ['comments', 'Comments'],
  ['clicks', 'Clicks'],
  ['stars', 'Repo stars'],
];

/** A counter's latest reading: one piece's number, or a launch-wide source's (the blog, Search Console, GitHub) */
export interface CounterReading {
  source: string;
  name: string;
  value: number;
  /** When it was last read, its value then confirmed or changed */
  checkedAt?: string;
}

/** When a total was last read: the stalest of its sources' last reads, and why it lags when its source does by design */
export interface TotalAge {
  readAt: string;
  lag?: string;
}

/**
 * The numbers whose source lags by design, whatever the cadence they are read at: a read now still
 * says the past. By source, or by `source.name` where only some of a source's numbers do.
 */
export const LAGGED: Readonly<Record<string, string>> = {
  search: 'Search Console lags 2–3 days',
  bing: 'Bing counts by day',
  'github.views': 'GitHub counts traffic by day',
  'github.clones': 'GitHub counts traffic by day',
  'youtube.shares': 'YouTube Analytics lags 48–72 h',
  'youtube.watchMinutes': 'YouTube Analytics lags 48–72 h',
  'youtube.engagedViews': 'YouTube Analytics lags 48–72 h',
  'youtube.subscribersGained': 'YouTube Analytics lags 48–72 h',
  'devto.saves': 'dev.to analytics are read daily',
};

const lagOf = (r: CounterReading) => LAGGED[`${r.source}.${r.name}`] ?? LAGGED[r.source];

/**
 * When each total was last read, as launchTotals counts them: per source its newest read, and for
 * the total the oldest of those, so "read 12 min ago" holds for every part of it. A total whose
 * readings carry no time is left out.
 */
export function totalAges(readings: readonly CounterReading[], families: Families): Partial<Record<keyof Totals, TotalAge>> {
  const bySource = new Map<keyof Totals, Map<string, string>>();
  const lags = new Map<keyof Totals, Set<string>>();
  const note = (total: keyof Totals, r: CounterReading) => {
    if (r.checkedAt === undefined) return;
    const sources = bySource.get(total) ?? bySource.set(total, new Map()).get(total)!;
    const was = sources.get(r.source);
    if (was === undefined || r.checkedAt > was) sources.set(r.source, r.checkedAt);
    const lag = lagOf(r);
    if (lag) (lags.get(total) ?? lags.set(total, new Set()).get(total)!).add(lag);
  };
  for (const r of readings) {
    if (r.source === REPO_SOURCE) {
      if (r.name === 'stars') note('stars', r);
      continue;
    }
    for (const family of ['views', 'reactions', 'comments', 'clicks'] as const) if (families[r.source]?.[family]?.includes(r.name)) note(family, r);
  }
  const out: Partial<Record<keyof Totals, TotalAge>> = {};
  for (const [total, sources] of bySource) {
    const readAt = [...sources.values()].sort()[0]!;
    const lag = [...(lags.get(total) ?? [])].join(' · ');
    out[total] = lag ? { readAt, lag } : { readAt };
  }
  return out;
}

/** How long ago, in a few words: "12 min ago", "3 h ago", "2 days ago" */
function since(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  const hours = Math.round(minutes / 60);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A total's age, as its tooltip says it: "read 12 min ago", and its lag where its source has one */
export function ageWords(age: TotalAge, now: Date = new Date()): string {
  const when = `read ${since(age.readAt, now)}`;
  return age.lag ? `${when} · ${age.lag}` : when;
}

/** When a launch's (or a channel's) numbers were last updated, and the sources overdue for their cadence */
export interface LaunchUpdated {
  /** The newest read among the totals' sources */
  readAt: string;
  /** Each source not read within its cadence and the freshness check's grace, since its oldest such read */
  overdue: Array<{ source: string; since: string }>;
}

/** The one line a card or a page says: "updated 12 min ago" */
export function updatedWords(readAt: string, now: Date = new Date()): string {
  return `updated ${since(readAt, now)}`;
}

/** What the overdue mark's tooltip says: "dev.to not read for 2 days", one source a line */
export function overdueWords(overdue: LaunchUpdated['overdue'], now: Date = new Date()): string {
  return overdue.map((o) => `${CHANNEL_NAMES[o.source] ?? o.source} not read for ${since(o.since, now).replace(/ ago$/, '')}`).join('\n');
}

/** The newest of a channel's totals' reads: its popup's one line */
export function newestRead(ages: Partial<Record<keyof Totals, TotalAge>> | undefined): string | undefined {
  return Object.values(ages ?? {}).reduce<string | undefined>((n, a) => (a && (n === undefined || a.readAt > n) ? a.readAt : n), undefined);
}

type Families = Readonly<Record<string, Partial<Record<string, readonly string[]>>>>;

/**
 * The repo's own numbers (`github`): its traffic is the repo's, kept on every launch of it, so it is
 * no launch's views; only its stars are counted, as a total of their own.
 */
export const REPO_SOURCE = 'github';

/**
 * The sources a launch's views come from: every source of the families but the repo. The totals and
 * the views per day both read these, so a day of the chart can never stand above the launch's views.
 */
export function launchViewSources(families: Families): string[] {
  return Object.keys(families).filter((source) => source !== REPO_SOURCE && families[source]?.views);
}

/**
 * The launch's totals from the latest reading of each counter, through the stats section's metric
 * families so a number counts here as it counts on /stats. GitHub's stars are a family's reaction
 * there, but a star is not a reaction to a post: they get their own total, and the repo's traffic is
 * no launch's views (REPO_SOURCE).
 */
export function launchTotals(readings: readonly CounterReading[], families: Families): Totals {
  const totals: Totals = { views: 0, reactions: 0, comments: 0, clicks: 0, stars: 0 };
  for (const r of readings) {
    if (r.source === REPO_SOURCE) {
      if (r.name === 'stars') totals.stars += r.value;
      continue;
    }
    for (const family of ['views', 'reactions', 'comments', 'clicks'] as const) {
      if (families[r.source]?.[family]?.includes(r.name)) totals[family] += r.value;
    }
  }
  return totals;
}

/** The latest value of each piece's number, from its whole history (oldest first or not) */
export function latestByPiece<T extends { postId: number; name: string; value: number; takenAt: string }>(readings: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const r of readings) {
    const key = `${r.postId}:${r.name}`;
    const seen = latest.get(key);
    if (!seen || seen.takenAt <= r.takenAt) latest.set(key, r);
  }
  return [...latest.values()];
}

export interface Day {
  /** YYYY-MM-DD, UTC */
  day: string;
  views: number;
}

/**
 * Views per day since the launch's day, from a daily series of increases; the latest `max` days
 * when it has been out longer, so the chart stays a glance rather than a timeline.
 */
export function dailyViews(points: ReadonlyArray<{ bucket: string; increase: number }>, launchedAt: string, max = 30): Day[] {
  const first = launchedAt.slice(0, 10);
  return points
    .filter((p) => p.bucket >= first)
    .map((p) => ({ day: p.bucket, views: p.increase }))
    .slice(-max);
}

/** One channel's share of a launch: only the totals its network counts (a metric it does not count is absent, not 0) */
export interface ChannelNumbers {
  totals: Partial<Totals>;
  /** When each of its totals was last read */
  ages?: Partial<Record<keyof Totals, TotalAge>>;
  daily: Day[];
  /** The site's visits from the channel's tagged links, where Umami has counted any */
  site?: SiteVisits;
}

/** A channel's page views and visits on the site, from the links it published (Umami, by `utm_source`) */
export interface SiteVisits {
  views: number;
  visits: number;
  /** Each piece's share, where the channel's `utm_content` names its format: YouTube's `post:short` and `post:video` */
  pieces?: Record<string, { views: number; visits: number }>;
}

/**
 * Each tagged channel's visits from a launch's Umami readings (`views_<utm_source>`,
 * `visits_<utm_source>`), under the channel whose links carry that source; `sources` is each tagged
 * channel's `utm_source` (UTM_CHANNELS). A channel Umami has not counted is absent. For a source in
 * `formats.sources` (FORMAT_SOURCES), each format's readings (`visits_youtube_short`) are the share of
 * the piece `formats.piece` names (`post:short`); the channel's own numbers stay the source's.
 */
export function channelSiteVisits(
  readings: readonly CounterReading[],
  sources: Readonly<Record<string, string>>,
  formats: { sources: readonly string[]; piece(format: string): string } = { sources: [], piece: (f) => f },
): Record<string, SiteVisits> {
  const out: Record<string, SiteVisits> = {};
  const umami = readings.filter((r) => r.source === 'umami');
  const value = (name: string) => umami.find((r) => r.name === name)?.value;
  for (const [channel, source] of Object.entries(sources)) {
    const views = value(`views_${source}`);
    const visits = value(`visits_${source}`);
    if (views === undefined && visits === undefined) continue;
    const site: SiteVisits = { views: views ?? 0, visits: visits ?? 0 };
    if (formats.sources.includes(source)) {
      const pieces: NonNullable<SiteVisits['pieces']> = {};
      for (const r of umami) {
        const match = /^(views|visits)_(.+)$/.exec(r.name);
        if (!match?.[2]?.startsWith(`${source}_`)) continue;
        const piece = (pieces[formats.piece(match[2].slice(source.length + 1))] ??= { views: 0, visits: 0 });
        piece[match[1] as 'views' | 'visits'] = r.value;
      }
      if (Object.keys(pieces).length > 0) site.pieces = pieces;
    }
    out[channel] = site;
  }
  return out;
}

/** What a launch's card and its page lead with, and each channel's part of it */
export interface LaunchNumbers {
  totals: Totals;
  /** When each total was last read, and whether its source lags by design */
  ages?: Partial<Record<keyof Totals, TotalAge>>;
  /** When its numbers were last updated, and the sources overdue for their cadence */
  updated?: LaunchUpdated;
  daily: Day[];
  channels: Record<string, ChannelNumbers>;
}

const CHANNEL_FAMILIES = ['views', 'reactions', 'comments', 'clicks'] as const;

/**
 * Each channel's totals from the latest reading of each counter: the families its network counts,
 * summed over its pieces. Search engines and GitHub are sources of the launch, not channels.
 */
export function channelTotals(readings: readonly CounterReading[], families: Families): Record<string, Partial<Totals>> {
  const out: Record<string, Partial<Totals>> = {};
  for (const r of readings) {
    if (r.source === 'search' || r.source === 'bing' || r.source === 'github') continue;
    const counted = families[r.source];
    if (!counted) continue;
    const totals = (out[r.source] ??= Object.fromEntries(CHANNEL_FAMILIES.filter((f) => counted[f]).map((f) => [f, 0])));
    for (const family of CHANNEL_FAMILIES) if (counted[family]?.includes(r.name)) totals[family] = (totals[family] ?? 0) + r.value;
  }
  return out;
}

type Points = ReadonlyArray<{ bucket: string; increase: number }>;

/**
 * A daily series keyed `<launch>:<channel>` split two ways: per launch and channel as it comes, and
 * per launch summed over its channels, bucket by bucket.
 */
export function splitSeries(groups: ReadonlyArray<{ key: string; points: Points }>): { launches: Map<number, Points>; channels: Map<number, Map<string, Points>> } {
  const launches = new Map<number, Map<string, number>>();
  const channels = new Map<number, Map<string, Points>>();
  for (const g of groups) {
    const at = g.key.indexOf(':');
    const id = Number(g.key.slice(0, at));
    const channel = g.key.slice(at + 1);
    if (at < 0 || !Number.isInteger(id)) continue;
    (channels.get(id) ?? channels.set(id, new Map()).get(id)!).set(channel, g.points);
    const sum = launches.get(id) ?? launches.set(id, new Map()).get(id)!;
    for (const p of g.points) sum.set(p.bucket, (sum.get(p.bucket) ?? 0) + p.increase);
  }
  return {
    launches: new Map([...launches].map(([id, sum]) => [id, [...sum].sort(([a], [b]) => a.localeCompare(b)).map(([bucket, increase]) => ({ bucket, increase }))])),
    channels,
  };
}

/** Each post's account by the name the owner knows it by; a post with no account is left out */
export function postAccountNames(posts: ReadonlyArray<{ id: number; accountId: number | null }>, names: ReadonlyMap<number, string>): Record<number, string> {
  const out: Record<number, string> = {};
  for (const p of posts) if (p.accountId !== null) out[p.id] = names.get(p.accountId) ?? `account ${p.accountId}`;
  return out;
}

/** One post of a card's channel, as its mark's menu lists it */
export interface CardPost {
  id: number;
  /** What tells it from the channel's other posts: its account, its language, its kind; `Post` alone */
  label: string;
  url: string | null;
  status: string;
  scheduledAt: string | null;
}

/** A channel of a launch's card: its mark, the accounts it went out on, and its posts */
export interface CardChannel {
  channel: string;
  mark: Mark;
  accounts: string[];
  posts: CardPost[];
}

const KIND_WORD = (kind: string): string => {
  if (kind === 'post') return '';
  if (kind.startsWith('post:')) return `r/${kind.slice('post:'.length)}`;
  const lang = /^(?:article|issue):(\w+)$/.exec(kind)?.[1];
  return lang ? lang.toUpperCase() : kind.charAt(0).toUpperCase() + kind.slice(1);
};

/**
 * A launch's channels for its card, in the order they first went out: each with its mark, the
 * brand's accounts it went out on and one entry per post, labelled by what tells it apart (the
 * account only when the channel went out on several). A channel that failed before anything went
 * out has no post, only its failed mark.
 */
export function cardChannels(input: {
  posts: ReadonlyArray<{ id: number; channel: string; kind: string; url: string | null; status: string; scheduledAt: string | null }>;
  failures: ReadonlyArray<{ channel: string }>;
  /** Each post's account, by the name the owner knows it by; a post with none went out with the .env credentials */
  postAccounts: Readonly<Record<number, string>>;
}): CardChannel[] {
  const order: string[] = [];
  for (const c of [...input.posts.map((p) => p.channel), ...input.failures.map((f) => f.channel)]) if (!order.includes(c)) order.push(c);
  return order.map((channel) => {
    const posts = input.posts.filter((p) => p.channel === channel);
    const accounts = [...new Set(posts.flatMap((p) => (input.postAccounts[p.id] ? [input.postAccounts[p.id]!] : [])))];
    const failed = input.failures.some((f) => f.channel === channel);
    return {
      channel,
      mark: markOf(
        posts.map((p) => p.status),
        failed,
      ),
      accounts,
      posts: posts.map((p) => ({
        id: p.id,
        label: [accounts.length > 1 ? input.postAccounts[p.id] : undefined, KIND_WORD(p.kind) || undefined].filter(Boolean).join(' · ') || 'Post',
        url: p.url,
        status: p.status,
        scheduledAt: p.scheduledAt,
      })),
    };
  });
}

/** How many days after the launch's day a day is: 0 for the day itself */
export function dayOffset(day: string, launchedAt: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${launchedAt.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
}

/** A channel's state as one mark: a dot whose shape says it, with its word for whoever cannot see it */
export type Mark = 'published' | 'scheduled' | 'failed' | 'off';

export const MARK_WORD: Record<Mark, string> = { published: 'Published', scheduled: 'Scheduled', failed: 'Failed', off: 'Not launched' };

/**
 * A channel's mark from its pieces' statuses: a failure wins, since a failure missed is the worst
 * outcome; then a time still to come; then anything out; a channel whose pieces are all gone or
 * never went out is not launched.
 */
export function markOf(statuses: readonly string[], failed: boolean): Mark {
  if (failed || statuses.includes('failed')) return 'failed';
  if (statuses.includes('scheduled')) return 'scheduled';
  if (statuses.some((s) => s === 'live' || s === 'edited')) return 'published';
  return 'off';
}

/** A channel's tile and the gap between tiles, in CSS px: `.mark` and `.marks` in app.css */
export const MARK_SIZE = 36;
export const MARK_GAP = 8;

/**
 * How many tiles a row of `width` px holds, at least one. Computed from the row's real width, so the
 * "+n" chip (which `foldMarks` keeps in the last slot) never pushes the row past the card.
 */
export function markCapacity(width: number): number {
  return Math.max(1, Math.floor((Math.max(0, width) + MARK_GAP) / (MARK_SIZE + MARK_GAP)));
}

const RANK: Record<Mark, number> = { failed: 0, scheduled: 1, off: 2, published: 3 };

/**
 * A card's marks on one row: problems first (failed, scheduled, not launched, then published), and
 * when more than `fit` do not fit the row, the first `fit - 1` with the rest folded behind a "+n", so
 * only channels that went fine are folded away when there are few problems. The order is otherwise kept.
 */
export function foldMarks<T extends { mark: Mark }>(items: readonly T[], fit: number): { shown: T[]; folded: T[] } {
  const max = Math.max(1, fit);
  const sorted = items.map((item, i) => ({ item, i })).sort((a, b) => RANK[a.item.mark] - RANK[b.item.mark] || a.i - b.i).map((x) => x.item);
  if (sorted.length <= max) return { shown: sorted, folded: [] };
  return { shown: sorted.slice(0, max - 1), folded: sorted.slice(max - 1) };
}

/** An instant for a launch's header, in the owner's zone: `25 Oct 2026, 04:06` */
export function launchDateLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** A big number kept short: 1,234 under ten thousand, 12.3k above */
export function shortNumber(n: number): string {
  if (Math.abs(n) < 10_000) return Math.round(n).toLocaleString('en');
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
