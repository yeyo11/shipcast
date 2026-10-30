import { and, desc, eq } from 'drizzle-orm';
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
}
