/**
 * Moves an install's registry from SQLite to Postgres, once:
 *
 *   docker compose up -d postgres
 *   node scripts/sqlite-to-postgres.ts [path/to/shipcast.db] [--force]
 *
 * Reads the SQLite file read-only (by default `data/shipcast.db`, or under SHIPCAST_DATA_DIR) and
 * copies every row into the Postgres at SHIPCAST_DATABASE_URL, after bringing its schema up to date,
 * keeping the ids. Stop the app and the CLI first, so nothing is written to the old file while it is
 * read. A database that already holds rows is refused; `--force` empties it first.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectPostgres } from '../packages/engine/src/db/connect.ts';
import { copyFromSqlite, countPostgres, countSqlite, describe, NotEmpty } from '../packages/engine/src/db/from-sqlite.ts';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

const args = process.argv.slice(2);
const force = args.includes('--force');
const given = args.find((a) => !a.startsWith('--'));
const path = given ? resolve(given) : resolve(root, process.env.SHIPCAST_DATA_DIR?.trim() || 'data', 'shipcast.db');
const url = process.env.SHIPCAST_DATABASE_URL?.trim();

if (!url) {
  console.error('SHIPCAST_DATABASE_URL is not set (see .env.example)');
  process.exit(2);
}
if (!existsSync(path)) {
  console.error(`no SQLite registry at ${path}`);
  process.exit(2);
}

const sqlite = countSqlite(path);
console.log(`SQLite ${path}: ${describe(sqlite)}`);
const { db, close } = await connectPostgres(url);
try {
  console.log(`Postgres before: ${describe(await countPostgres(db))}`);
  const after = await copyFromSqlite(path, db, { force });
  console.log(`Postgres after:  ${describe(after)}`);
  const short = Object.keys(sqlite).filter((table) => after[table] !== sqlite[table]);
  if (short.length > 0) {
    console.error(`the counts differ for ${short.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Every row was copied. Start the app and the CLI with SHIPCAST_DATABASE_URL set.');
  }
} catch (error) {
  console.error(error instanceof NotEmpty ? error.message : error);
  process.exitCode = 1;
} finally {
  await close();
}
