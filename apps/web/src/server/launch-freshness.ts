import { FRESHNESS_SLACK_MINUTES } from '@shipcast/engine';
import { channelCadence, SITE_CADENCES, taperedMinutes } from '@shipcast/schema';
import type { CounterReading, LaunchUpdated } from './launch-summary.ts';

/*
 * When a launch's numbers were last updated, and which of its sources are overdue, by the
 * `freshness` check's own rule (docs/measurement.md): a source's cadence, slowed by its piece's age
 * as the reads are (taperedMinutes), plus the check's grace. Server-side: it needs the cadences.
 */

/** A source's cadence in minutes: a channel's from its definition, a site source's from SITE_CADENCES */
function cadenceOf(source: string): number | undefined {
  if (source === 'search') return SITE_CADENCES.searchAnalytics.minutes;
  if (source === 'bing') return SITE_CADENCES.bing.minutes;
  if (source === 'umami') return SITE_CADENCES.umami.minutes;
  if (source === 'github' || source.startsWith('github:')) return SITE_CADENCES.githubCounts.minutes;
  return channelCadence(source)?.minutes;
}

/** A reading with when its piece (or its launch, for a site source) went out */
export type AgedReading = CounterReading & { publishedAt: string };

/**
 * The newest read among the readings (undefined when none says when), and each source with a
 * reading past its cadence and the grace, with its oldest such read: "dev.to not read for 2 days".
 */
export function launchUpdated(readings: readonly AgedReading[], now: Date = new Date()): LaunchUpdated | undefined {
  let readAt: string | undefined;
  const late = new Map<string, string>();
  for (const r of readings) {
    if (r.checkedAt === undefined) continue;
    if (readAt === undefined || r.checkedAt > readAt) readAt = r.checkedAt;
    const cadence = cadenceOf(r.source);
    if (cadence === undefined) continue;
    const allowed = (taperedMinutes(cadence, r.publishedAt, now) + FRESHNESS_SLACK_MINUTES) * 60_000;
    if (now.getTime() - Date.parse(r.checkedAt) <= allowed) continue;
    const was = late.get(r.source);
    if (was === undefined || r.checkedAt < was) late.set(r.source, r.checkedAt);
  }
  if (readAt === undefined) return undefined;
  return { readAt, overdue: [...late].map(([source, since]) => ({ source, since })).sort((a, b) => a.since.localeCompare(b.since)) };
}
