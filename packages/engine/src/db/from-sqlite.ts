import { DatabaseSync } from 'node:sqlite';
import { count, getTableColumns, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from './connect.ts';
import { accounts, cursors, launches, metrics, posts } from './schema.ts';

/*
 * Moves a registry kept by the old node:sqlite engine (`data/shipcast.db`) into Postgres, row for
 * row: the tables kept their names and columns, so a row is copied as it is, ids included.
 * scripts/sqlite-to-postgres.ts is the command around it.
 */

/** Launches first: posts and metrics point at them */
const TABLES: Array<[string, PgTable]> = [
  ['launches', launches],
  ['posts', posts],
  ['metrics', metrics],
  ['cursors', cursors],
  ['accounts', accounts],
];

/** The tables whose ids Postgres generates, so their sequences must start after the copied ids */
const IDENTITIES = ['launches', 'accounts'];

// Well under Postgres' 65535 parameters per statement, at 11 columns a row
const BATCH = 1000;

export type RowCounts = Record<string, number>;

/** Rows per table in a SQLite registry, opened read-only; a table its schema never reached counts 0 */
export function countSqlite(path: string): RowCounts {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(TABLES.map(([name]) => [name, sqliteRows(db, name).length]));
  } finally {
    db.close();
  }
}

export async function countPostgres(db: Database): Promise<RowCounts> {
  const counts: RowCounts = {};
  for (const [name, table] of TABLES) {
    const [row] = await db.select({ n: count() }).from(table);
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
 * Copies every row of the SQLite registry at `path` into `db`, whose schema is already migrated, in
 * one transaction: a failure leaves Postgres as it was. A database that already holds rows is
 * refused, unless `force` empties it first.
 */
export async function copyFromSqlite(path: string, db: Database, options: { force?: boolean } = {}): Promise<RowCounts> {
  const existing = await countPostgres(db);
  if (!options.force && Object.values(existing).some((n) => n > 0)) {
    throw new NotEmpty(`the Postgres database is not empty (${describe(existing)}); --force empties it first`);
  }
  const source = new DatabaseSync(path, { readOnly: true });
  try {
    await db.transaction(async (tx) => {
      if (options.force) await tx.execute(sql.raw(`TRUNCATE ${TABLES.map(([name]) => name).join(', ')} RESTART IDENTITY`));
      for (const [name, table] of TABLES) {
        // From SQLite's column names to Drizzle's keys: `launch_id` is `launchId`
        const columns = Object.entries(getTableColumns(table));
        const rows = sqliteRows(source, name).map((row) => Object.fromEntries(columns.map(([key, column]) => [key, row[column.name]])));
        for (let i = 0; i < rows.length; i += BATCH) await tx.insert(table).values(rows.slice(i, i + BATCH));
      }
      // The ids were copied, not generated: the next new row takes the one after the highest
      for (const name of IDENTITIES) {
        await tx.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${name}', 'id'), COALESCE(MAX(id), 0) + 1, false) FROM ${name}`));
      }
    });
  } finally {
    source.close();
  }
  return countPostgres(db);
}

export function describe(counts: RowCounts): string {
  return Object.entries(counts)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');
}
