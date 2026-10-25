import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

/** A Drizzle database on either driver: postgres.js for a server, PGlite in-process */
export type Database = PgDatabase<PgQueryResultHKT>;

export interface Connection {
  db: Database;
  close(): Promise<void>;
}

// The SQL drizzle-kit generated from src/db/schema.ts, committed beside the package
export const migrationsFolder = join(import.meta.dirname, '..', '..', 'drizzle');

// Any constant; it only has to be the same for every process that migrates this database
const MIGRATION_LOCK = 7_461_726;

/**
 * Opens a Postgres server at a `postgres://` URL and brings its schema up to date. The migrator records
 * what it applied in `drizzle.__drizzle_migrations`, so a second start applies nothing.
 */
export async function connectPostgres(url: string): Promise<Connection> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  // `onnotice` off: every idempotent `CREATE … IF NOT EXISTS` of the migrator would print a notice
  const options = { onnotice: () => {} };

  // Drizzle's migrator takes no lock, and the app and the CLI may start together. A session lock
  // needs one connection for its whole life, hence a client of its own with `max: 1`
  const migrator = postgres(url, { ...options, max: 1 });
  try {
    await migrator`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    await migrate(drizzle({ client: migrator }), { migrationsFolder });
  } finally {
    await migrator.end();
  }

  const client = postgres(url, options);
  return { db: drizzle({ client }), close: () => client.end() };
}

/**
 * A real Postgres compiled to WASM, in this process: in memory without a directory, so tests need no
 * server or docker. Loaded on demand, so a process on a server never loads the WASM.
 */
export async function connectPglite(dataDir?: string): Promise<Connection & { client: PGlite }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const client = new PGlite(dataDir);
  const db = drizzle({ client });
  await migrate(db, { migrationsFolder });
  return { db, client, close: () => client.close() };
}
