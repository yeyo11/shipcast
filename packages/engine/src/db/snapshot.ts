import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { repositoriesOn, type Repositories } from '../repositories/index.ts';
import { connectPglite, migrateDatabase, migrationsFolder, type Database } from './connect.ts';

/*
 * The registry as one JSON document, for Action mode (docs/decisions/action-mode.md): a run with no
 * server loads it into an in-process PGlite, works on the real schema, and saves it back to the
 * launches repo's `shipcast-state` branch. JSON rather than PGlite's data directory, so the file is
 * small, each run's change is a readable diff, and it does not depend on PGlite's on-disk format.
 */

export const SNAPSHOT_FORMAT = 1;

export interface RegistrySnapshot {
  format: typeof SNAPSHOT_FORMAT;
  /** The last migration of the schema the rows fit, a tag of drizzle/meta/_journal.json */
  migration: string;
  /** Each table's rows, parents before the tables that point at them */
  tables: Record<string, Array<Record<string, unknown>>>;
}

/**
 * Tables Action mode leaves out: API tokens (hashes of credentials for an app that does not run in
 * CI) and the job rows (the queue does not run in CI either). Discovered tables are taken otherwise,
 * so a table a later migration adds is kept without touching this file.
 */
export const UNSNAPSHOTTED_TABLES: readonly string[] = ['api_tokens', 'jobs'];

/** Cursors that hold a secret: an Instagram token refreshed while it came from `.env`. A snapshot may be public */
export const SECRET_CURSORS: readonly string[] = ['instagram-token'];

export class SnapshotError extends Error {}

function journal(): string[] {
  const parsed = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ tag: string }> };
  return parsed.entries.map((e) => e.tag);
}

/** The migration this code brings a database to */
export function latestMigration(): string {
  const tags = journal();
  const last = tags[tags.length - 1];
  if (!last) throw new SnapshotError('no migrations found');
  return last;
}

async function rows<T>(db: Database, query: ReturnType<typeof sql>): Promise<T[]> {
  const result: unknown = await db.execute(query);
  return Array.isArray(result) ? (result as T[]) : (result as { rows: T[] }).rows;
}

/** The public schema's tables, ordered so every table comes after the ones its foreign keys point at */
async function orderedTables(db: Database): Promise<string[]> {
  const tables = (await rows<{ name: string }>(db, sql`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).map((r) => r.name);
  const edges = await rows<{ child: string; parent: string }>(
    db,
    sql`SELECT c.relname AS child, p.relname AS parent
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE k.contype = 'f' AND n.nspname = 'public'`,
  );
  const ordered: string[] = [];
  const visiting = new Set<string>();
  const visit = (table: string) => {
    if (ordered.includes(table) || visiting.has(table)) return;
    visiting.add(table);
    for (const edge of edges) if (edge.child === table && edge.parent !== table) visit(edge.parent);
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
}

/** The primary key's columns, so rows are written in a stable order and a snapshot diffs cleanly */
async function primaryKey(db: Database, table: string): Promise<string[]> {
  return (
    await rows<{ name: string }>(
      db,
      sql`SELECT a.attname AS name FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
          WHERE i.indrelid = ${table}::regclass AND i.indisprimary ORDER BY a.attnum`,
    )
  ).map((r) => r.name);
}

/** Every row of the registry, as JSON values, in the schema of the latest migration */
export async function dumpRegistry(db: Database): Promise<RegistrySnapshot> {
  const tables: RegistrySnapshot['tables'] = {};
  for (const table of await orderedTables(db)) {
    if (UNSNAPSHOTTED_TABLES.includes(table)) continue;
    const key = await primaryKey(db, table);
    const order = key.length > 0 ? sql.join(key.map((c) => sql.identifier(c)), sql`, `) : sql`row_to_json(t)::text`;
    const found = await rows<{ row: string }>(db, sql`SELECT row_to_json(t)::text AS row FROM ${sql.identifier(table)} t ORDER BY ${order}`);
    let values = found.map((r) => JSON.parse(r.row) as Record<string, unknown>);
    if (table === 'cursors') values = values.filter((r) => !SECRET_CURSORS.includes(String(r.key)));
    tables[table] = values;
  }
  return { format: SNAPSHOT_FORMAT, migration: latestMigration(), tables };
}

/**
 * Loads a snapshot into a database that has no registry yet: the schema is migrated up to the
 * snapshot's migration, the rows inserted as they were (ids too), the id sequences moved past them,
 * and the newer migrations applied, which convert the rows as they convert any install.
 */
export async function loadRegistry(db: Database, snapshot: RegistrySnapshot): Promise<void> {
  if (snapshot.format !== SNAPSHOT_FORMAT) throw new SnapshotError(`the state is in snapshot format ${String(snapshot.format)}; this Shipcast reads ${SNAPSHOT_FORMAT}`);
  if (!journal().includes(snapshot.migration)) {
    throw new SnapshotError(`the state was saved by a newer Shipcast (schema ${snapshot.migration}): update the action before running it again`);
  }
  await migrateDatabase(db, { upTo: snapshot.migration });
  await db.transaction(async (tx) => {
    const order = await orderedTables(tx);
    const known = new Set(order);
    for (const name of Object.keys(snapshot.tables)) {
      if (!known.has(name)) throw new SnapshotError(`the state has a table "${name}" the schema ${snapshot.migration} does not`);
    }
    for (const table of order) {
      const values = snapshot.tables[table];
      if (!values || values.length === 0) continue;
      // json_populate_recordset types every column as the table declares it: jsonb, numbers, text
      await tx.execute(sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM json_populate_recordset(NULL::${sql.identifier(table)}, ${JSON.stringify(values)}::json)`);
      // Asked only of a table with an id column: an error would abort the whole transaction
      const [sequence] = await rows<{ seq: string | null }>(
        tx,
        sql`SELECT pg_get_serial_sequence(${table}, 'id') AS seq FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'id'`,
      );
      if (sequence?.seq) {
        await tx.execute(sql`SELECT setval(${sequence.seq}, COALESCE((SELECT MAX(id) FROM ${sql.identifier(table)}), 0) + 1, false)`);
      }
    }
  });
  await migrateDatabase(db);
}

/** A snapshot as the state branch keeps it: one row per line, so a run's change is a readable diff */
export function formatSnapshot(snapshot: RegistrySnapshot): string {
  const tables = Object.entries(snapshot.tables).map(([name, values]) => {
    const body = values.length === 0 ? '[]' : `[\n${values.map((v) => `      ${JSON.stringify(v)}`).join(',\n')}\n    ]`;
    return `    ${JSON.stringify(name)}: ${body}`;
  });
  return `{\n  "format": ${snapshot.format},\n  "migration": ${JSON.stringify(snapshot.migration)},\n  "tables": {\n${tables.join(',\n')}\n  }\n}\n`;
}

export function parseSnapshot(text: string): RegistrySnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new SnapshotError('the state file is not JSON');
  }
  const v = value as Partial<RegistrySnapshot> | null;
  if (!v || typeof v !== 'object' || typeof v.migration !== 'string' || typeof v.tables !== 'object' || v.tables === null) {
    throw new SnapshotError('the state file is not a registry snapshot');
  }
  return v as RegistrySnapshot;
}

export interface SnapshotRegistry {
  registry: Repositories;
  /** The registry's rows now, to save */
  dump(): Promise<RegistrySnapshot>;
  close(): Promise<void>;
}

/** A registry in an in-process PGlite, loaded from a snapshot, or empty and migrated without one */
export async function openSnapshot(snapshot: RegistrySnapshot | undefined): Promise<SnapshotRegistry> {
  // An empty PGlite: loading migrates it, so it is opened before any migration
  const { db, close } = await connectPglite(undefined, { upTo: snapshot ? firstMigration() : undefined });
  if (snapshot) {
    try {
      await loadRegistry(db, snapshot);
    } catch (error) {
      await close();
      throw error;
    }
  }
  return { registry: repositoriesOn(db), dump: () => dumpRegistry(db), close };
}

function firstMigration(): string {
  const first = journal()[0];
  if (!first) throw new SnapshotError('no migrations found');
  return first;
}
