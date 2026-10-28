import { sql } from 'drizzle-orm';
import type { Repositories } from '../repositories/index.ts';
import type { CheckResult, TelemetryStore } from './store.ts';

/** A scheduled piece this late and still waiting has missed its time */
export const MISSED_AFTER_MINUTES = 10;
/** A scheduled piece that went out this much after its time went out late */
export const LATE_AFTER_MINUTES = 5;

const HOUR = 3_600_000;

/**
 * The checks the refactor is held to (docs/plans/performance-refactor.md, "Instrumentation"), read
 * from the registry only, so running them costs no provider call:
 * - `missed-schedules`: scheduled pieces whose time passed and that are still waiting;
 * - `late-posts`: pieces that went out more than five minutes after their time, in the last day;
 * - `duplicate-pieces`: more than one live row of a launch's channel and kind, or two rows with the
 *   same network id: what a double publish leaves behind;
 * - `freshness`: the age of each live piece's newest reading, per channel, against the cadence the
 *   numbers are read at (`cadenceHours`).
 */
export async function runChecks(registry: Repositories, store: TelemetryStore, options: { now?: Date; cadenceHours: number }): Promise<CheckResult[]> {
  const now = options.now ?? new Date();
  const results = [await missedSchedules(registry, now), await latePosts(registry, now), await duplicatePieces(registry), await freshness(registry, now, options.cadenceHours)];
  for (const result of results) await store.recordCheck(result);
  return results;
}

async function missedSchedules(registry: Repositories, now: Date): Promise<CheckResult> {
  const before = new Date(now.getTime() - MISSED_AFTER_MINUTES * 60_000).toISOString();
  const rows = await registry.queries.selectRows<{ id: number; launch_id: number; channel: string; scheduled_at: string }>(
    sql`SELECT id, launch_id, channel, scheduled_at FROM posts WHERE status = 'scheduled' AND scheduled_at < ${before} ORDER BY scheduled_at`,
  );
  return { name: 'missed-schedules', ok: rows.length === 0, value: rows.length, detail: { posts: rows.map((r) => ({ id: r.id, launchId: r.launch_id, channel: r.channel, scheduledAt: r.scheduled_at })) } };
}

async function latePosts(registry: Repositories, now: Date): Promise<CheckResult> {
  const since = new Date(now.getTime() - 24 * HOUR).toISOString();
  const rows = await registry.queries.selectRows<{ id: number; channel: string; scheduled_at: string; published_at: string }>(
    sql`SELECT id, channel, scheduled_at, published_at FROM posts
        WHERE scheduled_at IS NOT NULL AND status <> 'scheduled' AND published_at >= ${since}
          AND published_at::timestamptz - scheduled_at::timestamptz > make_interval(mins => ${LATE_AFTER_MINUTES})`,
  );
  const scheduled = await registry.queries.selectRows<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM posts WHERE scheduled_at IS NOT NULL AND status <> 'scheduled' AND published_at >= ${since}`,
  );
  return {
    name: 'late-posts',
    ok: rows.length === 0,
    value: rows.length,
    detail: { scheduledPublished: scheduled[0]?.n ?? 0, posts: rows.map((r) => ({ id: r.id, channel: r.channel, scheduledAt: r.scheduled_at, publishedAt: r.published_at })) },
  };
}

async function duplicatePieces(registry: Repositories): Promise<CheckResult> {
  const pieces = await registry.queries.selectRows<{ launch_id: number; channel: string; kind: string; n: number }>(
    sql`SELECT launch_id, channel, kind, count(*)::int AS n FROM posts WHERE status IN ('live', 'edited') GROUP BY launch_id, channel, kind HAVING count(*) > 1`,
  );
  const ids = await registry.queries.selectRows<{ channel: string; external_id: string; n: number }>(
    sql`SELECT channel, external_id, count(*)::int AS n FROM posts WHERE external_id IS NOT NULL GROUP BY channel, external_id HAVING count(*) > 1`,
  );
  return {
    name: 'duplicate-pieces',
    ok: pieces.length === 0 && ids.length === 0,
    value: pieces.length + ids.length,
    detail: { sameChannelAndKind: pieces.map((p) => ({ launchId: p.launch_id, channel: p.channel, kind: p.kind, rows: p.n })), sameNetworkId: ids.map((i) => ({ channel: i.channel, rows: i.n })) },
  };
}

interface ChannelFreshness {
  posts: number;
  neverRead: number;
  withinCadence: number;
  within1h: number;
  within24h: number;
  maxAgeHours: number | null;
}

async function freshness(registry: Repositories, now: Date, cadenceHours: number): Promise<CheckResult> {
  // Only the channels that have ever been read: a channel Shipcast reads no numbers for is not stale
  const rows = await registry.queries.selectRows<{ channel: string; newest: string | null }>(
    sql`SELECT p.channel, max(m.taken_at) AS newest FROM posts p LEFT JOIN metrics m ON m.post_id = p.id
        WHERE p.status IN ('live', 'edited') AND p.external_id IS NOT NULL
          AND p.channel IN (SELECT DISTINCT p2.channel FROM metrics m2 JOIN posts p2 ON p2.id = m2.post_id)
        GROUP BY p.id, p.channel`,
  );
  const byChannel: Record<string, ChannelFreshness> = {};
  let fresh = 0;
  let fresh1h = 0;
  for (const row of rows) {
    const c = (byChannel[row.channel] ??= { posts: 0, neverRead: 0, withinCadence: 0, within1h: 0, within24h: 0, maxAgeHours: null });
    c.posts += 1;
    if (row.newest === null) {
      c.neverRead += 1;
      continue;
    }
    const age = (now.getTime() - Date.parse(row.newest)) / HOUR;
    c.maxAgeHours = Math.max(c.maxAgeHours ?? 0, Math.round(age * 100) / 100);
    // An hour of slack over the cadence: a run takes a while and starts on the cron's minute
    if (age <= cadenceHours + 1) {
      c.withinCadence += 1;
      fresh += 1;
    }
    if (age <= 1) {
      c.within1h += 1;
      fresh1h += 1;
    }
    if (age <= 24) c.within24h += 1;
  }
  const share = rows.length === 0 ? 1 : fresh / rows.length;
  return {
    name: 'freshness',
    ok: share >= 0.99,
    value: share,
    detail: { cadenceHours, posts: rows.length, within1hShare: rows.length === 0 ? 1 : fresh1h / rows.length, channels: byChannel },
  };
}
