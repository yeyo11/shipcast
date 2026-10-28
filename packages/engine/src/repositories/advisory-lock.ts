import { sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';

/** Runs work while no other holder of the same key, in any process, runs work of its own */
export interface Lock {
  run<T>(key: string, work: () => Promise<T>): Promise<T>;
}

/**
 * A lock across every process on the registry's Postgres: a transaction-level advisory lock held
 * while `work` runs, released when the transaction ends, so a process that dies releases it too.
 * For short critical sections (a token refresh), since it keeps a connection for the duration;
 * Redis's lock takes over where work is long or Postgres is not shared.
 */
export class PostgresLock implements Lock {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    return this.#db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lock:${key}`}))`);
      return work();
    });
  }
}

/** The lock of one process: what a single install without a shared database needs */
export class LocalLock implements Lock {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    const tail = next.catch(() => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return next;
  }
}
