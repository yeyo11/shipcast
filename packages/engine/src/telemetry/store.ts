import { and, asc, gte, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { checks, providerCalls, timings } from '../db/schema.ts';
import type { Histogram } from './histogram.ts';

/** One hour's count of outbound calls of one kind, from one process */
export interface CallCount {
  hour: string;
  process: string;
  origin: string;
  provider: string;
  method: string;
  endpoint: string;
  status: number;
  calls: number;
  totalMs: number;
  bytes: number;
  latency: Histogram;
  quotaPeak?: number;
  quotaLimit?: number;
}

/** One hour's durations of one kind of the app's own work, from one process */
export interface TimingCount {
  hour: string;
  process: string;
  kind: TimingKind;
  name: string;
  outcome: TimingOutcome;
  count: number;
  totalMs: number;
  maxMs: number;
  latency: Histogram;
}

export type TimingKind = 'fn' | 'request' | 'job' | 'job-wait' | 'browser';
export type TimingOutcome = 'ok' | 'error' | 'retry';

export interface CheckResult {
  name: string;
  ok: boolean;
  value: number;
  detail?: Record<string, unknown>;
}

export interface StoredCheck extends Required<CheckResult> {
  id: number;
  takenAt: string;
}

/** Hours in [from, to), ISO 8601 */
export interface HourRange {
  from: string;
  to: string;
}

// Adds two {bucket: count} objects key by key, inside the upsert: two processes flushing the same
// hour, or one flushing it twice, add up instead of overwriting each other
const mergeLatency = (column: string): SQL =>
  sql.raw(`(SELECT coalesce(jsonb_object_agg(key, total), '{}'::jsonb) FROM (SELECT key, sum(value::numeric) AS total FROM (SELECT * FROM jsonb_each_text(${column}.latency) UNION ALL SELECT * FROM jsonb_each_text(excluded.latency)) AS both_sides GROUP BY key) AS sums)`);

/**
 * The measurement's rows (provider_calls, timings, checks), apart from the registry's: phase 0 of
 * docs/plans/performance-refactor.md. Writes only add to an hour's row, so any number of processes
 * flush into the same hours safely.
 */
export class TelemetryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async addCalls(rows: CallCount[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#db
      .insert(providerCalls)
      .values(rows.map((r) => ({ ...r, quotaPeak: r.quotaPeak ?? null, quotaLimit: r.quotaLimit ?? null })))
      .onConflictDoUpdate({
        target: [providerCalls.hour, providerCalls.process, providerCalls.origin, providerCalls.provider, providerCalls.method, providerCalls.endpoint, providerCalls.status],
        set: {
          calls: sql`${providerCalls.calls} + excluded.calls`,
          totalMs: sql`${providerCalls.totalMs} + excluded.total_ms`,
          bytes: sql`${providerCalls.bytes} + excluded.bytes`,
          latency: mergeLatency('provider_calls'),
          quotaPeak: sql`greatest(${providerCalls.quotaPeak}, excluded.quota_peak)`,
          quotaLimit: sql`coalesce(excluded.quota_limit, ${providerCalls.quotaLimit})`,
        },
      });
  }

  async addTimings(rows: TimingCount[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#db
      .insert(timings)
      .values(rows)
      .onConflictDoUpdate({
        target: [timings.hour, timings.process, timings.kind, timings.name, timings.outcome],
        set: {
          count: sql`${timings.count} + excluded.count`,
          totalMs: sql`${timings.totalMs} + excluded.total_ms`,
          maxMs: sql`greatest(${timings.maxMs}, excluded.max_ms)`,
          latency: mergeLatency('timings'),
        },
      });
  }

  async recordCheck(check: CheckResult): Promise<void> {
    await this.#db.insert(checks).values({ name: check.name, ok: check.ok, value: check.value, detail: check.detail ?? {} });
  }

  async calls(range: HourRange): Promise<CallCount[]> {
    const rows = await this.#db
      .select()
      .from(providerCalls)
      .where(and(gte(providerCalls.hour, range.from), lt(providerCalls.hour, range.to)))
      .orderBy(asc(providerCalls.hour));
    return rows.map(({ quotaPeak, quotaLimit, ...r }) => ({ ...r, ...(quotaPeak !== null && { quotaPeak }), ...(quotaLimit !== null && { quotaLimit }) }));
  }

  async timings(range: HourRange): Promise<TimingCount[]> {
    const rows = await this.#db
      .select()
      .from(timings)
      .where(and(gte(timings.hour, range.from), lt(timings.hour, range.to)))
      .orderBy(asc(timings.hour));
    return rows.map((r) => ({ ...r, kind: r.kind as TimingKind, outcome: r.outcome as TimingOutcome }));
  }

  async checks(range: HourRange): Promise<StoredCheck[]> {
    return this.#db
      .select()
      .from(checks)
      .where(and(gte(checks.takenAt, range.from), lt(checks.takenAt, range.to)))
      .orderBy(asc(checks.takenAt), asc(checks.id));
  }
}

/** The start of the UTC hour a moment falls in, as the rows key it */
export function hourOf(at: Date): string {
  const hour = new Date(at);
  hour.setUTCMinutes(0, 0, 0);
  return hour.toISOString();
}
