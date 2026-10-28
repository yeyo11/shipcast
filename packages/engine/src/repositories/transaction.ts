import { sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';

/**
 * Runs `work` in one transaction on `db`. Every repository takes a Database, and a transaction is
 * one too, so a use case that must write through several repositories at once builds them over the
 * `tx` it is given (Repositories.transaction does it for the whole set); a nested call becomes a
 * savepoint, which is what lets a repository open its own transaction inside the caller's.
 */
export function transaction<T>(db: Database, work: (tx: Database) => Promise<T>): Promise<T> {
  return db.transaction((tx) => work(tx));
}

/**
 * Holds a transaction-level advisory lock on `key` until the transaction `tx` runs in ends: the way
 * two writers of the same rows (a network's accounts, one piece's schedule) are put one after the
 * other where read committed would let both see the state before either wrote.
 */
export async function lockFor(tx: Database, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}
