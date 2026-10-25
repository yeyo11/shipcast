import { sql } from 'drizzle-orm';
import { doublePrecision, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';

/*
 * The registry's tables. The first migration mirrors node:sqlite's column for column, so
 * scripts/sqlite-to-postgres.ts copies every row as it is and the later migrations convert it like any
 * other install. Timestamps stay ISO 8601 text in UTC with milliseconds: rows are ordered and compared
 * by them, and moving to timestamptz is a change of its own.
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

// One row per published piece: the post itself, an Instagram story or comment, one newsletter issue
// or one blog article per language. See docs/decisions/post-model.md
export const posts = pgTable(
  'posts',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    launchId: integer('launch_id')
      .notNull()
      .references(() => launches.id),
    channel: text('channel').notNull(),
    // Null for a piece no account published (the blog) or an old one that cannot be attributed; an
    // account removed later leaves its pieces in place
    accountId: integer('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    externalId: text('external_id'),
    url: text('url'),
    status: text('status').notNull().default('live'),
    contentHash: text('content_hash'),
    scheduledAt: text('scheduled_at'),
    publishedAt: text('published_at').notNull().default(nowIso),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  // A launch happens once, piece by piece. Nulls not distinct: two blog articles with no account
  // would otherwise both be accepted, since NULL never equals NULL
  (t) => [unique('posts_piece_unique').on(t.launchId, t.channel, t.accountId, t.kind).nullsNotDistinct()],
);

// Positions and polling state (ETags, last ids, last checks); what the owner chooses is in settings
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
    // The piece a reading is of; null for a site-level source (blog visits, search, Bing, GitHub)
    postId: integer('post_id').references(() => posts.id),
    source: text('source').notNull(),
    name: text('name').notNull(),
    // SQLite's REAL is an 8-byte float; Postgres' `real` is 4 bytes and would round the readings
    value: doublePrecision('value').notNull(),
    takenAt: text('taken_at').notNull(),
  },
  (t) => [index('metrics_by_launch').on(t.launchId, t.source, t.name, t.takenAt), index('metrics_by_post').on(t.postId)],
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

// What the owner chose (automation, and next the onboarding, AI and prompts), as JSON the registry
// reads back typed; cursors keep only positions and state
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: text('updated_at').notNull().default(nowIso),
});

// Tokens for the REST API (/api/v1), one per client the owner named. Only a keyed hash of each
// secret is kept, never the token; a revoked token keeps its row, so the list still shows what once
// had access. See docs/decisions/api-tokens.md
export const apiTokens = pgTable('api_tokens', {
  id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
  name: text('name').notNull(),
  hash: text('hash').notNull(),
  scopes: text('scopes').array().notNull(),
  createdAt: text('created_at').notNull().default(nowIso),
  lastUsedAt: text('last_used_at'),
  revokedAt: text('revoked_at'),
});

// The work the queue ran, one row per pg-boss job (keyed by its id): what the app shows of a job
// while it runs, once it has ended and after a restart. pg-boss's tables are its own, change with
// its versions and are emptied by its retention; this row keeps the title, the launch, the log
// lines and the link. See docs/decisions/job-queue.md
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    title: text('title').notNull(),
    launchId: integer('launch_id').references(() => launches.id, { onDelete: 'set null' }),
    // created, active, retry, completed or failed, as pg-boss names them
    state: text('state').notNull().default('created'),
    attempts: integer('attempts').notNull().default(0),
    // The last lines worth showing, oldest first; the registry keeps a bounded number
    log: jsonb('log').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    link: text('link'),
    createdAt: text('created_at').notNull().default(nowIso),
    startedAt: text('started_at'),
    endedAt: text('ended_at'),
  },
  (t) => [index('jobs_by_created').on(t.createdAt), index('jobs_by_launch').on(t.launchId)],
);
