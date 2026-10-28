import { eq } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { nowIso, settings } from '../db/schema.ts';

/** What the owner chose (automation, the time zone, reply modes), each a JSON value under a key */
export class SettingRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Something the owner chose (automation today), as it was stored; undefined until it is first set */
  async setting<T>(key: string): Promise<T | undefined> {
    const [row] = await this.#db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return row ? (row.value as T) : undefined;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.#db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } });
  }
}
