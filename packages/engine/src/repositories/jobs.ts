import { and, count, desc, eq, gte, inArray, lt, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { jobs, nowIso } from '../db/schema.ts';

/** A job's state, as pg-boss names them; `retry` waits for its next attempt */
export type JobState = 'created' | 'active' | 'retry' | 'completed' | 'failed';

export const UNFINISHED_JOB_STATES: readonly JobState[] = ['created', 'active', 'retry'];

/** How many log lines a job keeps: enough to tell what happened, never a growing table */
export const JOB_LOG_LINES = 40;

/** What the app shows of one job of the queue, kept after it ends and across restarts */
export interface JobRecord {
  /** pg-boss's id of the job */
  id: string;
  queue: string;
  /** What it is, in words: "Drafting yeyo11/claudio v0.9.0" */
  title: string;
  launchId: number | null;
  state: JobState;
  /** Attempts started so far; a job waiting for a deploy takes several */
  attempts: number;
  log: string[];
  /** Where to go once it is done: a pull request, a launch */
  link: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface JobChange {
  title?: string;
  state?: JobState;
  attempts?: number;
  link?: string | null;
  /** Sets the start to now, unless it was set by an earlier attempt */
  started?: boolean;
  /** Sets the end to now, or clears it when a job goes back to waiting */
  ended?: boolean;
}

/** Where a page of the work list starts: the last job of the previous one */
export interface JobCursor {
  createdAt: string;
  id: string;
}

/** Which jobs: a page's bounds aside */
export interface JobConditions {
  launchId?: number;
  /** Created at or after this moment */
  since?: string;
  states?: readonly JobState[];
  queues?: readonly string[];
  /**
   * Only what the work list shows: rounds run all day and Automation has the last one, so a round
   * is listed only while running or when it failed, and a job that found automation off not at all.
   * Kept in SQL so a page and its counts are cut by the database, never after the query.
   */
  listed?: boolean;
}

export interface JobFilter extends JobConditions {
  limit?: number;
  /** For numbered pages: how many of the newest to skip */
  offset?: number;
  /** For a cursor: only the jobs older than this one */
  before?: JobCursor;
}

function jobConditions(filter: JobConditions): SQL[] {
  const where: SQL[] = [];
  if (filter.launchId !== undefined) where.push(eq(jobs.launchId, filter.launchId));
  if (filter.since !== undefined) where.push(gte(jobs.createdAt, filter.since));
  if (filter.states) where.push(inArray(jobs.state, [...filter.states]));
  if (filter.queues) where.push(inArray(jobs.queue, [...filter.queues]));
  if (filter.listed) {
    where.push(sql`(${jobs.queue} <> 'round' OR ${jobs.state} IN ('active', 'failed'))`);
    where.push(sql`NOT (${jobs.state} = 'completed' AND coalesce(${jobs.log} ->> 0, '') LIKE 'Automation is off%')`);
  }
  return where;
}

function toJob(row: typeof jobs.$inferSelect): JobRecord {
  return { ...row, state: row.state as JobState, log: Array.isArray(row.log) ? row.log : [] };
}

/** What the app shows of the queue's jobs, kept after they end and across restarts */
export class JobRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Records a job of the queue; a second record of the same id keeps the first and returns it */
  async recordJob(job: { id: string; queue: string; title: string; launchId?: number | null }): Promise<JobRecord> {
    const [inserted] = await this.#db
      .insert(jobs)
      .values({ id: job.id, queue: job.queue, title: job.title, launchId: job.launchId ?? null })
      .onConflictDoNothing({ target: jobs.id })
      .returning();
    return inserted ? toJob(inserted) : (await this.job(job.id))!;
  }

  async updateJob(id: string, change: JobChange): Promise<void> {
    const set: Partial<{ [K in keyof typeof jobs.$inferInsert]: (typeof jobs.$inferInsert)[K] | SQL }> = {};
    if (change.title !== undefined) set.title = change.title;
    if (change.state !== undefined) set.state = change.state;
    if (change.attempts !== undefined) set.attempts = change.attempts;
    if (change.link !== undefined) set.link = change.link;
    if (change.started) set.startedAt = sql`coalesce(${jobs.startedAt}, ${nowIso})`;
    if (change.ended !== undefined) set.endedAt = change.ended ? nowIso : null;
    if (Object.keys(set).length === 0) return;
    await this.#db.update(jobs).set(set).where(eq(jobs.id, id));
  }

  /** Adds a line to a job's log, dropping the oldest once it holds JOB_LOG_LINES */
  async logJob(id: string, line: string): Promise<void> {
    const appended = sql`${jobs.log} || to_jsonb(${line}::text)`;
    await this.#db
      .update(jobs)
      // `jsonb - 0` drops the first element; one line in, one out keeps the log bounded
      .set({ log: sql`CASE WHEN jsonb_array_length(${jobs.log}) >= ${JOB_LOG_LINES} THEN (${appended}) - 0 ELSE ${appended} END` })
      .where(eq(jobs.id, id));
  }

  async job(id: string): Promise<JobRecord | undefined> {
    const [row] = await this.#db.select().from(jobs).where(eq(jobs.id, id));
    return row ? toJob(row) : undefined;
  }

  /** The newest first: a launch's, those created since a moment, those in some states; a page at a time with `offset` or `before` */
  async jobs(filter: JobFilter = {}): Promise<JobRecord[]> {
    const where = jobConditions(filter);
    // Keyset: the jobs strictly older than the last one of the previous page, in the list's own order
    if (filter.before) where.push(sql`(${jobs.createdAt}, ${jobs.id}) < (${filter.before.createdAt}, ${filter.before.id})`);
    const query = this.#db
      .select()
      .from(jobs)
      .where(and(...where))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(filter.limit ?? 100)
      .$dynamic();
    return (await (filter.offset ? query.offset(filter.offset) : query)).map(toJob);
  }

  /** How many jobs of a filter are in each state, from one grouped query whatever their number */
  async jobCounts(filter: JobConditions = {}): Promise<Record<JobState, number>> {
    const rows = await this.#db
      .select({ state: jobs.state, n: count() })
      .from(jobs)
      .where(and(...jobConditions(filter)))
      .groupBy(jobs.state);
    const counts: Record<JobState, number> = { created: 0, active: 0, retry: 0, completed: 0, failed: 0 };
    for (const row of rows) if (row.state in counts) counts[row.state as JobState] = Number(row.n);
    return counts;
  }

  /** Forgets the jobs that ended before a moment; returns how many */
  async pruneJobs(endedBefore: string): Promise<number> {
    const deleted = await this.#db.delete(jobs).where(lt(jobs.endedAt, endedBefore)).returning({ id: jobs.id });
    return deleted.length;
  }
}
