import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { PgDialect, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';

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

/** The schema node:sqlite's registry had, which a copy of it lands in before the rest convert it */
export const FIRST_MIGRATION = '0000_registry';

export interface MigrateOptions {
  /** Stop after this migration (its tag, as in drizzle/meta/_journal.json): an older schema, for the SQLite copy and for tests of a conversion */
  upTo?: string;
}

/**
 * Applies the migrations not yet applied, in one transaction, as Drizzle's migrators do; the same
 * for both drivers, and able to stop at an older one, which theirs are not.
 */
export async function migrateDatabase(db: Database, options: MigrateOptions = {}): Promise<void> {
  let migrations = readMigrationFiles({ migrationsFolder });
  if (options.upTo !== undefined) {
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
    const last = journal.entries.findIndex((e) => e.tag === options.upTo);
    if (last < 0) throw new Error(`no migration ${options.upTo}`);
    migrations = migrations.slice(0, last + 1);
  }
  // The session's schema generic differs from what migrate() declares, though it never reads it
  await new PgDialect().migrate(migrations, db._.session as Parameters<PgDialect['migrate']>[1], { migrationsFolder });
}

/**
 * Opens a Postgres server at a `postgres://` URL and brings its schema up to date. The migrator records
 * what it applied in `drizzle.__drizzle_migrations`, so a second start applies nothing.
 */
/**
 * The pool of one process, so a deployment can size each process type to fit behind PgBouncer.
 * Unset, the pool is postgres.js's default (10) and the migrations run on `url`, as before.
 */
export interface PoolOptions {
  /** postgres.js's `max` connections */
  max?: number;
  /**
   * False behind PgBouncer in transaction mode, where a server connection is not the same between two
   * statements, so a named prepared statement may not be there
   */
  prepare?: boolean;
  /**
   * Where the migrator connects: a direct URL past PgBouncer, since its session advisory lock needs
   * the same server connection for its whole life, which transaction pooling does not give
   */
  migrateUrl?: string;
}

export async function connectPostgres(url: string, migrateOptions: MigrateOptions = {}, pool: PoolOptions = {}): Promise<Connection> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  // `onnotice` off: every idempotent `CREATE … IF NOT EXISTS` of the migrator would print a notice
  const options = { onnotice: () => {} };

  // Drizzle's migrator takes no lock, and the app and the CLI may start together. A session lock
  // needs one connection for its whole life, hence a client of its own with `max: 1`
  const migrator = postgres(pool.migrateUrl ?? url, { ...options, max: 1 });
  try {
    await migrator`SELECT pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      await migrateDatabase(drizzle({ client: migrator }), migrateOptions);
    } finally {
      // Released by hand, not left to the connection's end: behind a pooler that keeps server connections
      // (PgBouncer), ending the client does not end the session, and a lock left on it blocks every start
      await migrator`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`.catch(() => undefined);
    }
  } finally {
    await migrator.end();
  }

  const client = postgres(url, { ...options, ...(pool.max !== undefined && { max: pool.max }), ...(pool.prepare !== undefined && { prepare: pool.prepare }) });
  return { db: drizzle({ client }), close: () => client.end() };
}

/**
 * A real Postgres compiled to WASM, in this process: in memory without a directory, so tests need no
 * server or docker. Loaded on demand, so a process on a server never loads the WASM.
 */
export async function connectPglite(dataDir?: string, options: MigrateOptions = {}): Promise<Connection & { client: PGlite }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  // PGlite ships contrib extensions as separate modules: pg_trgm must be loaded for migration 0010
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  // The options-only form: with a first argument of `undefined`, PGlite drops the options
  const client = new PGlite({ ...(dataDir !== undefined && { dataDir }), extensions: { pg_trgm } });
  const db = drizzle({ client });
  await migrateDatabase(db, options);
  return { db, client, close: () => client.close() };
}

/** One round trip to the database, for a readiness check: throws when it cannot answer */
export async function pingDatabase(db: Database): Promise<void> {
  const { sql } = await import('drizzle-orm');
  await db.execute(sql`SELECT 1`);
}
