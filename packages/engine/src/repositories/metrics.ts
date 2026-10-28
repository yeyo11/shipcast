import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { metrics } from '../db/schema.ts';

/**
 * One number read from one source for one launch, at one moment. A launch's readings add up its
 * pieces': two newsletter issues read in one round are one reading of the newsletter.
 */
export interface MetricReading {
  launchId: number;
  /** A channel (`devto`, `bluesky`…), or a site-level source (`blog`, `search`, `github`) */
  source: string;
  name: string;
  value: number;
  takenAt: string;
}

// A round reads every piece at the same moment, so a launch's reading at a moment is its pieces' sum
const summed = {
  launchId: metrics.launchId,
  source: metrics.source,
  name: metrics.name,
  value: sql<number>`sum(${metrics.value})::float8`.mapWith(Number).as('value'),
  takenAt: metrics.takenAt,
};

/** The numbers read for each launch and each of its pieces, a reading a row */
export class MetricRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** `postId` for a reading of one piece; without it the reading is the launch's, as a site-level source's is */
  async recordMetrics(launchId: number, source: string, values: Record<string, number>, takenAt: Date, postId: number | null = null): Promise<void> {
    const at = takenAt.toISOString();
    const rows = Object.entries(values)
      .filter(([, value]) => Number.isFinite(value))
      .map(([name, value]) => ({ launchId, postId, source, name, value, takenAt: at }));
    if (rows.length > 0) await this.#db.insert(metrics).values(rows);
  }

  /** The newest reading of every metric of a launch, its pieces' added up. */
  async latestMetrics(launchId: number): Promise<MetricReading[]> {
    const last = this.#db
      .select({ source: metrics.source, name: metrics.name, at: sql<string>`max(${metrics.takenAt})`.as('at') })
      .from(metrics)
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.source, metrics.name)
      .as('last');
    return this.#db
      .select(summed)
      .from(metrics)
      .innerJoin(last, and(eq(last.source, metrics.source), eq(last.name, metrics.name), eq(last.at, metrics.takenAt)))
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.launchId, metrics.source, metrics.name, metrics.takenAt)
      .orderBy(asc(metrics.source), asc(metrics.name));
  }

  /** Every reading of one metric of a launch, oldest first: its curve. */
  async metricHistory(launchId: number, source: string, name: string): Promise<MetricReading[]> {
    return this.#db
      .select(summed)
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), eq(metrics.source, source), eq(metrics.name, name)))
      .groupBy(metrics.launchId, metrics.source, metrics.name, metrics.takenAt)
      .orderBy(asc(metrics.takenAt));
  }

  /**
   * Every reading of every piece of a launch, oldest first: the curves a launch's page draws beside
   * each piece. Site-level readings (no piece) are left out; `metricHistory` has those.
   */
  async postMetricHistory(launchId: number): Promise<Array<{ postId: number; name: string; value: number; takenAt: string }>> {
    const rows = await this.#db
      .select({ postId: metrics.postId, name: metrics.name, value: metrics.value, takenAt: metrics.takenAt })
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), sql`${metrics.postId} IS NOT NULL`))
      .orderBy(asc(metrics.takenAt));
    return rows.flatMap((r) => (r.postId === null ? [] : [{ postId: r.postId, name: r.name, value: r.value, takenAt: r.takenAt }]));
  }

  /** The newest reading of every metric of one piece. */
  async postMetrics(postId: number): Promise<MetricReading[]> {
    const last = this.#db
      .select({ name: metrics.name, at: sql<string>`max(${metrics.takenAt})`.as('at') })
      .from(metrics)
      .where(eq(metrics.postId, postId))
      .groupBy(metrics.name)
      .as('last');
    return this.#db
      .select(summed)
      .from(metrics)
      .innerJoin(last, and(eq(last.name, metrics.name), eq(last.at, metrics.takenAt)))
      .where(eq(metrics.postId, postId))
      .groupBy(metrics.launchId, metrics.source, metrics.name, metrics.takenAt)
      .orderBy(asc(metrics.name));
  }
}
