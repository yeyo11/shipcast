import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { nowIso, secrets } from '../db/schema.ts';

/** One secret's row, still sealed: opening it is the secret store's job, which holds the master key */
export interface SecretRow {
  key: string;
  label: string;
  sealed: string;
  sealedKey: string;
  version: number;
  updatedAt: string;
}

/**
 * The `secrets` table's rows (docs/plans/performance-refactor.md, phase 5). It never sees a value in
 * the clear: the store above it (runtime's TableStore) seals and opens them. Every write is one
 * statement on one row, and bumps the row's version.
 */
export class SecretRows {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async get(key: string): Promise<SecretRow | undefined> {
    const [row] = await this.#db.select().from(secrets).where(eq(secrets.key, key));
    return row;
  }

  /** Writes a row whatever its version; a label left empty keeps the one there */
  async put(row: Pick<SecretRow, 'key' | 'label' | 'sealed' | 'sealedKey'>): Promise<void> {
    await this.#db
      .insert(secrets)
      .values(row)
      .onConflictDoUpdate({
        target: secrets.key,
        set: { sealed: row.sealed, sealedKey: row.sealedKey, label: sql`CASE WHEN excluded.label = '' THEN ${secrets.label} ELSE excluded.label END`, version: sql`${secrets.version} + 1`, updatedAt: nowIso },
      });
  }

  /** Writes only over `version` (0: only if absent); false when another writer got there first */
  async putIfVersion(row: Pick<SecretRow, 'key' | 'label' | 'sealed' | 'sealedKey'>, version: number): Promise<boolean> {
    if (version === 0) return (await this.#db.insert(secrets).values(row).onConflictDoNothing().returning({ key: secrets.key })).length === 1;
    const updated = await this.#db
      .update(secrets)
      .set({ sealed: row.sealed, sealedKey: row.sealedKey, version: sql`${secrets.version} + 1`, updatedAt: nowIso })
      .where(and(eq(secrets.key, row.key), eq(secrets.version, version)))
      .returning({ key: secrets.key });
    return updated.length === 1;
  }

  async delete(key: string): Promise<void> {
    await this.#db.delete(secrets).where(eq(secrets.key, key));
  }

  async keys(): Promise<string[]> {
    return (await this.#db.select({ key: secrets.key }).from(secrets)).map((r) => r.key);
  }
}
