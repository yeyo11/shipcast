import { DatabaseSync } from 'node:sqlite';
import { sql } from 'drizzle-orm';
import { FIRST_MIGRATION, migrateDatabase, type Database } from './connect.ts';

/*
 * Moves a registry kept by the old node:sqlite engine (`data/shipcast.db`) into Postgres, row for
 * row, into the first migration's schema, which is SQLite's column for column; the later migrations
 * then convert it as they convert any install (one row per piece, settings out of the cursors).
 * scripts/sqlite-to-postgres.ts is the command around it.
 */

/** Launches first: posts and metrics point at them */
const TABLES = ['launches', 'posts', 'metrics', 'cursors', 'accounts'] as const;

/** The tables whose ids Postgres generates, so their sequences must start after the copied ids */
const IDENTITIES = ['launches', 'accounts'];

/** Every table a migration creates, to start again from nothing */
const ALL_TABLES = ['checks', 'timings', 'provider_calls', 'attention_dismissals', 'assistant_messages', 'assistant_sessions', 'comments', 'account_snapshots', 'jobs', 'api_tokens', 'metrics', 'posts', 'settings', 'cursors', 'accounts', 'launches'];

// Well under Postgres' 65535 parameters per statement, at 11 columns a row
const BATCH = 1000;

export type RowCounts = Record<string, number>;

/** Rows per table in a SQLite registry, opened read-only; a table its schema never reached counts 0 */
export function countSqlite(path: string): RowCounts {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map((name) => [name, sqliteRows(db, name).length]));
  } finally {
    db.close();
  }
}

/** Rows per table in Postgres, whichever migration its schema is at; a table not created yet counts 0 */
export async function countPostgres(db: Database): Promise<RowCounts> {
  const counts: RowCounts = {};
  for (const name of TABLES) {
    const [table] = await db.select({ found: sql<string | null>`to_regclass(${name})::text` }).from(sql`(SELECT 1) AS one`);
    if (!table?.found) {
      counts[name] = 0;
      continue;
    }
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(sql`${sql.identifier(name)}`);
    counts[name] = row?.n ?? 0;
  }
  return counts;
}

function sqliteRows(db: DatabaseSync, table: string): Array<Record<string, unknown>> {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  // rowid keeps the metrics, which have no key, in the order they were taken
  return exists ? (db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>) : [];
}

export class NotEmpty extends Error {}

/**
 * Copies every row of the SQLite registry at `path` into `db`, then brings the schema up to date,
 * which converts them. The copy is one transaction and so is the conversion: a failure in either
 * leaves no half-copied table. A database that already holds rows is refused, unless `force`
 * empties it first. Returns the rows copied, per table, as SQLite had them.
 */
export async function copyFromSqlite(path: string, db: Database, options: { force?: boolean } = {}): Promise<RowCounts> {
  const existing = await countPostgres(db);
  if (!options.force && Object.values(existing).some((n) => n > 0)) {
    throw new NotEmpty(`the Postgres database is not empty (${describe(existing)}); --force empties it first`);
  }
  // Empty, or emptied on purpose: back to the first schema, which the rows fit as they are
  await db.execute(sql.raw(`DROP TABLE IF EXISTS ${ALL_TABLES.join(', ')} CASCADE`));
  await db.execute(sql.raw('DROP SCHEMA IF EXISTS drizzle CASCADE'));
  await migrateDatabase(db, { upTo: FIRST_MIGRATION });

  const source = new DatabaseSync(path, { readOnly: true });
  let copied: RowCounts;
  try {
    copied = await db.transaction(async (tx) => {
      for (const name of TABLES) {
        const rows = sqliteRows(source, name);
        const columns = Object.keys(rows[0] ?? {});
        for (let i = 0; i < rows.length; i += BATCH) {
          const values = rows.slice(i, i + BATCH).map((row) => sql`(${sql.join(columns.map((c) => sql`${row[c]}`), sql`, `)})`);
          await tx.execute(sql`INSERT INTO ${sql.identifier(name)} (${sql.join(columns.map((c) => sql.identifier(c)), sql`, `)}) VALUES ${sql.join(values, sql`, `)}`);
        }
      }
      // The ids were copied, not generated: the next new row takes the one after the highest
      for (const name of IDENTITIES) {
        await tx.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${name}`));
      }
      return countPostgres(tx);
    });
  } finally {
    source.close();
  }
  await migrateDatabase(db);
  return copied;
}

export function describe(counts: RowCounts): string {
  return Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
}
