import { isAveragedMetric } from '@shipcast/schema';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { metricDays, metrics } from '../db/schema.ts';

/** A reading of a top list a source names afresh each read (GitHub's top referrers and pages) */
const isTopListMetric = (name: string) => /^(?:referrer|referrer_visitors|path|path_visitors):/.test(name);

/**
 * One number read from one source for one launch, at one moment. A launch's readings add up its
 * pieces': two newsletter issues read in one round are one reading of the newsletter. A ratio (a
 * channel's `averaged` readings, Reddit's upvote ratio) is their average instead.
 */
export interface MetricReading {
  launchId: number;
  /** A channel (`devto`, `bluesky`…), or a site-level source (`blog`, `search`, `github`) */
  source: string;
  name: string;
  value: number;
  /** When the value was read as it is: a reading's time */
  takenAt: string;
  /** When it was last read again unchanged, or `takenAt` when it was not: what "read at" shows */
  checkedAt: string;
}

/** How one call to `recordMetrics` was stored */
export interface Recorded {
  /** Values that changed (or were new): one row each */
  inserted: number;
  /** Values equal to the newest reading: its `checked_at` moved, no row added */
  checked: number;
}

/** One day of a source's numbers, under the day it happened (`metric_days`) */
export interface MetricDay {
  launchId: number;
  postId: number | null;
  source: string;
  name: string;
  /** YYYY-MM-DD, in the source's own calendar */
  day: string;
  value: number;
  /** When the day was last read */
  readAt: string;
}

/** The moment a row was last seen holding its value */
const seen = sql<string>`coalesce(${metrics.checkedAt}, ${metrics.takenAt})`;

/**
 * A launch's sum at each moment it was read, from rows that each hold for [taken_at, seen]: at a
 * moment, every piece's row that held then is added up. With no `checked_at` anywhere (a row a
 * reading) this is the sum of the rows taken at that very moment, as it always was. `average` makes
 * it their mean, for a ratio.
 */
function sumsAt(rows: ReadonlyArray<{ value: number; takenAt: string; checkedAt: string | null }>, moments: Iterable<string>, average = false): Array<{ at: string; value: number }> {
  return [...new Set(moments)].sort().flatMap((at) => {
    const held = rows.filter((r) => r.takenAt <= at && (r.checkedAt ?? r.takenAt) >= at);
    const sum = held.reduce((n, r) => n + r.value, 0);
    return held.length === 0 ? [] : [{ at, value: average ? sum / held.length : sum }];
  });
}

/** The numbers read for each launch and each of its pieces, a reading a row */
export class MetricRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * `postId` for a reading of one piece; without it the reading is the launch's, as a site-level
   * source's is. With `unchangedMovesCheck` (the owner's rule for the hourly reads), a value equal to
   * the newest reading of the same piece, source and name moves that row's `checked_at` instead of
   * adding a row: a new row only when a value changes.
   */
  async recordMetrics(launchId: number, source: string, values: Record<string, number>, takenAt: Date, postId: number | null = null, options: { unchangedMovesCheck?: boolean } = {}): Promise<Recorded> {
    const at = takenAt.toISOString();
    const finite = Object.entries(values).filter(([, value]) => Number.isFinite(value));
    if (finite.length === 0) return { inserted: 0, checked: 0 };
    const ofThis = and(eq(metrics.launchId, launchId), postId === null ? isNull(metrics.postId) : eq(metrics.postId, postId), eq(metrics.source, source));
    let fresh = finite;
    let checked = 0;
    if (options.unchangedMovesCheck) {
      const newest = await this.#db
        .selectDistinctOn([metrics.name], { name: metrics.name, value: metrics.value, takenAt: metrics.takenAt })
        .from(metrics)
        .where(and(ofThis, inArray(metrics.name, finite.map(([name]) => name))))
        .orderBy(metrics.name, desc(metrics.takenAt));
      const last = new Map(newest.map((r) => [r.name, r]));
      const same = finite.filter(([name, value]) => last.get(name)?.value === value && last.get(name)!.takenAt <= at);
      fresh = finite.filter(([name]) => !same.some(([n]) => n === name));
      // Rows taken at one moment are moved together: one update per moment, nearly always one
      const byMoment = new Map<string, string[]>();
      for (const [name] of same) byMoment.set(last.get(name)!.takenAt, [...(byMoment.get(last.get(name)!.takenAt) ?? []), name]);
      for (const [moment, names] of byMoment) {
        await this.#db.update(metrics).set({ checkedAt: at }).where(and(ofThis, eq(metrics.takenAt, moment), inArray(metrics.name, names)));
      }
      checked = same.length;
    }
    if (fresh.length > 0) await this.#db.insert(metrics).values(fresh.map(([name, value]) => ({ launchId, postId, source, name, value, takenAt: at })));
    return { inserted: fresh.length, checked };
  }

  /**
   * A source's numbers per day (`{ '2026-10-28': { clicks: 3 } }`), each under the day it happened
   * rather than the time it was read. A day read again takes the new value: a source's later word on
   * a day (Search Console's final data, a repo's traffic once the day is over) is the better one.
   */
  async recordDays(launchId: number, source: string, days: Readonly<Record<string, Readonly<Record<string, number>>>>, readAt: Date, postId: number | null = null): Promise<number> {
    const at = readAt.toISOString();
    const rows = Object.entries(days).flatMap(([day, values]) =>
      Object.entries(values).flatMap(([name, value]) => (Number.isFinite(value) ? [{ launchId, postId, source, name, day, value, readAt: at }] : [])),
    );
    if (rows.length === 0) return 0;
    await this.#db
      .insert(metricDays)
      .values(rows)
      .onConflictDoUpdate({ target: [metricDays.launchId, metricDays.postId, metricDays.source, metricDays.name, metricDays.day], set: { value: sql`excluded.value`, readAt: sql`excluded.read_at` } });
    return rows.length;
  }

  /** A launch's numbers per day, oldest first: of one source, or every source's */
  async metricDays(launchId: number, source?: string): Promise<MetricDay[]> {
    return this.#db
      .select({ launchId: metricDays.launchId, postId: metricDays.postId, source: metricDays.source, name: metricDays.name, day: metricDays.day, value: metricDays.value, readAt: metricDays.readAt })
      .from(metricDays)
      .where(source === undefined ? eq(metricDays.launchId, launchId) : and(eq(metricDays.launchId, launchId), eq(metricDays.source, source)))
      .orderBy(asc(metricDays.day), asc(metricDays.source), asc(metricDays.name));
  }

  /**
   * The newest reading of every metric of a launch, its pieces' added up: the rows that held at the
   * last moment the metric was read (`max(coalesce(checked_at, taken_at))`). A piece left out of
   * that read (gone, failed) is left out of the sum, as it always was.
   */
  async latestMetrics(launchId: number): Promise<MetricReading[]> {
    const rows = await this.#latestSums(launchId);
    // A top list (GitHub's ten referrers and pages) names only who is in it now: one that dropped out
    // was not read again, and its last value would stand for ever. Only those of the newest read stay
    const newestOfList = new Map<string, string>();
    for (const r of rows) {
      if (!isTopListMetric(r.name)) continue;
      const was = newestOfList.get(r.source);
      if (was === undefined || r.checkedAt > was) newestOfList.set(r.source, r.checkedAt);
    }
    return rows
      .filter((r) => !isTopListMetric(r.name) || r.checkedAt === newestOfList.get(r.source))
      .map(({ pieces, ...r }) => (isAveragedMetric(r.source, r.name) ? { ...r, value: r.value / pieces } : r));
  }

  /** The newest reading of every metric of a launch, its pieces' added up, with how many there were */
  async #latestSums(launchId: number): Promise<Array<MetricReading & { pieces: number }>> {
    const last = this.#db
      .select({ source: metrics.source, name: metrics.name, at: sql<string>`max(${seen})`.as('at') })
      .from(metrics)
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.source, metrics.name)
      .as('last');
    return this.#db
      .select({
        launchId: metrics.launchId,
        source: metrics.source,
        name: metrics.name,
        value: sql<number>`sum(${metrics.value})::float8`.mapWith(Number).as('value'),
        pieces: sql<number>`count(*)::int`.mapWith(Number).as('pieces'),
        takenAt: sql<string>`max(${metrics.takenAt})`.as('taken_at'),
        checkedAt: last.at,
      })
      .from(metrics)
      .innerJoin(last, and(eq(last.source, metrics.source), eq(last.name, metrics.name), sql`${metrics.takenAt} <= ${last.at}`, sql`${seen} >= ${last.at}`))
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.launchId, metrics.source, metrics.name, last.at)
      .orderBy(asc(metrics.source), asc(metrics.name));
  }

  /** Every reading of one metric of a launch, oldest first: its curve, a point at each moment it was read */
  async metricHistory(launchId: number, source: string, name: string): Promise<MetricReading[]> {
    const rows = await this.#db
      .select({ value: metrics.value, takenAt: metrics.takenAt, checkedAt: metrics.checkedAt })
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), eq(metrics.source, source), eq(metrics.name, name)))
      .orderBy(asc(metrics.takenAt));
    const moments = rows.flatMap((r) => (r.checkedAt ? [r.takenAt, r.checkedAt] : [r.takenAt]));
    return sumsAt(rows, moments, isAveragedMetric(source, name)).map((p) => ({ launchId, source, name, value: p.value, takenAt: p.at, checkedAt: p.at }));
  }

  /**
   * Every reading of every piece of a launch, oldest first: the curves a launch's page draws beside
   * each piece. Site-level readings (no piece) are left out; `metricHistory` has those. A reading's
   * `checkedAt` is when it was last seen unchanged (its `takenAt` when never).
   */
  async postMetricHistory(launchId: number): Promise<Array<{ postId: number; name: string; value: number; takenAt: string; checkedAt: string }>> {
    const rows = await this.#db
      .select({ postId: metrics.postId, name: metrics.name, value: metrics.value, takenAt: metrics.takenAt, checkedAt: seen })
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), isNotNull(metrics.postId)))
      .orderBy(asc(metrics.takenAt));
    return rows.flatMap((r) => (r.postId === null ? [] : [{ postId: r.postId, name: r.name, value: r.value, takenAt: r.takenAt, checkedAt: r.checkedAt }]));
  }

  /** The newest reading of every metric of one piece. */
  async postMetrics(postId: number): Promise<MetricReading[]> {
    return this.#db
      .selectDistinctOn([metrics.name], { launchId: metrics.launchId, source: metrics.source, name: metrics.name, value: metrics.value, takenAt: metrics.takenAt, checkedAt: seen })
      .from(metrics)
      .where(eq(metrics.postId, postId))
      .orderBy(asc(metrics.name), desc(metrics.takenAt));
  }

  /**
   * When each piece's and each launch's numbers of a source were last read, newest first per
   * (launch, piece, source): what the hourly job compares with the source's cadence. A site source
   * keeps its names apart (`search.clicks` is read daily, `search.indexed` on its own cadence).
   */
  async lastChecked(launchIds: readonly number[]): Promise<Array<{ launchId: number; postId: number | null; source: string; name: string; at: string }>> {
    if (launchIds.length === 0) return [];
    return this.#db
      .select({ launchId: metrics.launchId, postId: metrics.postId, source: metrics.source, name: metrics.name, at: sql<string>`max(${seen})` })
      .from(metrics)
      .where(inArray(metrics.launchId, [...launchIds]))
      .groupBy(metrics.launchId, metrics.postId, metrics.source, metrics.name);
  }
}
