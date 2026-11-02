import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { launchDeletions } from '../db/schema.ts';

/** `removed`: a launch never published, gone with its rows; `hidden`: a published one, soft-deleted */
export type DeletionMode = 'removed' | 'hidden';

export interface LaunchDeletion {
  id: number;
  launchId: number;
  dedupeKey: string;
  repo: string;
  ref: string;
  mode: DeletionMode;
  by: string;
  at: string;
  /** The channels whose posts were deleted on the networks too */
  channels: string[];
  /** Posts still out that linked the article removed with it; null when the blog was not among the channels */
  articleLinks: number | null;
}

export type NewLaunchDeletion = Omit<LaunchDeletion, 'id' | 'at'>;

/** The tables a launch removed with its rows empties, parents first: each row hangs on one before it, with no cascade */
const HISTORY: ReadonlyArray<{ table: string; where: (launchId: number) => SQL }> = [
  { table: 'launches', where: (id) => sql`id = ${id}` },
  { table: 'posts', where: (id) => sql`launch_id = ${id}` },
  { table: 'comments', where: (id) => sql`post_id IN (SELECT id FROM posts WHERE launch_id = ${id})` },
  { table: 'metrics', where: (id) => sql`launch_id = ${id}` },
  { table: 'metric_days', where: (id) => sql`launch_id = ${id}` },
  { table: 'publish_attempts', where: (id) => sql`launch_id = ${id}` },
  { table: 'draft_snapshots', where: (id) => sql`launch_id = ${id}` },
];

/**
 * The launches the owner deleted (docs/launch-delete.md): who and when, what went from the networks,
 * and the key a trigger checks so a release whose launch was removed is never launched again.
 */
export class LaunchDeletionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async record(deletion: NewLaunchDeletion): Promise<LaunchDeletion> {
    const [row] = await this.#db.insert(launchDeletions).values(deletion).returning();
    return { ...row!, mode: row!.mode as DeletionMode };
  }

  /** Whether the launch this key names was removed by the owner, so no event launches it again */
  async removed(dedupeKey: string): Promise<boolean> {
    const [row] = await this.#db
      .select({ id: launchDeletions.id })
      .from(launchDeletions)
      .where(and(eq(launchDeletions.dedupeKey, dedupeKey), eq(launchDeletions.mode, 'removed')))
      .limit(1);
    return row !== undefined;
  }

  /** The launch's deletion, the last one when it was hidden and then removed */
  async ofLaunch(launchId: number): Promise<LaunchDeletion | undefined> {
    const [row] = await this.#db.select().from(launchDeletions).where(eq(launchDeletions.launchId, launchId)).orderBy(desc(launchDeletions.id)).limit(1);
    return row ? { ...row, mode: row.mode as DeletionMode } : undefined;
  }

  /** Removes the launch and its history, children first; jobs and assistant sessions keep their rows, unlinked */
  async removeLaunch(launchId: number): Promise<void> {
    for (const { table, where } of [...HISTORY].reverse()) await this.#db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE ${where(launchId)}`);
  }
}
