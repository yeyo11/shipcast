import { inArray, notInArray } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { attentionDismissals } from '../db/schema.ts';

/** The bell's lines the owner dismissed, by key, until their condition ends */
export class AttentionRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Hides the bell's lines with these keys; dismissing one twice keeps its first time */
  async dismissAttention(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.#db
      .insert(attentionDismissals)
      .values([...new Set(keys)].map((key) => ({ key })))
      .onConflictDoNothing();
  }

  /** Which of these keys were dismissed */
  async dismissedAttention(keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.#db.select({ key: attentionDismissals.key }).from(attentionDismissals).where(inArray(attentionDismissals.key, [...keys]));
    return new Set(rows.map((r) => r.key));
  }

  /**
   * Forgets every dismissal but those of `keep`: the bell passes the lines it has now, so the
   * dismissal of a line whose condition ended goes, and the same condition coming back is shown again
   */
  async clearAttentionDismissals(keep: readonly string[] = []): Promise<number> {
    const rows = await this.#db
      .delete(attentionDismissals)
      .where(keep.length > 0 ? notInArray(attentionDismissals.key, [...keep]) : undefined)
      .returning({ key: attentionDismissals.key });
    return rows.length;
  }
}
