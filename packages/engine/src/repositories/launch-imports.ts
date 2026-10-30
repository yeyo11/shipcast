import { and, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { launches, launchImports, posts } from '../db/schema.ts';

/*
 * The import of the launches drafted before Shipcast held them (docs/launch-import.md): its batch
 * log, the launch columns it sets, and the deletion of the launches decided away with every row that
 * hangs on them, kept in the log so a rollback puts them back as they were.
 */

export type ImportAction = 'import' | 'delete';

export interface ImportLogRow {
  id: number;
  batch: string;
  launchId: number;
  action: ImportAction;
  before: Record<string, unknown>;
  summary: Record<string, unknown>;
  at: string;
}

/** The launch's columns an import sets, as they were before it */
export interface ImportedColumns {
  title: string | null;
  dedupeKey: string | null;
  channelsSource: string | null;
  approvedAt: string | null;
}

/** The rows that hang on a launch, which `posts`, `metrics` and the others keep with no cascade */
export interface LaunchCounts {
  posts: number;
  comments: number;
  metrics: number;
  metricDays: number;
  publishAttempts: number;
}

/** A deleted launch's rows by table, as JSON, and the jobs and assistant sessions that named it */
export interface CapturedLaunch {
  rows: Record<string, unknown[]>;
  /** Job ids are the queue's, text */
  jobs: string[];
  assistantSessions: number[];
}

/** The tables a deletion empties, in the order a restore fills them: each row hangs on one before it */
const HISTORY: ReadonlyArray<{ table: string; where: (launchId: number) => SQL }> = [
  { table: 'launches', where: (id) => sql`id = ${id}` },
  { table: 'posts', where: (id) => sql`launch_id = ${id}` },
  { table: 'comments', where: (id) => sql`post_id IN (SELECT id FROM posts WHERE launch_id = ${id})` },
  { table: 'metrics', where: (id) => sql`launch_id = ${id}` },
  { table: 'metric_days', where: (id) => sql`launch_id = ${id}` },
  { table: 'publish_attempts', where: (id) => sql`launch_id = ${id}` },
  { table: 'draft_snapshots', where: (id) => sql`launch_id = ${id}` },
];

/** The launch model's tables an import writes, in the order a rollback empties them */
const MODEL = ['approvals', 'launch_sources', 'draft_versions', 'drafts', 'packs', 'launch_channels', 'media'] as const;

export class LaunchImportRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async #rows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
    const result: unknown = await this.#db.execute(query);
    return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
  }

  /** The batch's rows still in force (not rolled back), in the order they were written */
  async batch(batch: string): Promise<ImportLogRow[]> {
    const rows = await this.#db
      .select()
      .from(launchImports)
      .where(and(eq(launchImports.batch, batch), isNull(launchImports.rolledBackAt)))
      .orderBy(launchImports.id);
    return rows.map((r) => ({ id: r.id, batch: r.batch, launchId: r.launchId, action: r.action as ImportAction, before: r.before, summary: r.summary, at: r.at }));
  }

  /** The import or deletion in force for a launch, if a batch made one */
  async logOf(launchId: number): Promise<ImportLogRow | undefined> {
    const [r] = await this.#db
      .select()
      .from(launchImports)
      .where(and(eq(launchImports.launchId, launchId), isNull(launchImports.rolledBackAt)))
      .orderBy(desc(launchImports.id))
      .limit(1);
    return r && { id: r.id, batch: r.batch, launchId: r.launchId, action: r.action as ImportAction, before: r.before, summary: r.summary, at: r.at };
  }

  async record(row: { batch: string; launchId: number; action: ImportAction; before: Record<string, unknown>; summary: Record<string, unknown> }): Promise<void> {
    await this.#db.insert(launchImports).values(row);
  }

  async markRolledBack(batch: string): Promise<void> {
    await this.#db.update(launchImports).set({ rolledBackAt: sql`to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` }).where(and(eq(launchImports.batch, batch), isNull(launchImports.rolledBackAt)));
  }

  /** Whether any of the launch model's tables has a row of the launch: the shadow write's, or an import's */
  async holds(launchId: number): Promise<boolean> {
    const [row] = await this.#rows<{ held: boolean }>(sql`SELECT
      EXISTS (SELECT 1 FROM packs WHERE launch_id = ${launchId}) OR EXISTS (SELECT 1 FROM drafts WHERE launch_id = ${launchId})
      OR EXISTS (SELECT 1 FROM launch_channels WHERE launch_id = ${launchId}) OR EXISTS (SELECT 1 FROM launch_sources WHERE launch_id = ${launchId})
      OR EXISTS (SELECT 1 FROM media WHERE launch_id = ${launchId}) OR EXISTS (SELECT 1 FROM approvals WHERE launch_id = ${launchId}) AS held`);
    return row?.held === true;
  }

  /**
   * The rows of these launches in the launch model's tables that `batch` did not write: what a
   * rollback of the batch would leave behind or orphan, so it is refused while there are any.
   */
  async foreignRows(batch: string, launchIds: readonly number[]): Promise<string[]> {
    if (launchIds.length === 0) return [];
    const ids = sql.join(launchIds.map((id) => sql`${id}`), sql`, `);
    const rows = await this.#rows<{ what: string; n: number }>(sql`
      SELECT 'packs' AS what, count(*)::int AS n FROM packs WHERE launch_id IN (${ids}) AND import_batch IS DISTINCT FROM ${batch}
      UNION ALL SELECT 'drafts', count(*)::int FROM drafts WHERE launch_id IN (${ids}) AND import_batch IS DISTINCT FROM ${batch}
      UNION ALL SELECT 'draft_versions', count(*)::int FROM draft_versions v JOIN drafts d ON d.id = v.draft_id WHERE d.launch_id IN (${ids}) AND v.import_batch IS DISTINCT FROM ${batch}
      UNION ALL SELECT 'launch_channels', count(*)::int FROM launch_channels WHERE launch_id IN (${ids}) AND import_batch IS DISTINCT FROM ${batch}
      UNION ALL SELECT 'launch_sources', count(*)::int FROM launch_sources WHERE launch_id IN (${ids}) AND import_batch IS DISTINCT FROM ${batch}
      UNION ALL SELECT 'media', count(*)::int FROM media WHERE launch_id IN (${ids}) AND import_batch IS DISTINCT FROM ${batch}
      UNION ALL SELECT 'approvals', count(*)::int FROM approvals WHERE launch_id IN (${ids}) AND import_batch IS DISTINCT FROM ${batch}`);
    return rows.filter((r) => Number(r.n) > 0).map((r) => `${r.n} ${r.what} row${Number(r.n) === 1 ? '' : 's'} not written by the import`);
  }

  /** Removes every row the batch wrote to the launch model's tables, by table */
  async removeBatch(batch: string): Promise<Record<string, number>> {
    const removed: Record<string, number> = {};
    for (const table of MODEL) {
      const rows = await this.#rows<{ id: unknown }>(sql`DELETE FROM ${sql.raw(table)} WHERE import_batch = ${batch} RETURNING 1 AS id`);
      removed[table] = rows.length;
    }
    return removed;
  }

  async columns(launchId: number): Promise<ImportedColumns | undefined> {
    const [row] = await this.#db
      .select({ title: launches.title, dedupeKey: launches.dedupeKey, channelsSource: launches.channelsSource, approvedAt: launches.approvedAt })
      .from(launches)
      .where(eq(launches.id, launchId));
    return row;
  }

  async setColumns(launchId: number, columns: Partial<ImportedColumns>): Promise<void> {
    await this.#db.update(launches).set(columns).where(eq(launches.id, launchId));
  }

  /** The launch that holds a dedupe key, if one does */
  async dedupeKeyHolder(key: string): Promise<number | undefined> {
    const [row] = await this.#db.select({ id: launches.id }).from(launches).where(eq(launches.dedupeKey, key));
    return row?.id;
  }

  /** Points published pieces at the draft version they said; a post that names one already keeps it */
  async setPostVersions(pairs: ReadonlyArray<{ postId: number; versionId: number }>): Promise<number[]> {
    const set: number[] = [];
    for (const { postId, versionId } of pairs) {
      const rows = await this.#db.update(posts).set({ draftVersionId: versionId }).where(and(eq(posts.id, postId), isNull(posts.draftVersionId))).returning({ id: posts.id });
      if (rows.length > 0) set.push(postId);
    }
    return set;
  }

  async clearPostVersions(postIds: readonly number[]): Promise<void> {
    if (postIds.length > 0) await this.#db.update(posts).set({ draftVersionId: null }).where(inArray(posts.id, [...postIds]));
  }

  async counts(launchId: number): Promise<LaunchCounts> {
    const [row] = await this.#rows<Record<keyof LaunchCounts, number>>(sql`SELECT
      (SELECT count(*)::int FROM posts WHERE launch_id = ${launchId}) AS "posts",
      (SELECT count(*)::int FROM comments WHERE post_id IN (SELECT id FROM posts WHERE launch_id = ${launchId})) AS "comments",
      (SELECT count(*)::int FROM metrics WHERE launch_id = ${launchId}) AS "metrics",
      (SELECT count(*)::int FROM metric_days WHERE launch_id = ${launchId}) AS "metricDays",
      (SELECT count(*)::int FROM publish_attempts WHERE launch_id = ${launchId}) AS "publishAttempts"`);
    return { posts: Number(row!.posts), comments: Number(row!.comments), metrics: Number(row!.metrics), metricDays: Number(row!.metricDays), publishAttempts: Number(row!.publishAttempts) };
  }

  /** Every row of the launch's history by table, and the jobs and sessions that name it */
  async capture(launchId: number): Promise<CapturedLaunch> {
    const rows: Record<string, unknown[]> = {};
    for (const { table, where } of HISTORY) {
      const [found] = await this.#rows<{ rows: unknown[] | string }>(sql`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${sql.raw(table)} t WHERE ${where(launchId)}`);
      // PGlite answers jsonb parsed, postgres.js as text where the query names no type
      const value = found?.rows ?? [];
      rows[table] = typeof value === 'string' ? (JSON.parse(value) as unknown[]) : value;
    }
    const jobs = await this.#rows<{ id: string }>(sql`SELECT id FROM jobs WHERE launch_id = ${launchId} ORDER BY id`);
    const sessions = await this.#rows<{ id: number }>(sql`SELECT id FROM assistant_sessions WHERE launch_id = ${launchId} ORDER BY id`);
    return { rows, jobs: jobs.map((j) => String(j.id)), assistantSessions: sessions.map((s) => Number(s.id)) };
  }

  /** Removes the launch and its history; jobs and assistant sessions keep their rows, unlinked */
  async removeLaunch(launchId: number): Promise<void> {
    for (const { table, where } of [...HISTORY].reverse()) await this.#db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE ${where(launchId)}`);
  }

  /** Puts a captured launch back as it was, ids and all */
  async restore(launchId: number, captured: CapturedLaunch): Promise<void> {
    for (const { table } of HISTORY) {
      const rows = captured.rows[table] ?? [];
      if (rows.length === 0) continue;
      await this.#db.execute(sql`INSERT INTO ${sql.raw(table)} SELECT * FROM jsonb_populate_recordset(NULL::${sql.raw(table)}, ${JSON.stringify(rows)}::jsonb)`);
    }
    if (captured.jobs.length > 0) await this.#db.execute(sql`UPDATE jobs SET launch_id = ${launchId} WHERE id IN (${sql.join(captured.jobs.map((id) => sql`${id}`), sql`, `)})`);
    if (captured.assistantSessions.length > 0) {
      await this.#db.execute(sql`UPDATE assistant_sessions SET launch_id = ${launchId} WHERE id IN (${sql.join(captured.assistantSessions.map((id) => sql`${id}`), sql`, `)})`);
    }
  }

  /**
   * The owner's input of each article launch still in pg-boss's job table (an install that ran on
   * pg-boss keeps it there after the job completed): the only record of their own text before the
   * AI and their edits. None where pg-boss never ran.
   */
  async articleInputsFromJobs(): Promise<Array<{ launchId: number; input: Record<string, unknown> }>> {
    const [exists] = await this.#rows<{ found: string | null }>(sql`SELECT to_regclass('pgboss.job')::text AS found`);
    if (!exists?.found) return [];
    const rows = await this.#rows<{ data: Record<string, unknown> | string }>(sql`SELECT data FROM pgboss.job WHERE name = 'article' AND data ? 'input' AND data ? 'launchId' ORDER BY created_on`);
    return rows.flatMap((r) => {
      const data = typeof r.data === 'string' ? (JSON.parse(r.data) as Record<string, unknown>) : r.data;
      const launchId = Number(data.launchId);
      return Number.isInteger(launchId) && typeof data.input === 'object' && data.input !== null ? [{ launchId, input: data.input as Record<string, unknown> }] : [];
    });
  }
}
