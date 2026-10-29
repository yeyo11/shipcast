import type { MetricCadence } from './definition.ts';
import { channelDefinition } from './registry.ts';

/*
 * How often each source of numbers is read (docs/plans/performance-refactor.md, "5. Metrics every
 * hour, never faster than the source"). A channel's cadence is on its definition; the site-level
 * sources, which are not channels, are here. The hourly metrics job reads a source only when its
 * last check is older than this.
 */

export const SITE_CADENCES = {
  /** The repo's stars, forks and watchers: live, and a 304 when nothing moved costs no quota */
  githubCounts: { hours: 1, read: 'conditional', why: 'live' },
  /** The repo's views, clones, referrers and pages: GitHub buckets them by day */
  githubTraffic: { hours: 24, read: 'single', why: 'bucketed by day' },
  /** The repo's stars by day and its releases' downloads */
  githubHistory: { hours: 24, read: 'single', why: 'stars counted by day' },
  /** Search Console's clicks and impressions: its data lags two to three days */
  searchAnalytics: { hours: 24, read: 'single', why: '2–3 days of lag' },
  /** Google's URL inspection of an article not indexed yet */
  urlInspection: { hours: 24, read: 'single', why: '2,000 per day per property' },
  /** Once Google has an article, a week is soon enough to notice it dropped out */
  urlInspectionIndexed: { hours: 24 * 7, read: 'single', why: 'indexed: only a drop-out is news' },
  /** Bing Webmaster's clicks, impressions and crawl state */
  bing: { hours: 24, read: 'single', why: 'daily data' },
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

/** The cadence of a channel's analytics, read apart from its counters; undefined for a channel without */
export function channelAnalyticsCadence(channel: string): MetricCadence | undefined {
  return channelDefinition(channel)?.metrics?.analytics;
}
