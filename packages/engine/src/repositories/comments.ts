import { and, asc, count, desc, eq, ilike, inArray, max, or, type SQL } from 'drizzle-orm';
import type { Channel } from '@shipcast/schema';
import type { Database } from '../db/connect.ts';
import { comments, launches, nowIso, posts } from '../db/schema.ts';
import { likePattern } from './sql.ts';

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

/** The comments under Shipcast's posts and the replies drafted and sent for them */
export class CommentRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
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
}
