import type { Channel } from '@shipcast/schema';
import { sql } from 'drizzle-orm';
import type { Registry } from './registry.ts';
import { readTimezone, SCHEDULABLE_CHANNELS } from './schedule.ts';
import { METRIC_FAMILIES, statsRanking } from './stats.ts';

/*
 * When to publish: ranked times for the next days, per channel, in the owner's time zone. Each hour
 * of the week starts from a default for a developer audience (below), Instagram's from the hours its
 * followers are online too when the account's insights give them, and moves toward what the owner's
 * own posts did at that hour, by how many there are: a handful of posts barely moves a default, a
 * history of them takes over. See docs/scheduling.md for the sources and the assumptions.
 */

/** Monday is 0, as the defaults are written */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Hours [from, to) on some days, with how good they are, 0 to 1 */
interface Window {
  days: readonly Weekday[];
  from: number;
  to: number;
  weight: number;
}

const WORKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4];
const MIDWEEK: readonly Weekday[] = [1, 2, 3];
const WEEKEND: readonly Weekday[] = [5, 6];

export interface ChannelDefaults {
  /** What the default says, in the slot's reason */
  note: string;
  windows: readonly Window[];
}

/*
 * The defaults: local hours, for an owner in Europe writing for developers in Europe and the
 * Americas. They follow the published studies of when posts do best (Sprout Social's and Hootsuite's
 * yearly reports from their customers' posts, Buffer's analysis of millions of posts; for email, the
 * send-time studies of Mailchimp, Brevo and GetResponse) where those exist, and the audience's
 * geography where they do not: none measures Bluesky, Mastodon, dev.to or Hashnode for developers.
 * They are starting points, not measurements; the owner's own numbers replace them as they come.
 */
export const CHANNEL_DEFAULTS: Partial<Record<Channel, ChannelDefaults>> = {
  bluesky: {
    note: 'weekday afternoons, when Europe’s afternoon meets the US east coast’s morning (Bluesky’s developers are mostly American)',
    windows: [
      { days: WORKDAYS, from: 15, to: 19, weight: 1 },
      { days: MIDWEEK, from: 9, to: 12, weight: 0.7 },
      { days: WORKDAYS, from: 9, to: 12, weight: 0.5 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.3 },
    ],
  },
  mastodon: {
    note: 'midweek mornings in Europe, where most of the fediverse’s developers are',
    windows: [
      { days: MIDWEEK, from: 9, to: 12, weight: 1 },
      { days: WORKDAYS, from: 9, to: 12, weight: 0.8 },
      { days: WORKDAYS, from: 13, to: 15, weight: 0.6 },
      { days: WORKDAYS, from: 18, to: 21, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.35 },
    ],
  },
  instagram: {
    note: 'weekday evenings and lunchtime, the hours the studies find for Instagram',
    windows: [
      { days: WORKDAYS, from: 18, to: 21, weight: 1 },
      { days: WORKDAYS, from: 12, to: 14, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.6 },
      { days: WEEKEND, from: 19, to: 21, weight: 0.6 },
    ],
  },
  devto: {
    note: 'midweek mornings, read with the first coffee in Europe and in the US feed by its morning',
    windows: [
      { days: MIDWEEK, from: 8, to: 11, weight: 1 },
      { days: WORKDAYS, from: 8, to: 11, weight: 0.7 },
      { days: [0, 1, 2, 3], from: 15, to: 17, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.2 },
    ],
  },
  hashnode: {
    note: 'midweek mornings, as on dev.to',
    windows: [
      { days: MIDWEEK, from: 8, to: 11, weight: 1 },
      { days: WORKDAYS, from: 8, to: 11, weight: 0.7 },
      { days: [0, 1, 2, 3], from: 15, to: 17, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.2 },
    ],
  },
  newsletter: {
    note: 'Tuesday and Thursday mornings, where the email send-time studies agree',
    windows: [
      { days: [1, 3], from: 9, to: 11, weight: 1 },
      { days: [2], from: 9, to: 11, weight: 0.8 },
      { days: WORKDAYS, from: 9, to: 11, weight: 0.6 },
      { days: MIDWEEK, from: 17, to: 19, weight: 0.5 },
    ],
  },
  telegram: {
    note: 'weekday late afternoons, after work, and late mornings',
    windows: [
      { days: WORKDAYS, from: 17, to: 20, weight: 1 },
      { days: WORKDAYS, from: 10, to: 13, weight: 0.8 },
      { days: WEEKEND, from: 11, to: 13, weight: 0.4 },
    ],
  },
  threads: {
    note: 'weekday lunchtime and early evening, the hours the studies find for Threads, which share Instagram’s audience',
    windows: [
      { days: WORKDAYS, from: 12, to: 14, weight: 1 },
      { days: WORKDAYS, from: 18, to: 21, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.4 },
    ],
  },
  linkedin: {
    note: 'Tuesday to Thursday mornings, where the LinkedIn studies agree',
    windows: [
      { days: MIDWEEK, from: 8, to: 11, weight: 1 },
      { days: WORKDAYS, from: 8, to: 11, weight: 0.7 },
      { days: MIDWEEK, from: 12, to: 14, weight: 0.6 },
      { days: WEEKEND, from: 10, to: 12, weight: 0.1 },
    ],
  },
  githubDiscussions: {
    note: 'weekday working hours in Europe and the US east coast, when maintainers and watchers read GitHub',
    windows: [
      { days: WORKDAYS, from: 15, to: 18, weight: 1 },
      { days: WORKDAYS, from: 9, to: 13, weight: 0.8 },
      { days: WEEKEND, from: 10, to: 13, weight: 0.3 },
    ],
  },
  discord: {
    note: 'weekday late afternoons, when the servers are busiest, and late mornings',
    windows: [
      { days: WORKDAYS, from: 17, to: 20, weight: 1 },
      { days: WORKDAYS, from: 10, to: 13, weight: 0.8 },
      { days: WEEKEND, from: 11, to: 13, weight: 0.4 },
    ],
  },
};

const noteOf = (channel: Channel) => CHANNEL_DEFAULTS[channel]?.note ?? 'weekday working hours';

/** Every other hour of the week: a weekday's working hours a little, a weekend or the night barely */
function baseline(day: Weekday, hour: number): number {
  if (hour < 7 || hour >= 23) return 0;
  return day < 5 ? 0.15 : 0.08;
}

/** How good an hour of the week is by the defaults, 0 to 1 */
export function defaultWeight(channel: Channel, day: Weekday, hour: number): number {
  let best = baseline(day, hour);
  for (const w of CHANNEL_DEFAULTS[channel]?.windows ?? []) if (w.days.includes(day) && hour >= w.from && hour < w.to) best = Math.max(best, w.weight);
  return best;
}

/** A post's numbers keep growing for a day or two; younger ones would look worse than they are */
export const MIN_POST_AGE_MS = 48 * 3600 * 1000;
/** Fewer posts than this and the history is not used at all: one or two posts have no median worth the name */
export const MIN_HISTORY = 3;
/** How many posts' worth the default counts for in each hour: with as many posts near an hour, the two weigh the same */
export const PRIOR_WEIGHT = 3;

export interface LocalTime {
  day: Weekday;
  hour: number;
  minute: number;
  /** YYYY-MM-DD in the zone */
  date: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The weekday, hour and date of an instant in a zone, by the zone's rules on that day (summer time included) */
export function localTime(at: Date, timeZone: string): LocalTime {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((p) => [p.type, p.value]));
  const day = WEEKDAYS.indexOf(parts.weekday as (typeof WEEKDAYS)[number]);
  return { day: (day < 0 ? 0 : day) as Weekday, hour: Number(parts.hour) % 24, minute: Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}` };
}

/** One of the owner's published pieces, with its popularity normalised per network (docs/stats.md) */
export interface HistoryPost {
  publishedAt: string;
  engagement: number;
}

/** How many of the account's followers are online at each hour of the day (0 to 23), in `timeZone` */
export interface AudienceHours {
  timeZone: string;
  hours: number[];
}

export interface RecommendInput {
  channel: Channel;
  /** The owner's IANA zone: the defaults are its local hours, and the slots are told in it */
  tz: string;
  now: Date;
  history?: HistoryPost[];
  audience?: AudienceHours;
  /** Days ahead, 7 by default */
  days?: number;
  /** Slots returned, 5 by default; one per local day at most */
  count?: number;
}

export interface Slot {
  /** The moment, in UTC */
  at: string;
  /** The same moment in the owner's zone, `Tue 2026-10-27 17:00` */
  local: string;
  /** The expected performance against the channel's median post (1 is the median) */
  score: number;
  basis: 'default' | 'audience' | 'history' | 'blend';
  reason: string;
}

export interface Recommendation {
  channel: Channel;
  timezone: string;
  slots: Slot[];
  /** The owner's posts the history was learned from, and those old enough to count */
  history: { posts: number; used: number; median: number | null; what: string | null };
  audience: boolean;
}

const NAMES: Partial<Record<Channel, string>> = { devto: 'dev.to', bluesky: 'Bluesky', mastodon: 'Mastodon', instagram: 'Instagram', hashnode: 'Hashnode', newsletter: 'the newsletter', telegram: 'Telegram', discord: 'Discord', githubDiscussions: 'GitHub Discussions', threads: 'Threads', linkedin: 'LinkedIn' };
const nameOf = (channel: Channel) => NAMES[channel] ?? channel;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Hours apart on the clock, the short way round: 23:00 and 00:00 are one hour apart */
const hourGap = (a: number, b: number) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));

/**
 * How much a past post at one hour of the week tells about another: fully at the same hour of the
 * same weekday, half an hour off, and a little at that hour on another day of the same kind
 * (weekday or weekend), since one post per hour of the week would take years to gather.
 */
function kernel(slot: LocalTime, post: LocalTime): number {
  const gap = hourGap(slot.hour, post.hour);
  const byHour = gap === 0 ? 1 : gap === 1 ? 0.5 : 0;
  if (byHour === 0) return 0;
  const byDay = slot.day === post.day ? 1 : slot.day < 5 === post.day < 5 ? 0.3 : 0;
  return byHour * byDay;
}

const pad = (n: number) => String(n).padStart(2, '0');
const QUARTER_MS = 15 * 60_000;

/**
 * Ranked times for the next days. Every whole local hour ahead is scored as the expected multiple of
 * the channel's median post: the default's guess (0.5 at the worst hours to 1.5 at the best, with
 * Instagram's online followers mixed in when given) counting for PRIOR_WEIGHT posts, and the
 * owner's posts near that hour each counting by how near; the two are averaged in log space, so one
 * post at 5x the median does not swamp the rest. The best hour of each day is kept, best first.
 */
export function recommendTimes(input: RecommendInput): Recommendation {
  const { channel, tz, now } = input;
  const days = input.days ?? 7;
  const count = input.count ?? 5;

  const old = (input.history ?? []).filter((p) => now.getTime() - Date.parse(p.publishedAt) >= MIN_POST_AGE_MS && Number.isFinite(p.engagement) && p.engagement >= 0);
  const mid = old.length >= MIN_HISTORY ? median(old.map((p) => p.engagement)) : null;
  // Relative to the median; with a median of zero, one interaction is already a lot, so both get one added
  const learned =
    mid === null
      ? []
      : old.map((p) => ({ when: localTime(new Date(p.publishedAt), tz), ratio: mid > 0 ? Math.max(p.engagement, mid * 0.05) / mid : (p.engagement + 1) / (mid + 1) }));

  const audience = input.audience && input.audience.hours.length === 24 && Math.max(...input.audience.hours) > 0 ? input.audience : undefined;
  const audienceAt = (at: Date) => {
    if (!audience) return undefined;
    const hours = audience.hours;
    const peak = Math.max(...hours);
    const mean = hours.reduce((a, b) => a + b, 0) / 24;
    const value = hours[localTime(at, audience.timeZone).hour] ?? 0;
    return { share: value / peak, vsMean: mean > 0 ? value / mean : 1 };
  };

  const candidates: Slot[] = [];
  const start = Math.ceil((now.getTime() + QUARTER_MS) / QUARTER_MS) * QUARTER_MS;
  const end = now.getTime() + days * 86_400_000;
  // Quarter hours, keeping those on a local whole hour: right in zones a half or three quarters off UTC, and across summer time
  for (let t = start; t <= end; t += QUARTER_MS) {
    const at = new Date(t);
    const local = localTime(at, tz);
    if (local.minute !== 0) continue;
    const base = defaultWeight(channel, local.day, local.hour);
    const crowd = audienceAt(at);
    const weight = crowd ? 0.5 * base + 0.5 * crowd.share : base;
    const prior = 0.5 + weight;

    let n = 0;
    let logSum = 0;
    let exact = 0;
    let exactLog = 0;
    for (const post of learned) {
      const k = kernel(local, post.when);
      if (k === 0) continue;
      n += k;
      logSum += k * Math.log(post.ratio);
      if (post.when.day === local.day && post.when.hour === local.hour) {
        exact += 1;
        exactLog += Math.log(post.ratio);
      }
    }
    const score = Math.exp((PRIOR_WEIGHT * Math.log(prior) + logSum) / (PRIOR_WEIGHT + n));
    const label = `${WEEKDAYS[local.day]} ${pad(local.hour)}:00`;
    const name = nameOf(channel);
    let basis: Slot['basis'];
    let reason: string;
    if (n > 0 && n >= PRIOR_WEIGHT) {
      basis = 'history';
      const near = Math.exp(logSum / n);
      reason =
        exact > 0
          ? `your ${exact === 1 ? 'post' : `${exact} posts`} at ${label} did ${Math.exp(exactLog / exact).toFixed(1)}x your median on ${name}`
          : `your posts around ${label} do ${near.toFixed(1)}x your median on ${name}`;
    } else if (n > 0) {
      basis = 'blend';
      const near = Math.exp(logSum / n);
      reason = `${name}’s default (${noteOf(channel)}), moved by your few posts near ${label} (${near.toFixed(1)}x your median)`;
    } else if (crowd && crowd.share >= base) {
      basis = 'audience';
      const pct = Math.round((crowd.vsMean - 1) * 100);
      reason = `${pct >= 0 ? `${pct}% more` : `${-pct}% fewer`} of your Instagram followers are online at ${pad(local.hour)}:00 than on average`;
    } else {
      basis = 'default';
      reason = `${name}’s default for a developer audience: ${noteOf(channel)}`;
    }
    candidates.push({ at: at.toISOString(), local: `${WEEKDAYS[local.day]} ${local.date} ${pad(local.hour)}:00`, score: Math.round(score * 100) / 100, basis, reason });
  }

  // Best first, the sooner of two equal ones first; then the best hour of each local day
  candidates.sort((a, b) => b.score - a.score || a.at.localeCompare(b.at));
  const slots: Slot[] = [];
  const taken = new Set<string>();
  for (const slot of candidates) {
    const date = slot.local.slice(4, 14);
    if (taken.has(date)) continue;
    taken.add(date);
    slots.push(slot);
    if (slots.length === count) break;
  }
  return {
    channel,
    timezone: tz,
    slots,
    history: { posts: input.history?.length ?? 0, used: learned.length, median: mid, what: METRIC_FAMILIES[channel] ? POPULARITY_WHAT : null },
    audience: audience !== undefined,
  };
}

/** Where the Instagram account's online followers are kept, read on its daily sync */
export const audienceKey = (accountId: number) => `instagram-audience:${accountId}`;

export interface StoredAudience extends AudienceHours {
  takenAt: string;
}

export function parseAudience(value: string | undefined): StoredAudience | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<StoredAudience>;
    if (typeof parsed.timeZone !== 'string' || typeof parsed.takenAt !== 'string' || !Array.isArray(parsed.hours) || parsed.hours.length !== 24) return undefined;
    if (!parsed.hours.every((h) => typeof h === 'number' && Number.isFinite(h))) return undefined;
    return { timeZone: parsed.timeZone, takenAt: parsed.takenAt, hours: parsed.hours };
  } catch {
    return undefined;
  }
}

/** What the history's numbers are, in the answer */
export const POPULARITY_WHAT = 'popularity normalised per network';

/** Older than any reading Shipcast took: the ranking's period is then the whole history */
const HISTORY_START = '2020-01-01T00:00:00.000Z';
/** A ranking page wide enough for every piece a channel ever had */
const HISTORY_LIMIT = 100_000;

/**
 * The owner's history on a channel: every piece that went out (live or edited) with its popularity
 * over its whole life, as the stats ranking scores it (docs/stats.md): each family's increase
 * against the network's median piece, so the learning measures what the stats section shows and a
 * network's numbers are read the one way. Channels that read no numbers (Telegram, Discord) have no
 * history and keep their defaults.
 */
export async function channelHistory(registry: Registry, channel: Channel, now: Date = new Date()): Promise<HistoryPost[]> {
  if (!METRIC_FAMILIES[channel]) return [];
  const ranking = await statsRanking(registry, { by: 'post', channels: [channel], from: HISTORY_START, to: new Date(now.getTime() + 1).toISOString(), limit: HISTORY_LIMIT });
  const scores = new Map(ranking.entries.flatMap((e) => (e.postId === null ? [] : [[e.postId, e.score] as const])));
  if (scores.size === 0) return [];
  const rows = await registry.selectRows<{ id: number; published_at: string }>(
    sql`SELECT id, published_at FROM posts WHERE id IN (${sql.join([...scores.keys()].map((id) => sql`${id}`), sql`, `)}) AND status IN ('live', 'edited') ORDER BY published_at, id`,
  );
  return rows.flatMap((row) => {
    const score = scores.get(Number(row.id));
    return score === undefined ? [] : [{ publishedAt: String(row.published_at), engagement: score }];
  });
}

/** The recommendation for a channel from the registry: its history, the owner's zone, and Instagram's audience */
export async function recommendFor(registry: Registry, channel: Channel, options: { now?: Date; tz?: string; days?: number; count?: number } = {}): Promise<Recommendation> {
  if (!SCHEDULABLE_CHANNELS.includes(channel)) throw new Error(`${channel} is not published by Shipcast, so it has no times`);
  const tz = options.tz ?? (await readTimezone(registry));
  let audience: StoredAudience | undefined;
  if (channel === 'instagram') {
    // The primary account first, as it is the one launches publish with
    const accounts = (await registry.accounts({ network: 'instagram' })).sort((a, b) => Number(b.primary) - Number(a.primary));
    for (const account of accounts) {
      audience = parseAudience(await registry.cursor(audienceKey(account.id)));
      if (audience) break;
    }
  }
  const now = options.now ?? new Date();
  return recommendTimes({
    channel,
    tz,
    now,
    history: await channelHistory(registry, channel, now),
    ...(audience && { audience }),
    ...(options.days !== undefined && { days: options.days }),
    ...(options.count !== undefined && { count: options.count }),
  });
}
