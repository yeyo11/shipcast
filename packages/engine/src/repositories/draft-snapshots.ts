import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { draftSnapshots, nowIso } from '../db/schema.ts';

export interface DraftSnapshotFile {
  path: string;
  /** The text of an article or a channel's draft; null for media and data, listed without reading */
  content: string | null;
  sha: string | null;
}

/** A launch's drafts pull request as Shipcast last read it */
export interface DraftSnapshot {
  launchId: number;
  pullRequest: { number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string };
  headSha: string | null;
  launchYml: string | null;
  files: DraftSnapshotFile[];
  readAt: string;
}

export type DraftSnapshotInput = Omit<DraftSnapshot, 'readAt'> & { readAt?: string };

type Row = typeof draftSnapshots.$inferSelect;

const fromRow = (row: Row): DraftSnapshot => ({
  launchId: row.launchId,
  pullRequest: { number: row.prNumber, url: row.url, state: row.state as DraftSnapshot['pullRequest']['state'], branch: row.branch },
  headSha: row.headSha,
  launchYml: row.launchYml,
  files: row.files,
  readAt: row.readAt,
});

/** The drafts snapshots: what the launch page reads instead of GitHub (phase 7) */
export class DraftSnapshotRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async snapshot(launchId: number): Promise<DraftSnapshot | undefined> {
    const [row] = await this.#db.select().from(draftSnapshots).where(eq(draftSnapshots.launchId, launchId));
    return row ? fromRow(row) : undefined;
  }

  async snapshots(launchIds: readonly number[]): Promise<DraftSnapshot[]> {
    if (launchIds.length === 0) return [];
    return (await this.#db.select().from(draftSnapshots).where(inArray(draftSnapshots.launchId, [...launchIds]))).map(fromRow);
  }

  /** Writes the launch's reading, replacing the one before: only the latest matters */
  async saveSnapshot(input: DraftSnapshotInput): Promise<DraftSnapshot> {
    const values = {
      prNumber: input.pullRequest.number,
      url: input.pullRequest.url,
      branch: input.pullRequest.branch,
      state: input.pullRequest.state,
      headSha: input.headSha,
      launchYml: input.launchYml,
      files: input.files,
      readAt: input.readAt ?? nowIso,
    };
    const [row] = await this.#db
      .insert(draftSnapshots)
      .values({ launchId: input.launchId, ...values })
      .onConflictDoUpdate({ target: draftSnapshots.launchId, set: values })
      .returning();
    return fromRow(row!);
  }

  /**
   * One draft's text as Shipcast just committed it. Its sha and the head are no longer known: GitHub's
   * `synchronize` delivery (or the next poll) fills them in. The reading time stays: the rest of the
   * row is as old as it was.
   */
  async patchSnapshotFile(launchId: number, path: string, content: string): Promise<boolean> {
    const current = await this.snapshot(launchId);
    if (!current) return false;
    const files = current.files.some((f) => f.path === path) ? current.files.map((f) => (f.path === path ? { path, content, sha: null } : f)) : [...current.files, { path, content, sha: null }];
    await this.#db.update(draftSnapshots).set({ files, headSha: null }).where(eq(draftSnapshots.launchId, launchId));
    return true;
  }
}
