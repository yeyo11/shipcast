import type { SQL } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';

/** `%`, `_` and `\` in what the owner typed are letters, not LIKE's wildcards */
export const likePattern = (words: string) => `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The rows of a read-only query the query builder cannot say (window functions, FILTER, VALUES),
 * for the reports in stats.ts and the checks in telemetry/checks.ts. Each driver shapes `execute`'s
 * answer its own way: postgres.js gives the rows as an array, PGlite an object holding them.
 */
export class RawQueries {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async selectRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
    const result: unknown = await this.#db.execute(query);
    if (Array.isArray(result)) return result as T[];
    return (result as { rows: T[] }).rows;
  }
}
