import { and, asc, count, desc, eq, gte, ilike, inArray, like, lt, max, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Channel, Language } from '@shipcast/schema';
import { connectPglite, connectPostgres, type Database } from './db/connect.ts';
import { LaunchRepository } from './repositories/launches.ts';
import { JobRepository } from './repositories/jobs.ts';
import { AccountRepository } from './repositories/accounts.ts';
import { CursorRepository } from './repositories/cursors.ts';
import { SettingRepository } from './repositories/settings.ts';
import { MetricRepository } from './repositories/metrics.ts';
import { PostRepository } from './repositories/posts.ts';
import { accounts, accountSnapshots, apiTokens, assistantMessages, assistantSessions, attentionDismissals, comments, cursors, jobs, launches, metrics, nowIso, posts, settings } from './db/schema.ts';

export * from './repositories/index.ts';

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
  readonly launches: LaunchRepository;
  readonly jobs: JobRepository;
  readonly accounts: AccountRepository;
  readonly cursors: CursorRepository;
  readonly settings: SettingRepository;
  readonly metrics: MetricRepository;
  readonly posts: PostRepository;

  /** Over a database whose schema is already migrated; `connect` and `memory` are the way in */
  constructor(db: Database, close: () => Promise<void> = async () => {}) {
    this.#db = db;
    this.#close = close;
    this.launches = new LaunchRepository(db);
    this.jobs = new JobRepository(db);
    this.accounts = new AccountRepository(db);
    this.cursors = new CursorRepository(db);
    this.settings = new SettingRepository(db);
    this.metrics = new MetricRepository(db);
    this.posts = new PostRepository(db);
  }

  /**
   * The connection, for the stores that sit beside the registry on the same schema and pool (the
   * measurement's, then the repositories the registry is split into)
   */
  get database(): Database {
    return this.#db;
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
