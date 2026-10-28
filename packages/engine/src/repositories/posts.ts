import { and, asc, count, eq, gte, inArray, max, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Channel, Language } from '@shipcast/schema';
import type { Database } from '../db/connect.ts';
import { nowIso, posts } from '../db/schema.ts';
import { lockFor, transaction } from './transaction.ts';

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
 * A launch's pieces: what went out, what waits for its time, and what was edited or deleted after.
 * Their publish attempts (the outbox) are publishing/attempts.ts', on the same piece.
 */
export class PostRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Runs `work` in one transaction, on a repository over it; a nested call becomes a savepoint */
  #transaction<T>(work: (tx: PostRepository) => Promise<T>): Promise<T> {
    return transaction(this.#db, (db) => work(new PostRepository(db)));
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
      await lockFor(tx.#db, `schedule:${launchId}:${channel}`);
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
}
