import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { cursors } from '../db/schema.ts';

/** Small pieces of polling and pacing state under a key: an ETag, the last round, a channel's failure */
export class CursorRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Small pieces of polling state, such as the ETag of the last events page; what the owner chooses is a setting */
  async cursor(key: string): Promise<string | undefined> {
    const [row] = await this.#db.select({ value: cursors.value }).from(cursors).where(eq(cursors.key, key));
    return row?.value;
  }

  async setCursor(key: string, value: string): Promise<void> {
    await this.#db.insert(cursors).values({ key, value }).onConflictDoUpdate({ target: cursors.key, set: { value } });
  }

  async deleteCursor(key: string): Promise<void> {
    await this.#db.delete(cursors).where(eq(cursors.key, key));
  }

  /** Every cursor whose key starts with a prefix, such as the failures of one launch (`publish-failed:12:`) */
  async cursorsWithPrefix(prefix: string): Promise<Array<{ key: string; value: string }>> {
    // starts_with, not LIKE: a `_` in the prefix is a character, not a wildcard. Ordered bytewise, as
    // SQLite did, whatever collation the database was created with
    return this.#db
      .select({ key: cursors.key, value: cursors.value })
      .from(cursors)
      .where(sql`starts_with(${cursors.key}, ${prefix})`)
      .orderBy(sql`${cursors.key} COLLATE "C"`);
  }
}
