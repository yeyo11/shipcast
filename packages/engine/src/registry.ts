import { and, asc, count, desc, eq, gte, ilike, inArray, like, lt, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Channel, Language, PackKind } from '@shipcast/schema';
import { connectPglite, connectPostgres, type Database } from './db/connect.ts';
import { accounts, accountSnapshots, apiTokens, assistantMessages, assistantSessions, attentionDismissals, comments, cursors, jobs, launches, metrics, nowIso, posts, settings } from './db/schema.ts';

/** A job's state, as pg-boss names them; `retry` waits for its next attempt */
export type JobState = 'created' | 'active' | 'retry' | 'completed' | 'failed';

export const UNFINISHED_JOB_STATES: readonly JobState[] = ['created', 'active', 'retry'];

/** How many log lines a job keeps: enough to tell what happened, never a growing table */
export const JOB_LOG_LINES = 40;

/** What the app shows of one job of the queue, kept after it ends and across restarts */
export interface JobRecord {
  /** pg-boss's id of the job */
  id: string;
  queue: string;
  /** What it is, in words: "Drafting yeyo11/claudio v0.9.0" */
  title: string;
  launchId: number | null;
  state: JobState;
  /** Attempts started so far; a job waiting for a deploy takes several */
  attempts: number;
  log: string[];
  /** Where to go once it is done: a pull request, a launch */
  link: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface JobChange {
  title?: string;
  state?: JobState;
  attempts?: number;
  link?: string | null;
  /** Sets the start to now, unless it was set by an earlier attempt */
  started?: boolean;
  /** Sets the end to now, or clears it when a job goes back to waiting */
  ended?: boolean;
}

/** Where a page of the work list starts: the last job of the previous one */
export interface JobCursor {
  createdAt: string;
  id: string;
}

/** Which jobs: a page's bounds aside */
export interface JobConditions {
  launchId?: number;
  /** Created at or after this moment */
  since?: string;
  states?: readonly JobState[];
  queues?: readonly string[];
  /**
   * Only what the work list shows: rounds run all day and Automation has the last one, so a round
   * is listed only while running or when it failed, and a job that found automation off not at all.
   * Kept in SQL so a page and its counts are cut by the database, never after the query.
   */
  listed?: boolean;
}

export interface JobFilter extends JobConditions {
  limit?: number;
  /** For numbered pages: how many of the newest to skip */
  offset?: number;
  /** For a cursor: only the jobs older than this one */
  before?: JobCursor;
}

function jobConditions(filter: JobConditions): SQL[] {
  const where: SQL[] = [];
  if (filter.launchId !== undefined) where.push(eq(jobs.launchId, filter.launchId));
  if (filter.since !== undefined) where.push(gte(jobs.createdAt, filter.since));
  if (filter.states) where.push(inArray(jobs.state, [...filter.states]));
  if (filter.queues) where.push(inArray(jobs.queue, [...filter.queues]));
  if (filter.listed) {
    where.push(sql`(${jobs.queue} <> 'round' OR ${jobs.state} IN ('active', 'failed'))`);
    where.push(sql`NOT (${jobs.state} = 'completed' AND coalesce(${jobs.log} ->> 0, '') LIKE 'Automation is off%')`);
  }
  return where;
}

function toJob(row: typeof jobs.$inferSelect): JobRecord {
  return { ...row, state: row.state as JobState, log: Array.isArray(row.log) ? row.log : [] };
}

/** What started a launch; the launch.yml `triggers` decide which of these are honoured. An `article` is written in the app, not released. */
export type Trigger = 'release' | 'manual' | 'public' | 'enabled' | 'article';

/**
 * The life of a launch. `skipped` and `failed` keep their row, so a release that was deliberately
 * not launched is never picked up again by the next poll.
 */
export type LaunchStatus = 'detected' | 'generating' | 'drafted' | 'published' | 'skipped' | 'failed';

export interface Launch {
  id: number;
  /** `owner/name` */
  repo: string;
  /** The release tag, or for a launch without one a key of its own (see claim) */
  ref: string;
  trigger: Trigger;
  kind: PackKind;
  brand: string;
  status: LaunchStatus;
  /** Why it was skipped or failed, or where its drafts are */
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a piece is: the channel's post itself, Instagram's story or first comment after it, one
 * newsletter issue or one blog article per language, or one Reddit post per subreddit (`post:<subreddit>`).
 */
export type PostKind = 'post' | 'story' | 'comment' | `issue:${Language}` | `article:${Language}` | `post:${string}`;

/**
 * `scheduled` is a piece waiting for its time (no external id yet, see docs/scheduling.md); `live`
 * once out, `edited` or `deleted` after it; `failed` is kept for what comes next.
 */
export type PostStatus = 'scheduled' | 'live' | 'edited' | 'deleted' | 'failed';

/** One published piece. A launch has one of each kind per channel and account, never two. */
export interface Post {
  id: number;
  launchId: number;
  channel: Channel;
  /** The account it went out with; null for the blog, or an old piece that cannot be attributed */
  accountId: number | null;
  kind: PostKind;
  externalId: string | null;
  url: string | null;
  status: PostStatus;
  contentHash: string | null;
  scheduledAt: string | null;
  publishedAt: string;
  updatedAt: string;
}

export interface NewPost {
  launchId: number;
  channel: Channel;
  /** `post` unless said */
  kind?: PostKind;
  accountId?: number | null;
  externalId: string | null;
  url: string | null;
  status?: PostStatus;
  contentHash?: string | null;
}

/** The language of an `article:<lang>` or `issue:<lang>` piece */
export function kindLanguage(kind: PostKind): Language | undefined {
  const lang = /^(?:article|issue):(en|es)$/.exec(kind)?.[1];
  return lang === 'en' || lang === 'es' ? lang : undefined;
}

export interface NewLaunch {
  repo: string;
  ref: string;
  trigger: Trigger;
  kind: PackKind;
  brand: string;
}

export type AccountStatus = 'unchecked' | 'ok' | 'failed';

/**
 * An account on a network, connected for one brand. Several may exist per network and brand; the
 * primary one is what launches publish with, since a launch posts once per channel.
 */
export interface Account {
  id: number;
  /** A network of the catalog: `devto`, `mastodon`, `brevo`, `github`… */
  network: string;
  brand: string;
  label: string;
  /** Public settings (handle, instance, user id); never a secret */
  settings: Record<string, string>;
  primary: boolean;
  status: AccountStatus;
  /** Who the network says the credential belongs to, from the last check */
  identity: string | null;
  problem: string | null;
  checkedAt: string | null;
  createdAt: string;
  /** The profile picture the last working check found; an https address on the network's CDN */
  avatarUrl: string | null;
}

/** What a snapshot counts; each is left out where the network does not give it */
export interface SnapshotStats {
  followers?: number;
  following?: number;
  posts?: number;
  extra?: Record<string, number>;
}

/** An account's numbers on one UTC day: the latest reading of that day */
export interface AccountSnapshot {
  accountId: number;
  /** YYYY-MM-DD, UTC */
  day: string;
  takenAt: string;
  followers: number | null;
  following: number | null;
  posts: number | null;
  extra: Record<string, number>;
}

/**
 * One number read from one source for one launch, at one moment. A launch's readings add up its
 * pieces': two newsletter issues read in one round are one reading of the newsletter.
 */
export interface MetricReading {
  launchId: number;
  /** A channel (`devto`, `bluesky`…), or a site-level source (`blog`, `search`, `github`) */
  source: string;
  name: string;
  value: number;
  takenAt: string;
}

/** `read` sees launches, posts, numbers, accounts and jobs; `write` starts and approves work. See docs/decisions/api-tokens.md */
export type ApiScope = 'read' | 'write';
export const API_SCOPES: readonly ApiScope[] = ['read', 'write'];

/** A REST API token as the app lists it: never its hash */
export interface ApiToken {
  id: number;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function toApiToken(row: typeof apiTokens.$inferSelect): ApiToken {
  return {
    id: row.id,
    name: row.name,
    scopes: row.scopes.filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

function toAccount(row: typeof accounts.$inferSelect): Account {
  return {
    id: row.id,
    network: row.network,
    brand: row.brand,
    label: row.label,
    settings: JSON.parse(row.settings) as Record<string, string>,
    primary: row.isPrimary === 1,
    status: row.status as AccountStatus,
    identity: row.identity,
    problem: row.problem,
    checkedAt: row.checkedAt,
    createdAt: row.createdAt,
    avatarUrl: row.avatarUrl,
  };
}

function toSnapshot(row: typeof accountSnapshots.$inferSelect): AccountSnapshot {
  return {
    accountId: row.accountId,
    day: row.day,
    takenAt: row.takenAt,
    followers: row.followers,
    following: row.following,
    posts: row.posts,
    extra: row.extra,
  };
}

function toLaunch(row: typeof launches.$inferSelect): Launch {
  return {
    id: row.id,
    repo: row.repo,
    ref: row.ref,
    trigger: row.trigger as Trigger,
    kind: row.kind as PackKind,
    brand: row.brand,
    status: row.status as LaunchStatus,
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPost(row: typeof posts.$inferSelect): Post {
  return {
    id: row.id,
    launchId: row.launchId,
    channel: row.channel as Channel,
    accountId: row.accountId,
    kind: row.kind as PostKind,
    externalId: row.externalId,
    url: row.url,
    status: row.status as PostStatus,
    contentHash: row.contentHash,
    scheduledAt: row.scheduledAt,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Where a comment stands. `approved` is the moment between the owner's click (or auto mode) and the
 * network's answer: a comment in it is being sent, and is never sent a second time.
 */
export type CommentStatus = 'new' | 'draft-ready' | 'approved' | 'sent' | 'dismissed' | 'failed';
export const COMMENT_STATUSES: readonly CommentStatus[] = ['new', 'draft-ready', 'approved', 'sent', 'dismissed', 'failed'];

/** What the AI took a comment for; spam and abuse get no reply */
export type CommentClass = 'question' | 'feedback' | 'praise' | 'bug' | 'spam' | 'abuse' | 'other';

/** A comment under one of Shipcast's posts, and the reply drafted for it */
export interface CommentRecord {
  id: number;
  postId: number;
  /** The launch of the post it is under */
  launchId: number;
  channel: Channel;
  externalId: string;
  author: { handle: string; displayName: string | null; avatarUrl: string | null };
  text: string;
  url: string | null;
  createdAt: string;
  inReplyTo: string | null;
  own: boolean;
  fetchedAt: string;
  status: CommentStatus;
  classification: CommentClass | null;
  draft: string | null;
  note: string | null;
  problem: string | null;
  sentExternalId: string | null;
  sentUrl: string | null;
  sentAt: string | null;
  updatedAt: string;
}

export interface NewComment {
  postId: number;
  channel: Channel;
  externalId: string;
  author: { handle: string; displayName?: string; avatarUrl?: string };
  text: string;
  url?: string;
  createdAt: string;
  inReplyTo?: string;
  own: boolean;
  status?: CommentStatus;
}

export interface CommentChange {
  status?: CommentStatus;
  classification?: CommentClass | null;
  draft?: string | null;
  note?: string | null;
  problem?: string | null;
  sentExternalId?: string | null;
  sentUrl?: string | null;
  sentAt?: string | null;
}

export interface CommentFilter {
  status?: CommentStatus;
  channel?: Channel;
  launchId?: number;
  postId?: number;
  own?: boolean;
  limit?: number;
}

/**
 * Where a comment stands for the owner, in three words: waiting for a reply (new, drafted, being
 * sent or failed to send), replied, or ignored (dismissed)
 */
export type CommentBucket = 'waiting' | 'replied' | 'ignored';

export const COMMENT_BUCKETS: Record<CommentBucket, readonly CommentStatus[]> = {
  waiting: ['new', 'draft-ready', 'approved', 'failed'],
  replied: ['sent'],
  ignored: ['dismissed'],
};

/** One page of the comments list, filtered; `page` counts from 1 */
export interface CommentPageFilter {
  bucket?: CommentBucket;
  channel?: Channel;
  launchId?: number;
  postId?: number;
  /** Words to find in the comment's text or its author's handle or name, case-insensitive */
  search?: string;
  own?: boolean;
  page?: number;
  pageSize?: number;
}

export interface CommentPage {
  comments: CommentRecord[];
  /** Every comment the filters match, not only this page's */
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/** What the filters can offer: only the channels and launches that have comments, with how many */
export interface CommentFacets {
  channels: Array<{ channel: Channel; count: number }>;
  launches: Array<{ id: number; repo: string; ref: string; count: number }>;
  buckets: Record<CommentBucket, number>;
}

/** `%`, `_` and `\` in what the owner typed are letters, not LIKE's wildcards */
const likePattern = (words: string) => `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function toComment(row: typeof comments.$inferSelect, launchId: number): CommentRecord {
  return {
    id: row.id,
    postId: row.postId,
    launchId,
    channel: row.channel as Channel,
    externalId: row.externalId,
    author: { handle: row.authorHandle, displayName: row.authorName, avatarUrl: row.authorAvatarUrl },
    text: row.text,
    url: row.url,
    createdAt: row.createdAt,
    inReplyTo: row.inReplyTo,
    own: row.own,
    fetchedAt: row.fetchedAt,
    status: row.status as CommentStatus,
    classification: row.classification as CommentClass | null,
    draft: row.draft,
    note: row.note,
    problem: row.problem,
    sentExternalId: row.sentExternalId,
    sentUrl: row.sentUrl,
    sentAt: row.sentAt,
    updatedAt: row.updatedAt,
  };
}

// A round reads every piece at the same moment, so a launch's reading at a moment is its pieces' sum
const summed = {
  launchId: metrics.launchId,
  source: metrics.source,
  name: metrics.name,
  value: sql<number>`sum(${metrics.value})::float8`.mapWith(Number).as('value'),
  takenAt: metrics.takenAt,
};

/**
 * The launch registry: the record that makes "a launch happens once" hold. A release is claimed
 * before anything is generated, and the claim is a unique row, so a second poll, a re-run or a
 * crash halfway through never starts the same campaign twice.
 *
 * It lives in Postgres, which the app, the CLI and the scheduler write to at once: what SQLite's
 * single writer made atomic for free is a transaction here.
 */
/** One proposal in an assistant's answer, and what the owner did with it */
export interface AssistantProposal {
  text: string;
  state: 'open' | 'accepted' | 'rejected';
}

/** The passage selected when a question was asked, which its proposals replace */
export interface AssistantSelection {
  start: number;
  end: number;
  original: string;
}

/** A writing-assistant conversation, tied to the draft or article it was held on */
export interface AssistantSession {
  id: number;
  title: string;
  /** Null for an article on Write */
  launchId: number | null;
  draftPath: string | null;
  draftLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAssistantSession {
  title: string;
  launchId?: number | null;
  draftPath?: string | null;
  draftLabel?: string | null;
}

export interface AssistantMessage {
  id: number;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  proposals: AssistantProposal[];
  selection: AssistantSelection | null;
  problem: string | null;
  createdAt: string;
}

export interface NewAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  proposals?: AssistantProposal[];
  selection?: AssistantSelection | null;
  problem?: string | null;
}

/** A page of sessions, the most recently talked in first; `next` is the cursor for the page after it */
export interface AssistantSessionPage {
  sessions: AssistantSession[];
  next: string | null;
}

/** The sessions' cursor is the last row's `updatedAt` and id: a keyset, so new messages never shift a page */
function encodeSessionCursor(row: { updatedAt: string; id: number }): string {
  return `${row.updatedAt}|${row.id}`;
}

function decodeSessionCursor(cursor: string): { updatedAt: string; id: number } | undefined {
  const at = cursor.lastIndexOf('|');
  if (at < 1) return undefined;
  const id = Number(cursor.slice(at + 1));
  return Number.isInteger(id) ? { updatedAt: cursor.slice(0, at), id } : undefined;
}

function toAssistantMessage(row: typeof assistantMessages.$inferSelect): AssistantMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    proposals: row.proposals,
    selection: row.selection,
    problem: row.problem,
    createdAt: row.createdAt,
  };
}

export class Registry {
  readonly #db: Database;
  readonly #close: () => Promise<void>;

  /** Over a database whose schema is already migrated; `connect` and `memory` are the way in */
  constructor(db: Database, close: () => Promise<void> = async () => {}) {
    this.#db = db;
    this.#close = close;
  }

  /** The registry on a Postgres server (`SHIPCAST_DATABASE_URL`), its migrations applied */
  static async connect(url: string): Promise<Registry> {
    const { db, close } = await connectPostgres(url);
    return new Registry(db, close);
  }

  /**
   * The registry on PGlite, a real Postgres in this process: in memory and fresh on every call, or
   * kept in `dataDir`. What the tests run on, with no server to start.
   */
  static async memory(dataDir?: string): Promise<Registry> {
    const { db, close } = await connectPglite(dataDir);
    return new Registry(db, close);
  }

  /** Runs `work` in one transaction, on a registry over it; a nested call becomes a savepoint */
  #transaction<T>(work: (registry: Registry) => Promise<T>): Promise<T> {
    return this.#db.transaction((tx) => work(new Registry(tx)));
  }

  /**
   * Serialises the writers of one network and brand's accounts until the transaction ends: under
   * read committed, two transactions could each see no primary and both insert one.
   */
  async #lockAccounts(brand: string, network: string): Promise<void> {
    await this.#db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`accounts:${network}:${brand}`}))`);
  }

  /**
   * Records a launch unless one exists for the same repo and ref. `claimed: false` returns the
   * existing launch, whatever its status: the caller does nothing with a release it did not claim.
   * `ON CONFLICT` waits for a concurrent claim of the same release to commit, so only one wins.
   */
  async claim(launch: NewLaunch): Promise<{ claimed: boolean; launch: Launch }> {
    const [inserted] = await this.#db
      .insert(launches)
      .values({ repo: launch.repo, ref: launch.ref, trigger: launch.trigger, kind: launch.kind, brand: launch.brand, status: 'detected' })
      .onConflictDoNothing({ target: [launches.repo, launches.ref] })
      .returning();
    if (inserted) return { claimed: true, launch: toLaunch(inserted) };
    return { claimed: false, launch: (await this.find(launch.repo, launch.ref))! };
  }

  async find(repo: string, ref: string): Promise<Launch | undefined> {
    const [row] = await this.#db
      .select()
      .from(launches)
      .where(and(eq(launches.repo, repo), eq(launches.ref, ref)));
    return row ? toLaunch(row) : undefined;
  }

  async get(id: number): Promise<Launch | undefined> {
    const [row] = await this.#db.select().from(launches).where(eq(launches.id, id));
    return row ? toLaunch(row) : undefined;
  }

  /** The newest launches first, for `shipcast status`. */
  async recent(limit = 20): Promise<Launch[]> {
    const rows = await this.#db.select().from(launches).orderBy(desc(launches.createdAt), desc(launches.id)).limit(limit);
    return rows.map(toLaunch);
  }

  async setStatus(id: number, status: LaunchStatus, detail: string | null = null): Promise<Launch> {
    const [row] = await this.#db.update(launches).set({ status, detail, updatedAt: nowIso }).where(eq(launches.id, id)).returning();
    if (!row) throw new Error(`no launch with id ${id}`);
    return toLaunch(row);
  }

  /**
   * The ref of the repo's last launch that reached its audience, to infer the next pack: a project
   * that never launched gets the `launch` pack, whatever its version number says.
   */
  async lastPublishedRef(repo: string): Promise<string | undefined> {
    const [row] = await this.#db
      .select({ ref: launches.ref })
      .from(launches)
      .where(and(eq(launches.repo, repo), eq(launches.status, 'published')))
      .orderBy(desc(launches.createdAt), desc(launches.id))
      .limit(1);
    return row?.ref;
  }

  /**
   * One row per piece, and one piece of each kind per launch, channel and account: publishing the
   * same piece twice is refused, not repeated, and the row already there is returned.
   */
  async recordPost(post: NewPost): Promise<{ recorded: boolean; post: Post }> {
    const status = post.status ?? 'live';
    if (status !== 'scheduled') {
      // A piece that was waiting for its time becomes the published one: the same row, whatever
      // account it was scheduled with, so the slot it went out in stays on it and no second row appears
      const [promoted] = await this.#db
        .update(posts)
        .set({
          accountId: post.accountId ?? null,
          externalId: post.externalId,
          url: post.url,
          status,
          contentHash: post.contentHash ?? null,
          publishedAt: nowIso,
          updatedAt: nowIso,
        })
        .where(and(eq(posts.launchId, post.launchId), eq(posts.channel, post.channel), eq(posts.kind, post.kind ?? 'post'), eq(posts.status, 'scheduled')))
        .returning();
      if (promoted) return { recorded: true, post: toPost(promoted) };
    }
    const values = {
      launchId: post.launchId,
      channel: post.channel,
      accountId: post.accountId ?? null,
      kind: post.kind ?? 'post',
      externalId: post.externalId,
      url: post.url,
      status,
      contentHash: post.contentHash ?? null,
    };
    const [inserted] = await this.#db
      .insert(posts)
      .values(values)
      .onConflictDoNothing({ target: [posts.launchId, posts.channel, posts.accountId, posts.kind] })
      .returning();
    if (inserted) return { recorded: true, post: toPost(inserted) };
    const [existing] = await this.#db
      .select()
      .from(posts)
      .where(
        and(
          eq(posts.launchId, values.launchId),
          eq(posts.channel, values.channel),
          eq(posts.kind, values.kind),
          // What the constraint's NULLS NOT DISTINCT means, said in a query
          sql`${posts.accountId} IS NOT DISTINCT FROM ${values.accountId}`,
        ),
      );
    return { recorded: false, post: toPost(existing!) };
  }

  /** A launch's pieces, oldest first; only one channel's, or one kind's, when asked */
  async posts(launchId: number, filter: { channel?: Channel; kind?: PostKind } = {}): Promise<Post[]> {
    const where: SQL[] = [eq(posts.launchId, launchId)];
    if (filter.channel !== undefined) where.push(eq(posts.channel, filter.channel));
    if (filter.kind !== undefined) where.push(eq(posts.kind, filter.kind));
    const rows = await this.#db
      .select()
      .from(posts)
      .where(and(...where))
      .orderBy(asc(posts.publishedAt), asc(posts.channel), asc(posts.kind), asc(posts.id));
    return rows.map(toPost);
  }

  async post(id: number): Promise<Post | undefined> {
    const [row] = await this.#db.select().from(posts).where(eq(posts.id, id));
    return row ? toPost(row) : undefined;
  }

  /**
   * Records what happened to a piece after it went out: edited, with the hash of what was sent, or
   * deleted. The row stays either way, so the piece still counts as published and is never sent again.
   */
  async updatePost(id: number, change: { status: PostStatus; contentHash?: string | null }): Promise<Post> {
    const [row] = await this.#db
      .update(posts)
      .set({ status: change.status, ...(change.contentHash !== undefined && { contentHash: change.contentHash }), updatedAt: nowIso })
      .where(eq(posts.id, id))
      .returning();
    if (!row) throw new Error(`no post ${id}`);
    return toPost(row);
  }

  /**
   * Puts a channel's piece of a launch on a time: a `post` row with no external id, `scheduled`,
   * which the publish step leaves alone until then and turns into the published row when it goes
   * out. Scheduling it again moves it. Refused (undefined) once anything of that channel is out: a
   * launch happens once, and a time for a piece already published means nothing.
   */
  async schedulePost(launchId: number, channel: Channel, at: Date): Promise<Post | undefined> {
    return this.#transaction(async (tx) => {
      // Serialises two schedules of the same piece, and a schedule racing its own publication
      await tx.#db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`schedule:${launchId}:${channel}`}))`);
      const pieces = await tx.posts(launchId, { channel });
      if (pieces.some((p) => p.status !== 'scheduled')) return undefined;
      const existing = pieces.find((p) => p.kind === 'post');
      if (existing) {
        const [moved] = await tx.#db
          .update(posts)
          .set({ scheduledAt: at.toISOString(), updatedAt: nowIso })
          .where(and(eq(posts.id, existing.id), eq(posts.status, 'scheduled')))
          .returning();
        return moved ? toPost(moved) : undefined;
      }
      const [row] = await tx.#db
        .insert(posts)
        .values({ launchId, channel, kind: 'post', accountId: null, externalId: null, url: null, status: 'scheduled', scheduledAt: at.toISOString() })
        .returning();
      return row ? toPost(row) : undefined;
    });
  }

  /** Moves a piece still waiting for its time; undefined when it is not (any more) scheduled */
  async reschedulePost(id: number, at: Date): Promise<Post | undefined> {
    const [row] = await this.#db
      .update(posts)
      .set({ scheduledAt: at.toISOString(), updatedAt: nowIso })
      .where(and(eq(posts.id, id), eq(posts.status, 'scheduled')))
      .returning();
    return row ? toPost(row) : undefined;
  }

  /** Removes the waiting row of a piece not yet out; undefined when it was not scheduled */
  async unschedulePost(id: number): Promise<Post | undefined> {
    const [row] = await this.#db
      .delete(posts)
      .where(and(eq(posts.id, id), eq(posts.status, 'scheduled')))
      .returning();
    return row ? toPost(row) : undefined;
  }

  /** Drops what is left waiting of a launch's channel once that channel is done, or failed for good */
  async clearSchedule(launchId: number, channel: Channel): Promise<void> {
    await this.#db.delete(posts).where(and(eq(posts.launchId, launchId), eq(posts.channel, channel), eq(posts.status, 'scheduled')));
  }

  /** Every piece waiting for its time, the soonest first; those due by `dueBy` only, when given */
  async scheduledPosts(filter: { dueBy?: Date } = {}): Promise<Post[]> {
    const where: SQL[] = [eq(posts.status, 'scheduled')];
    if (filter.dueBy) where.push(sql`${posts.scheduledAt} <= ${filter.dueBy.toISOString()}`);
    const rows = await this.#db
      .select()
      .from(posts)
      .where(and(...where))
      .orderBy(asc(posts.scheduledAt), asc(posts.id));
    return rows.map(toPost);
  }

  /** `postId` for a reading of one piece; without it the reading is the launch's, as a site-level source's is */
  async recordMetrics(launchId: number, source: string, values: Record<string, number>, takenAt: Date, postId: number | null = null): Promise<void> {
    const at = takenAt.toISOString();
    const rows = Object.entries(values)
      .filter(([, value]) => Number.isFinite(value))
      .map(([name, value]) => ({ launchId, postId, source, name, value, takenAt: at }));
    if (rows.length > 0) await this.#db.insert(metrics).values(rows);
  }

  /** The newest reading of every metric of a launch, its pieces' added up. */
  async latestMetrics(launchId: number): Promise<MetricReading[]> {
    const last = this.#db
      .select({ source: metrics.source, name: metrics.name, at: sql<string>`max(${metrics.takenAt})`.as('at') })
      .from(metrics)
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.source, metrics.name)
      .as('last');
    return this.#db
      .select(summed)
      .from(metrics)
      .innerJoin(last, and(eq(last.source, metrics.source), eq(last.name, metrics.name), eq(last.at, metrics.takenAt)))
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.launchId, metrics.source, metrics.name, metrics.takenAt)
      .orderBy(asc(metrics.source), asc(metrics.name));
  }

  /** Every reading of one metric of a launch, oldest first: its curve. */
  async metricHistory(launchId: number, source: string, name: string): Promise<MetricReading[]> {
    return this.#db
      .select(summed)
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), eq(metrics.source, source), eq(metrics.name, name)))
      .groupBy(metrics.launchId, metrics.source, metrics.name, metrics.takenAt)
      .orderBy(asc(metrics.takenAt));
  }

  /**
   * Every reading of every piece of a launch, oldest first: the curves a launch's page draws beside
   * each piece. Site-level readings (no piece) are left out; `metricHistory` has those.
   */
  async postMetricHistory(launchId: number): Promise<Array<{ postId: number; name: string; value: number; takenAt: string }>> {
    const rows = await this.#db
      .select({ postId: metrics.postId, name: metrics.name, value: metrics.value, takenAt: metrics.takenAt })
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), sql`${metrics.postId} IS NOT NULL`))
      .orderBy(asc(metrics.takenAt));
    return rows.flatMap((r) => (r.postId === null ? [] : [{ postId: r.postId, name: r.name, value: r.value, takenAt: r.takenAt }]));
  }

  /** The newest reading of every metric of one piece. */
  async postMetrics(postId: number): Promise<MetricReading[]> {
    const last = this.#db
      .select({ name: metrics.name, at: sql<string>`max(${metrics.takenAt})`.as('at') })
      .from(metrics)
      .where(eq(metrics.postId, postId))
      .groupBy(metrics.name)
      .as('last');
    return this.#db
      .select(summed)
      .from(metrics)
      .innerJoin(last, and(eq(last.name, metrics.name), eq(last.at, metrics.takenAt)))
      .where(eq(metrics.postId, postId))
      .groupBy(metrics.launchId, metrics.source, metrics.name, metrics.takenAt)
      .orderBy(asc(metrics.name));
  }

  /**
   * The rows of a read-only query the query builder cannot say (window functions, FILTER, VALUES),
   * for the stats in stats.ts. Each driver shapes `execute`'s answer its own way: postgres.js gives
   * the rows as an array, PGlite an object holding them.
   */
  async selectRows<T extends Record<string, unknown>>(query: SQL): Promise<T[]> {
    const result: unknown = await this.#db.execute(query);
    if (Array.isArray(result)) return result as T[];
    return (result as { rows: T[] }).rows;
  }

  /** Something the owner chose (automation today), as it was stored; undefined until it is first set */
  async setting<T>(key: string): Promise<T | undefined> {
    const [row] = await this.#db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
    return row ? (row.value as T) : undefined;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.#db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: nowIso } });
  }

  /** Small pieces of polling state, such as the ETag of the last events page; what the owner chooses is a setting */
  async cursor(key: string): Promise<string | undefined> {
    const [row] = await this.#db.select({ value: cursors.value }).from(cursors).where(eq(cursors.key, key));
    return row?.value;
  }

  async setCursor(key: string, value: string): Promise<void> {
    await this.#db.insert(cursors).values({ key, value }).onConflictDoUpdate({ target: cursors.key, set: { value } });
  }

  async deleteCursor(key: string): Promise<void> {
    await this.#db.delete(cursors).where(eq(cursors.key, key));
  }

  /** Every cursor whose key starts with a prefix, such as the failures of one launch (`publish-failed:12:`) */
  async cursorsWithPrefix(prefix: string): Promise<Array<{ key: string; value: string }>> {
    // starts_with, not LIKE: a `_` in the prefix is a character, not a wildcard. Ordered bytewise, as
    // SQLite did, whatever collation the database was created with
    return this.#db
      .select({ key: cursors.key, value: cursors.value })
      .from(cursors)
      .where(sql`starts_with(${cursors.key}, ${prefix})`)
      .orderBy(sql`${cursors.key} COLLATE "C"`);
  }

  /**
   * Gives a channel whose publishing failed for good another chance, once its cause is fixed: the
   * failure is forgotten and its launch goes back to `drafted`, so the next publish round tries that
   * channel again. Pieces already out stay out; the registry never records one twice, so a launch
   * whose channel already has its post is left as it is.
   */
  async retryChannel(channel: Channel): Promise<Launch[]> {
    return this.#transaction(async (tx) => {
      const keys = await tx.#db
        .select({ key: cursors.key })
        .from(cursors)
        .where(like(cursors.key, `publish-failed:%:${channel}`));
      const reopened: Launch[] = [];
      for (const { key } of keys) {
        const id = Number(key.split(':')[1]);
        await tx.deleteCursor(key);
        const launch = await tx.get(id);
        // The newsletter has no single post: some issues may be out and others not, which the publish round sorts out
        if (launch && (await tx.posts(id, { channel, kind: 'post' })).length === 0) reopened.push(await tx.setStatus(id, 'drafted', launch.detail));
      }
      return reopened;
    });
  }

  async accounts(filter: { brand?: string; network?: string } = {}): Promise<Account[]> {
    const where: SQL[] = [];
    if (filter.brand !== undefined) where.push(eq(accounts.brand, filter.brand));
    if (filter.network !== undefined) where.push(eq(accounts.network, filter.network));
    const rows = await this.#db
      .select()
      .from(accounts)
      .where(and(...where))
      .orderBy(asc(accounts.network), asc(accounts.brand), desc(accounts.isPrimary), asc(accounts.label));
    return rows.map(toAccount);
  }

  async account(id: number): Promise<Account | undefined> {
    const [row] = await this.#db.select().from(accounts).where(eq(accounts.id, id));
    return row ? toAccount(row) : undefined;
  }

  /** The account a brand publishes with on a network, if it has one */
  async primaryAccount(brand: string, network: string): Promise<Account | undefined> {
    const [row] = await this.#db
      .select()
      .from(accounts)
      .where(and(eq(accounts.brand, brand), eq(accounts.network, network), eq(accounts.isPrimary, 1)))
      .limit(1);
    return row ? toAccount(row) : undefined;
  }

  /** A new account; the first one of its network and brand becomes the primary */
  async addAccount(account: { network: string; brand: string; label: string; settings: Record<string, string> }): Promise<Account> {
    return this.#transaction(async (tx) => {
      await tx.#lockAccounts(account.brand, account.network);
      const [existing] = await tx.#db
        .select({ n: count() })
        .from(accounts)
        .where(and(eq(accounts.brand, account.brand), eq(accounts.network, account.network)));
      const [row] = await tx.#db
        .insert(accounts)
        .values({
          network: account.network,
          brand: account.brand,
          label: account.label,
          settings: JSON.stringify(account.settings),
          isPrimary: existing?.n === 0 ? 1 : 0,
        })
        .returning();
      return toAccount(row!);
    });
  }

  async updateAccount(id: number, change: { label?: string; settings?: Record<string, string> }): Promise<Account> {
    const current = await this.account(id);
    if (!current) throw new Error(`no account with id ${id}`);
    const [row] = await this.#db
      .update(accounts)
      .set({ label: change.label ?? current.label, settings: JSON.stringify(change.settings ?? current.settings) })
      .where(eq(accounts.id, id))
      .returning();
    if (!row) throw new Error(`no account with id ${id}`);
    return toAccount(row);
  }

  /**
   * Records a check's answer. A working one that found a picture keeps it; a failed one, or one whose
   * network gave no picture this time, leaves the last one in place rather than blanking the page.
   */
  async recordCheck(id: number, check: { ok: true; account: string; avatarUrl?: string } | { ok: false; problem: string }, at = new Date()): Promise<Account> {
    const [row] = await this.#db
      .update(accounts)
      .set({
        status: check.ok ? 'ok' : 'failed',
        identity: check.ok ? check.account : null,
        problem: check.ok ? null : check.problem,
        checkedAt: at.toISOString(),
        ...(check.ok && check.avatarUrl ? { avatarUrl: check.avatarUrl } : {}),
      })
      .where(eq(accounts.id, id))
      .returning();
    if (!row) throw new Error(`no account with id ${id}`);
    return toAccount(row);
  }

  /** Makes one account the one its brand publishes with on that network */
  async makePrimary(id: number): Promise<Account> {
    const account = await this.account(id);
    if (!account) throw new Error(`no account with id ${id}`);
    return this.#transaction(async (tx) => {
      await tx.#lockAccounts(account.brand, account.network);
      await tx.#db
        .update(accounts)
        .set({ isPrimary: 0 })
        .where(and(eq(accounts.brand, account.brand), eq(accounts.network, account.network)));
      const [row] = await tx.#db.update(accounts).set({ isPrimary: 1 }).where(eq(accounts.id, id)).returning();
      // Deleted between the read and the lock: the rollback leaves the old primary in place
      if (!row) throw new Error(`no account with id ${id}`);
      return toAccount(row);
    });
  }

  /** Removes an account; when it was the primary, the next one of its network and brand takes over */
  async deleteAccount(id: number): Promise<void> {
    const account = await this.account(id);
    if (!account) return;
    await this.#transaction(async (tx) => {
      await tx.#lockAccounts(account.brand, account.network);
      const [deleted] = await tx.#db.delete(accounts).where(eq(accounts.id, id)).returning({ primary: accounts.isPrimary });
      if (deleted?.primary === 1) {
        const [next] = await tx.accounts({ brand: account.brand, network: account.network });
        if (next) await tx.makePrimary(next.id);
      }
    });
  }

  /**
   * Records an account's numbers for the UTC day of `at`. A day keeps one row, the latest reading:
   * a Sync now in the afternoon replaces the night's, so the history has one point a day.
   */
  async recordSnapshot(accountId: number, stats: SnapshotStats, at = new Date()): Promise<AccountSnapshot> {
    const values = {
      accountId,
      day: at.toISOString().slice(0, 10),
      takenAt: at.toISOString(),
      followers: stats.followers ?? null,
      following: stats.following ?? null,
      posts: stats.posts ?? null,
      extra: stats.extra ?? {},
    };
    const [row] = await this.#db
      .insert(accountSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [accountSnapshots.accountId, accountSnapshots.day],
        set: { takenAt: values.takenAt, followers: values.followers, following: values.following, posts: values.posts, extra: values.extra },
        // A reading that arrives late (a retried job) never replaces a newer one of the same day
        setWhere: sql`${accountSnapshots.takenAt} <= ${values.takenAt}`,
      })
      .returning();
    if (row) return toSnapshot(row);
    const [kept] = await this.#db.select().from(accountSnapshots).where(and(eq(accountSnapshots.accountId, accountId), eq(accountSnapshots.day, values.day)));
    return toSnapshot(kept!);
  }

  /** An account's history, oldest first: one point a day, from `since` (a YYYY-MM-DD) when given */
  async accountSnapshots(accountId: number, filter: { since?: string; limit?: number } = {}): Promise<AccountSnapshot[]> {
    const where = [eq(accountSnapshots.accountId, accountId)];
    if (filter.since !== undefined) where.push(gte(accountSnapshots.day, filter.since));
    const rows = await this.#db
      .select()
      .from(accountSnapshots)
      .where(and(...where))
      .orderBy(asc(accountSnapshots.day))
      .limit(filter.limit ?? 1000);
    return rows.map(toSnapshot);
  }

  /** The newest snapshot of an account, if it has any */
  async lastSnapshot(accountId: number): Promise<AccountSnapshot | undefined> {
    const [row] = await this.#db.select().from(accountSnapshots).where(eq(accountSnapshots.accountId, accountId)).orderBy(desc(accountSnapshots.day)).limit(1);
    return row ? toSnapshot(row) : undefined;
  }

  /** The newest snapshot of every account that has one, by account: what the Channels page shows */
  async lastSnapshots(): Promise<Map<number, AccountSnapshot>> {
    const rows = await this.#db
      .selectDistinctOn([accountSnapshots.accountId])
      .from(accountSnapshots)
      .orderBy(asc(accountSnapshots.accountId), desc(accountSnapshots.day));
    return new Map(rows.map((row) => [row.accountId, toSnapshot(row)]));
  }

  /**
   * What Shipcast has published with each account: how many pieces went out (not the scheduled ones)
   * and when the last did, for the account's card
   */
  async postActivity(): Promise<Map<number, { count: number; last: string | null }>> {
    const rows = await this.#db
      .select({ accountId: posts.accountId, count: count(), last: max(posts.publishedAt) })
      .from(posts)
      .where(and(sql`${posts.accountId} is not null`, notInArray(posts.status, ['scheduled'])))
      .groupBy(posts.accountId);
    return new Map(rows.map((r) => [r.accountId!, { count: Number(r.count), last: r.last ?? null }]));
  }

  /** A token for the REST API, by its hash; the token itself is shown once and never stored */
  async addApiToken(token: { name: string; hash: string; scopes: ApiScope[] }): Promise<ApiToken> {
    const [row] = await this.#db.insert(apiTokens).values(token).returning();
    return toApiToken(row!);
  }

  /** One token with its hash, which only the code that verifies a token should read */
  async apiToken(id: number): Promise<(ApiToken & { hash: string }) | undefined> {
    const [row] = await this.#db.select().from(apiTokens).where(eq(apiTokens.id, id));
    return row ? { ...toApiToken(row), hash: row.hash } : undefined;
  }

  /** Every token, revoked ones too, the newest first; never their hashes */
  async apiTokens(): Promise<ApiToken[]> {
    const rows = await this.#db.select().from(apiTokens).orderBy(desc(apiTokens.id));
    return rows.map(toApiToken);
  }

  async touchApiToken(id: number, at = new Date()): Promise<void> {
    await this.#db.update(apiTokens).set({ lastUsedAt: at.toISOString() }).where(eq(apiTokens.id, id));
  }

  /** Revoking is for good; a token revoked already keeps its first revocation time */
  async revokeApiToken(id: number, at = new Date()): Promise<ApiToken | undefined> {
    const [row] = await this.#db
      .update(apiTokens)
      .set({ revokedAt: sql`coalesce(${apiTokens.revokedAt}, ${at.toISOString()})` })
      .where(eq(apiTokens.id, id))
      .returning();
    return row ? toApiToken(row) : undefined;
  }

  /**
   * A page of launches, the newest first, for the REST API. Keyset paging on (created_at, id), the
   * order `recent` uses, so a launch claimed while a client pages never shifts or repeats a page.
   */
  async launchesPage(options: { limit: number; status?: LaunchStatus; after?: { createdAt: string; id: number } }): Promise<{ launches: Launch[]; next?: { createdAt: string; id: number } }> {
    const where: SQL[] = [];
    if (options.status !== undefined) where.push(eq(launches.status, options.status));
    if (options.after) where.push(sql`(${launches.createdAt}, ${launches.id}) < (${options.after.createdAt}, ${options.after.id})`);
    const rows = await this.#db
      .select()
      .from(launches)
      .where(and(...where))
      .orderBy(desc(launches.createdAt), desc(launches.id))
      .limit(options.limit + 1);
    const page = rows.slice(0, options.limit).map(toLaunch);
    const last = page.at(-1);
    return rows.length > options.limit && last ? { launches: page, next: { createdAt: last.createdAt, id: last.id } } : { launches: page };
  }

  /** Records a job of the queue; a second record of the same id keeps the first and returns it */
  async recordJob(job: { id: string; queue: string; title: string; launchId?: number | null }): Promise<JobRecord> {
    const [inserted] = await this.#db
      .insert(jobs)
      .values({ id: job.id, queue: job.queue, title: job.title, launchId: job.launchId ?? null })
      .onConflictDoNothing({ target: jobs.id })
      .returning();
    return inserted ? toJob(inserted) : (await this.job(job.id))!;
  }

  async updateJob(id: string, change: JobChange): Promise<void> {
    const set: Partial<{ [K in keyof typeof jobs.$inferInsert]: (typeof jobs.$inferInsert)[K] | SQL }> = {};
    if (change.title !== undefined) set.title = change.title;
    if (change.state !== undefined) set.state = change.state;
    if (change.attempts !== undefined) set.attempts = change.attempts;
    if (change.link !== undefined) set.link = change.link;
    if (change.started) set.startedAt = sql`coalesce(${jobs.startedAt}, ${nowIso})`;
    if (change.ended !== undefined) set.endedAt = change.ended ? nowIso : null;
    if (Object.keys(set).length === 0) return;
    await this.#db.update(jobs).set(set).where(eq(jobs.id, id));
  }

  /** Adds a line to a job's log, dropping the oldest once it holds JOB_LOG_LINES */
  async logJob(id: string, line: string): Promise<void> {
    const appended = sql`${jobs.log} || to_jsonb(${line}::text)`;
    await this.#db
      .update(jobs)
      // `jsonb - 0` drops the first element; one line in, one out keeps the log bounded
      .set({ log: sql`CASE WHEN jsonb_array_length(${jobs.log}) >= ${JOB_LOG_LINES} THEN (${appended}) - 0 ELSE ${appended} END` })
      .where(eq(jobs.id, id));
  }

  async job(id: string): Promise<JobRecord | undefined> {
    const [row] = await this.#db.select().from(jobs).where(eq(jobs.id, id));
    return row ? toJob(row) : undefined;
  }

  /** The newest first: a launch's, those created since a moment, those in some states; a page at a time with `offset` or `before` */
  async jobs(filter: JobFilter = {}): Promise<JobRecord[]> {
    const where = jobConditions(filter);
    // Keyset: the jobs strictly older than the last one of the previous page, in the list's own order
    if (filter.before) where.push(sql`(${jobs.createdAt}, ${jobs.id}) < (${filter.before.createdAt}, ${filter.before.id})`);
    const query = this.#db
      .select()
      .from(jobs)
      .where(and(...where))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(filter.limit ?? 100)
      .$dynamic();
    return (await (filter.offset ? query.offset(filter.offset) : query)).map(toJob);
  }

  /** How many jobs of a filter are in each state, from one grouped query whatever their number */
  async jobCounts(filter: JobConditions = {}): Promise<Record<JobState, number>> {
    const rows = await this.#db
      .select({ state: jobs.state, n: count() })
      .from(jobs)
      .where(and(...jobConditions(filter)))
      .groupBy(jobs.state);
    const counts: Record<JobState, number> = { created: 0, active: 0, retry: 0, completed: 0, failed: 0 };
    for (const row of rows) if (row.state in counts) counts[row.state as JobState] = Number(row.n);
    return counts;
  }

  /** Forgets the jobs that ended before a moment; returns how many */
  async pruneJobs(endedBefore: string): Promise<number> {
    const deleted = await this.#db.delete(jobs).where(lt(jobs.endedAt, endedBefore)).returning({ id: jobs.id });
    return deleted.length;
  }

  /**
   * The posts whose comments are read: each channel's own post (not a story, an issue or an
   * article), still up (live or edited), published since a moment, on the channels asked.
   */
  async postsSince(since: string, channels: readonly Channel[]): Promise<Post[]> {
    if (channels.length === 0) return [];
    const rows = await this.#db
      .select()
      .from(posts)
      .where(and(gte(posts.publishedAt, since), inArray(posts.channel, [...channels]), eq(posts.kind, 'post'), inArray(posts.status, ['live', 'edited'])))
      .orderBy(asc(posts.publishedAt), asc(posts.id));
    return rows.map(toPost);
  }

  /**
   * Records a comment unless its channel already has one with that id: reading a thread again is a
   * no-op for what is known, and `ON CONFLICT` keeps two readers at once from adding it twice.
   */
  async recordComment(comment: NewComment): Promise<{ recorded: boolean; comment: CommentRecord }> {
    const [inserted] = await this.#db
      .insert(comments)
      .values({
        postId: comment.postId,
        channel: comment.channel,
        externalId: comment.externalId,
        authorHandle: comment.author.handle,
        authorName: comment.author.displayName ?? null,
        authorAvatarUrl: comment.author.avatarUrl ?? null,
        text: comment.text,
        url: comment.url ?? null,
        createdAt: comment.createdAt,
        inReplyTo: comment.inReplyTo ?? null,
        own: comment.own,
        status: comment.status ?? 'new',
      })
      .onConflictDoNothing({ target: [comments.channel, comments.externalId] })
      .returning({ id: comments.id });
    if (inserted) return { recorded: true, comment: (await this.comment(inserted.id))! };
    const [row] = await this.#db
      .select({ id: comments.id })
      .from(comments)
      .where(and(eq(comments.channel, comment.channel), eq(comments.externalId, comment.externalId)));
    return { recorded: false, comment: (await this.comment(row!.id))! };
  }

  async comment(id: number): Promise<CommentRecord | undefined> {
    const [row] = await this.#db.select({ comment: comments, launchId: posts.launchId }).from(comments).innerJoin(posts, eq(comments.postId, posts.id)).where(eq(comments.id, id));
    return row ? toComment(row.comment, row.launchId) : undefined;
  }

  /** The comment of a channel with that network id, if it is known */
  async commentByExternalId(channel: Channel, externalId: string): Promise<CommentRecord | undefined> {
    const [row] = await this.#db
      .select({ comment: comments, launchId: posts.launchId })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(and(eq(comments.channel, channel), eq(comments.externalId, externalId)));
    return row ? toComment(row.comment, row.launchId) : undefined;
  }

  /** The newest first, as written on the network */
  async comments(filter: CommentFilter = {}): Promise<CommentRecord[]> {
    const where: SQL[] = [];
    if (filter.status !== undefined) where.push(eq(comments.status, filter.status));
    if (filter.channel !== undefined) where.push(eq(comments.channel, filter.channel));
    if (filter.launchId !== undefined) where.push(eq(posts.launchId, filter.launchId));
    if (filter.postId !== undefined) where.push(eq(comments.postId, filter.postId));
    if (filter.own !== undefined) where.push(eq(comments.own, filter.own));
    const rows = await this.#db
      .select({ comment: comments, launchId: posts.launchId })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(filter.limit ?? 200);
    return rows.map((r) => toComment(r.comment, r.launchId));
  }

  /**
   * One page of comments, newest first, for the Comments page: the filters become one WHERE over
   * the comment and its post (one join, the indexes on status, channel and date serve it) and the
   * total comes from a count of the same filter, so the list is never read whole to be paged.
   */
  async commentsPage(filter: CommentPageFilter = {}): Promise<CommentPage> {
    const where: SQL[] = [];
    if (filter.bucket !== undefined) where.push(inArray(comments.status, [...COMMENT_BUCKETS[filter.bucket]]));
    if (filter.channel !== undefined) where.push(eq(comments.channel, filter.channel));
    if (filter.launchId !== undefined) where.push(eq(posts.launchId, filter.launchId));
    if (filter.postId !== undefined) where.push(eq(comments.postId, filter.postId));
    if (filter.own !== undefined) where.push(eq(comments.own, filter.own));
    const words = filter.search?.trim();
    if (words) {
      const pattern = likePattern(words);
      const match = or(ilike(comments.text, pattern), ilike(comments.authorHandle, pattern), ilike(comments.authorName, pattern));
      if (match) where.push(match);
    }
    const condition = where.length > 0 ? and(...where) : undefined;
    const pageSize = Math.min(Math.max(Math.trunc(filter.pageSize ?? 25), 1), 100);
    const [totalRow] = await this.#db.select({ n: count() }).from(comments).innerJoin(posts, eq(comments.postId, posts.id)).where(condition);
    const total = Number(totalRow?.n ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    // A page past the end (a link kept after the list shrank) shows the last one
    const page = Math.min(Math.max(Math.trunc(filter.page ?? 1), 1), pages);
    const rows = await this.#db
      .select({ comment: comments, launchId: posts.launchId })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(condition)
      .orderBy(desc(comments.createdAt), desc(comments.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { comments: rows.map((r) => toComment(r.comment, r.launchId)), total, page, pageSize, pages };
  }

  /** The options of the page's filters, from three grouped queries whatever the number of comments */
  async commentFacets(own = false): Promise<CommentFacets> {
    const mine = eq(comments.own, own);
    const [channels, launchRows, statuses] = await Promise.all([
      this.#db.select({ channel: comments.channel, n: count() }).from(comments).where(mine).groupBy(comments.channel).orderBy(asc(comments.channel)),
      this.#db
        .select({ id: launches.id, repo: launches.repo, ref: launches.ref, n: count() })
        .from(comments)
        .innerJoin(posts, eq(comments.postId, posts.id))
        .innerJoin(launches, eq(posts.launchId, launches.id))
        .where(mine)
        .groupBy(launches.id, launches.repo, launches.ref)
        .orderBy(desc(launches.id)),
      this.#db.select({ status: comments.status, n: count() }).from(comments).where(mine).groupBy(comments.status),
    ]);
    const byStatus = new Map(statuses.map((r) => [r.status, Number(r.n)]));
    const sum = (bucket: CommentBucket) => COMMENT_BUCKETS[bucket].reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);
    return {
      channels: channels.map((r) => ({ channel: r.channel as Channel, count: Number(r.n) })),
      launches: launchRows.map((r) => ({ id: r.id, repo: r.repo, ref: r.ref, count: Number(r.n) })),
      buckets: { waiting: sum('waiting'), replied: sum('replied'), ignored: sum('ignored') },
    };
  }

  /** The newest comment still waiting for a reply, so the bell's line about them is new when one arrives */
  async newestWaitingCommentId(own = false): Promise<number | null> {
    const [row] = await this.#db
      .select({ id: max(comments.id) })
      .from(comments)
      .where(and(eq(comments.own, own), inArray(comments.status, [...COMMENT_BUCKETS.waiting])));
    return row?.id ?? null;
  }

  /** Hides the bell's lines with these keys; dismissing one twice keeps its first time */
  async dismissAttention(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.#db
      .insert(attentionDismissals)
      .values([...new Set(keys)].map((key) => ({ key })))
      .onConflictDoNothing();
  }

  /** Which of these keys were dismissed */
  async dismissedAttention(keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.#db.select({ key: attentionDismissals.key }).from(attentionDismissals).where(inArray(attentionDismissals.key, [...keys]));
    return new Set(rows.map((r) => r.key));
  }

  /**
   * Forgets every dismissal but those of `keep`: the bell passes the lines it has now, so the
   * dismissal of a line whose condition ended goes, and the same condition coming back is shown again
   */
  async clearAttentionDismissals(keep: readonly string[] = []): Promise<number> {
    const rows = await this.#db
      .delete(attentionDismissals)
      .where(keep.length > 0 ? notInArray(attentionDismissals.key, [...keep]) : undefined)
      .returning({ key: attentionDismissals.key });
    return rows.length;
  }

  /** The posts of a launch that have comments, for the filter that narrows to one post */
  async commentPosts(launchId: number, own = false): Promise<Array<{ id: number; channel: Channel; kind: string; url: string | null; count: number }>> {
    const rows = await this.#db
      .select({ id: posts.id, channel: posts.channel, kind: posts.kind, url: posts.url, n: count() })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(and(eq(posts.launchId, launchId), eq(comments.own, own)))
      .groupBy(posts.id, posts.channel, posts.kind, posts.url)
      .orderBy(asc(posts.id));
    return rows.map((r) => ({ id: r.id, channel: r.channel as Channel, kind: r.kind, url: r.url, count: Number(r.n) }));
  }

  /**
   * How many replies Shipcast sent under a launch's posts, per channel: the number a launch's card
   * shows instead of a row for every comment, since an answered thread can run to dozens.
   */
  async sentReplies(launchId: number): Promise<Record<string, number>> {
    const rows = await this.#db
      .select({ channel: comments.channel, n: count() })
      .from(comments)
      .innerJoin(posts, eq(comments.postId, posts.id))
      .where(and(eq(posts.launchId, launchId), eq(comments.status, 'sent'), eq(comments.own, false)))
      .groupBy(comments.channel);
    return Object.fromEntries(rows.map((r) => [r.channel, Number(r.n)]));
  }

  /**
   * Changes a comment, only while it is in one of the states given when `onlyIf` is set: the
   * compare-and-set that lets one sender claim a reply, so two clicks never send it twice.
   * Undefined when the comment does not exist or was in another state.
   */
  async updateComment(id: number, change: CommentChange, onlyIf?: readonly CommentStatus[]): Promise<CommentRecord | undefined> {
    const where = onlyIf ? and(eq(comments.id, id), inArray(comments.status, [...onlyIf])) : eq(comments.id, id);
    const [row] = await this.#db
      .update(comments)
      .set({ ...change, updatedAt: nowIso })
      .where(where)
      .returning({ id: comments.id });
    return row ? this.comment(row.id) : undefined;
  }

  async createAssistantSession(session: NewAssistantSession): Promise<AssistantSession> {
    const [row] = await this.#db
      .insert(assistantSessions)
      .values({ title: session.title, launchId: session.launchId ?? null, draftPath: session.draftPath ?? null, draftLabel: session.draftLabel ?? null })
      .returning();
    return row!;
  }

  async assistantSession(id: number): Promise<AssistantSession | undefined> {
    const [row] = await this.#db.select().from(assistantSessions).where(eq(assistantSessions.id, id));
    return row;
  }

  /** Adds a turn and moves the session to the top of the list; undefined when the session is gone */
  async addAssistantMessage(sessionId: number, message: NewAssistantMessage): Promise<AssistantMessage | undefined> {
    return this.#db.transaction(async (tx) => {
      const [touched] = await tx.update(assistantSessions).set({ updatedAt: nowIso }).where(eq(assistantSessions.id, sessionId)).returning({ id: assistantSessions.id });
      if (!touched) return undefined;
      const [row] = await tx
        .insert(assistantMessages)
        .values({ sessionId, role: message.role, content: message.content, proposals: message.proposals ?? [], selection: message.selection ?? null, problem: message.problem ?? null })
        .returning();
      return toAssistantMessage(row!);
    });
  }

  /** The session's turns in the order they were said */
  async assistantMessages(sessionId: number): Promise<AssistantMessage[]> {
    const rows = await this.#db.select().from(assistantMessages).where(eq(assistantMessages.sessionId, sessionId)).orderBy(asc(assistantMessages.id));
    return rows.map(toAssistantMessage);
  }

  /** Records what the owner did with one proposal of an answer; false when there is no such proposal */
  async settleAssistantProposal(messageId: number, index: number, state: 'accepted' | 'rejected'): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx.select({ proposals: assistantMessages.proposals }).from(assistantMessages).where(eq(assistantMessages.id, messageId)).for('update');
      const proposal = row?.proposals[index];
      if (!row || !proposal) return false;
      const proposals = row.proposals.map((p, i) => (i === index ? { ...p, state } : p));
      await tx.update(assistantMessages).set({ proposals }).where(eq(assistantMessages.id, messageId));
      return true;
    });
  }

  /** Sessions, the most recently talked in first, a page at a time: pass the previous page's `next` for the following one */
  async assistantSessions(options: { limit?: number; cursor?: string } = {}): Promise<AssistantSessionPage> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const at = options.cursor === undefined ? undefined : decodeSessionCursor(options.cursor);
    const where = at
      ? or(lt(assistantSessions.updatedAt, at.updatedAt), and(eq(assistantSessions.updatedAt, at.updatedAt), lt(assistantSessions.id, at.id)))
      : undefined;
    const rows = await this.#db.select().from(assistantSessions).where(where).orderBy(desc(assistantSessions.updatedAt), desc(assistantSessions.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { sessions: page, next: rows.length > limit && last ? encodeSessionCursor(last) : null };
  }

  async close(): Promise<void> {
    await this.#close();
  }
}
