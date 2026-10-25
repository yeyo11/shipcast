import { sql } from 'drizzle-orm';
import { doublePrecision, index, integer, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';

/*
 * The registry's tables, column for column as they were on node:sqlite, so scripts/sqlite-to-postgres.ts
 * copies every row as it is. Timestamps stay ISO 8601 text in UTC with milliseconds: rows are ordered
 * and compared by them, and moving to timestamptz is a change of its own.
 */

/** What SQLite's `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` wrote, fixed for the statement as SQLite's 'now' was, so old and new rows sort together */
export const nowIso = sql`to_char(statement_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const launches = pgTable(
  'launches',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    repo: text('repo').notNull(),
    ref: text('ref').notNull(),
    trigger: text('trigger').notNull(),
    kind: text('kind').notNull(),
    brand: text('brand').notNull(),
    status: text('status').notNull(),
    detail: text('detail'),
    createdAt: text('created_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  // The claim: a second launch of the same repo and ref is refused by the database, not by a check
  (t) => [unique('launches_repo_ref_unique').on(t.repo, t.ref)],
);

export const posts = pgTable(
  'posts',
  {
    launchId: integer('launch_id')
      .notNull()
      .references(() => launches.id),
    channel: text('channel').notNull(),
    url: text('url'),
    externalId: text('external_id'),
    publishedAt: text('published_at').notNull().default(nowIso),
  },
  // One post per launch and channel: publishing the same piece twice is refused
  (t) => [primaryKey({ columns: [t.launchId, t.channel] })],
);

export const cursors = pgTable('cursors', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Every reading is kept, so the dashboard shows how a launch grew, not only where it stands
export const metrics = pgTable(
  'metrics',
  {
    launchId: integer('launch_id')
      .notNull()
      .references(() => launches.id),
    source: text('source').notNull(),
    name: text('name').notNull(),
    // SQLite's REAL is an 8-byte float; Postgres' `real` is 4 bytes and would round the readings
    value: doublePrecision('value').notNull(),
    takenAt: text('taken_at').notNull(),
  },
  (t) => [index('metrics_by_launch').on(t.launchId, t.source, t.name, t.takenAt)],
);

// Accounts connected from the app: public settings here, secrets in the keychain under `account:<id>`
export const accounts = pgTable(
  'accounts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    network: text('network').notNull(),
    brand: text('brand').notNull(),
    label: text('label').notNull(),
    // JSON as text, as it was: the registry parses it, and nothing queries inside it
    settings: text('settings').notNull().default('{}'),
    // 0 or 1, as SQLite stored it, so the rows copy as they are
    isPrimary: integer('is_primary').notNull().default(0),
    status: text('status').notNull().default('unchecked'),
    identity: text('identity'),
    problem: text('problem'),
    checkedAt: text('checked_at'),
    createdAt: text('created_at').notNull().default(nowIso),
  },
  (t) => [unique('accounts_network_brand_label_unique').on(t.network, t.brand, t.label)],
);
