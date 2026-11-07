import type { MetricCadence } from './definition.ts';
import { channelDefinition } from './registry.ts';

/*
 * How often each source of numbers is read, in minutes (docs/publishing.md, "Cadences"; until
 * 2026-11-07 every hour at most, docs/plans/performance-refactor.md, "5. Metrics"). A channel's
 * cadence is on its definition; the site-level sources, which are not channels, are here. The metrics
 * job runs every 5 minutes and reads a source only when its last check is older than this.
 */
const DAY = 24 * 60;


export const SITE_CADENCES = {
  /** The repo's stars, forks and watchers: live, and a 304 when nothing moved costs no quota */
  githubCounts: { minutes: 5, read: 'conditional', why: 'live; a 304 costs no quota' },
  /** The repo's views, clones, referrers and pages: GitHub buckets them by day */
  githubTraffic: { minutes: DAY, read: 'single', why: 'bucketed by day' },
  /** The repo's stars by day and its releases' downloads */
  githubHistory: { minutes: DAY, read: 'single', why: 'stars counted by day' },
  /** Search Console's clicks and impressions: its data lags two to three days */
  searchAnalytics: { minutes: DAY, read: 'single', why: '2–3 days of lag' },
  /** Google's URL inspection of an article not indexed yet */
  urlInspection: { minutes: DAY, read: 'single', why: '2,000 per day per property' },
  /** Once Google has an article, a week is soon enough to notice it dropped out */
  urlInspectionIndexed: { minutes: 7 * DAY, read: 'single', why: 'indexed: only a drop-out is news' },
  /** Bing Webmaster's clicks, impressions and crawl state */
  bing: { minutes: DAY, read: 'single', why: 'daily data' },
  /** The blog's visits by UTM source from Umami (flag `umami`): self-hosted, live and with no quota */
  umami: { minutes: 5, read: 'single', why: 'live, self-hosted' },
} as const satisfies Record<string, MetricCadence>;

/**
 * Past this many days since its launch an article's index status is no longer inspected: one Google
 * has not indexed in three months needs the owner (a noindex, a canonical, thin content), not
 * another inspection, and one that is indexed has long settled. The last status read stays shown.
 */
export const INSPECTION_MAX_AGE_DAYS = 90;

/** A channel's cadence, from its definition; undefined for a channel that reads no numbers */
export function channelCadence(channel: string): MetricCadence | undefined {
  return channelDefinition(channel)?.metrics?.cadence;
}

/** How old a piece is when its reads slow down, in days: to hourly after a week, to daily after a month */
export const TAPER_DAYS = { hourly: 7, daily: 30 } as const;

/**
 * A piece's (or a launch's) cadence by its age: its source's own for the first week after it went
 * out, when its numbers move; at most hourly to a month; at most daily after. Never faster than the
 * source's own. So the calls a round makes grow with the recent launches, not with every launch ever.
 */
export function taperedMinutes(minutes: number, publishedAt: string, now: Date): number {
  const days = (now.getTime() - Date.parse(publishedAt)) / 86_400_000;
  if (!(days >= TAPER_DAYS.hourly)) return minutes;
  return Math.max(minutes, days >= TAPER_DAYS.daily ? 24 * 60 : 60);
}

/** The cadence of a channel's analytics, read apart from its counters; undefined for a channel without */
export function channelAnalyticsCadence(channel: string): MetricCadence | undefined {
  return channelDefinition(channel)?.metrics?.analytics;
}
