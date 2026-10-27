import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, unique } from 'drizzle-orm/pg-core';

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
  (t) => [
    // The claim: a second launch of the same repo and ref is refused by the database, not by a check
    unique('launches_repo_ref_unique').on(t.repo, t.ref),
    // The list's order, alone or after a status or a repo, read forwards or backwards (newest or oldest first)
    index('launches_by_newest').on(t.createdAt.desc(), t.id.desc()),
    index('launches_by_status').on(t.status, t.createdAt.desc(), t.id.desc()),
    index('launches_by_repo').on(t.repo, t.createdAt.desc(), t.id.desc()),
  ],
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
    // The profile picture the last working check found, on the network's own CDN; never an address
    // that carries a credential
    avatarUrl: text('avatar_url'),
  },
  (t) => [unique('accounts_network_brand_label_unique').on(t.network, t.brand, t.label)],
);

// An account's own numbers, one row per account per UTC day: no network gives their history, so it
// is recorded from the day the account is connected. A second reading on the same day replaces the
// first. See docs/decisions/account-snapshots.md
export const accountSnapshots = pgTable(
  'account_snapshots',
  {
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // YYYY-MM-DD in UTC, the key that keeps one row a day
    day: text('day').notNull(),
    takenAt: text('taken_at').notNull(),
    // Null where the network does not count it, which is not the same as zero
    followers: integer('followers'),
    following: integer('following'),
    posts: integer('posts'),
    // What only that network counts, by name
    extra: jsonb('extra').$type<Record<string, number>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [primaryKey({ name: 'account_snapshots_account_day', columns: [t.accountId, t.day] })],
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

// The comments under Shipcast's own posts, one row per comment, and the reply the assistant drafted
// for it, edited, sent or dismissed. A comment is known by its network's id, once per channel, so
// reading the same thread again never adds it twice. See docs/decisions/comment-assistant.md
export const comments = pgTable(
  'comments',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id),
    channel: text('channel').notNull(),
    externalId: text('external_id').notNull(),
    authorHandle: text('author_handle').notNull(),
    authorName: text('author_name'),
    // An https address on the network's CDN, never one that carries a credential
    authorAvatarUrl: text('author_avatar_url'),
    text: text('text').notNull(),
    url: text('url'),
    // When it was written, as the network says; fetched_at is when Shipcast first read it
    createdAt: text('created_at').notNull(),
    // The parent comment's external id, for a reply inside a thread
    inReplyTo: text('in_reply_to'),
    // Written by the account that published the post: the owner's own replies, never answered
    own: boolean('own').notNull().default(false),
    fetchedAt: text('fetched_at').notNull().default(nowIso),
    // new, draft-ready, approved (being sent), sent, dismissed or failed
    status: text('status').notNull().default('new'),
    // What the AI took it for: question, feedback, praise, bug, spam, abuse, other
    classification: text('classification'),
    draft: text('draft'),
    // The AI's one line for the owner: why this reply, or why to dismiss it
    note: text('note'),
    // Why drafting or sending failed, in words
    problem: text('problem'),
    sentExternalId: text('sent_external_id'),
    sentUrl: text('sent_url'),
    sentAt: text('sent_at'),
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (t) => [
    unique('comments_channel_external_unique').on(t.channel, t.externalId),
    index('comments_by_post').on(t.postId),
    index('comments_by_status').on(t.status, t.createdAt),
    // The page's filters: a channel's newest, and the newest of all, both in the order they are listed
    index('comments_by_channel').on(t.channel, t.createdAt.desc(), t.id.desc()),
    index('comments_by_newest').on(t.createdAt.desc(), t.id.desc()),
    // The page's search is ILIKE '%words%' on these three: only trigram indexes serve a match
    // inside the text, and Postgres ORs their bitmaps (pg_trgm is created by migration 0010)
    index('comments_text_trgm').using('gin', t.text.op('gin_trgm_ops')),
    index('comments_author_handle_trgm').using('gin', t.authorHandle.op('gin_trgm_ops')),
    index('comments_author_name_trgm').using('gin', t.authorName.op('gin_trgm_ops')),
  ],
);

// The writing assistant's conversations, kept so a session can be found and taken up again. A
// session belongs to what was being edited when it started: a launch's draft (the launch and the
// draft's file) or an article on Write (no launch). See docs/decisions/writing-assistant.md
export const assistantSessions = pgTable(
  'assistant_sessions',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    // The first question, or the draft's title when the first turn had no words worth a title
    title: text('title').notNull(),
    launchId: integer('launch_id').references(() => launches.id, { onDelete: 'set null' }),
    // The draft's file in the launches repo; null for an article on Write
    draftPath: text('draft_path'),
    // What the draft or article was called when the session started, as the list shows it
    draftLabel: text('draft_label'),
    createdAt: text('created_at').notNull().default(nowIso),
    // Moves with every message, so the list shows the sessions last talked in first
    updatedAt: text('updated_at').notNull().default(nowIso),
  },
  (t) => [index('assistant_sessions_by_updated').on(t.updatedAt, t.id)],
);

export const assistantMessages = pgTable(
  'assistant_messages',
  {
    id: integer('id').primaryKey().generatedByDefaultAsIdentity(),
    sessionId: integer('session_id')
      .notNull()
      .references(() => assistantSessions.id, { onDelete: 'cascade' }),
    // user or assistant
    role: text('role').notNull(),
    // The assistant's final text, proposals included as the model wrote them
    content: text('content').notNull(),
    // Each proposal in the answer, in order, and whether the owner accepted or rejected it
    proposals: jsonb('proposals').$type<Array<{ text: string; state: 'open' | 'accepted' | 'rejected' }>>().notNull().default(sql`'[]'::jsonb`),
    // The passage selected when the question was asked, which its proposals replace; null for the whole text
    selection: jsonb('selection').$type<{ start: number; end: number; original: string } | null>(),
    // Why the answer stopped short, in words
    problem: text('problem'),
    createdAt: text('created_at').notNull().default(nowIso),
  },
  (t) => [index('assistant_messages_by_session').on(t.sessionId, t.id)],
);

// The bell's lines the owner dismissed, by the item's key. A key carries the state it was made for
// (`launch:12:waiting:<updated at>`), so a dismissal hides the line while its condition lasts and a
// new condition is a new line; dismissals of lines that are gone are forgotten. See docs/web-app.md
export const attentionDismissals = pgTable('attention_dismissals', {
  key: text('key').primaryKey(),
  dismissedAt: text('dismissed_at').notNull().default(nowIso),
});
