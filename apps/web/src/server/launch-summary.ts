/*
 * A launch at a glance, as plain data the launch page, the launches list and the tests share: its
 * totals, its views per day since it went out, and each channel's state as one mark. Only types and
 * plain values here, so the module is safe in the browser bundle (docs/web-app.md).
 */

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
  ['stars', 'Stars'],
];

/** A counter's latest reading: one piece's number, or a launch-wide source's (the blog, Search Console, GitHub) */
export interface CounterReading {
  source: string;
  name: string;
  value: number;
}

type Families = Readonly<Record<string, Partial<Record<string, readonly string[]>>>>;

/**
 * The launch's totals from the latest reading of each counter, through the stats section's metric
 * families so a number counts here as it counts on /stats. GitHub's stars are a family's reaction
 * there, but a star is not a reaction to a post: they get their own total.
 */
export function launchTotals(readings: readonly CounterReading[], families: Families): Totals {
  const totals: Totals = { views: 0, reactions: 0, comments: 0, clicks: 0, stars: 0 };
  for (const r of readings) {
    if (r.source === 'github') {
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
