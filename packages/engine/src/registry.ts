import { and, asc, count, desc, eq, gte, inArray, like, lt, sql, type SQL } from 'drizzle-orm';
import type { Channel, Language, PackKind } from '@shipcast/schema';
import { connectPglite, connectPostgres, type Database } from './db/connect.ts';
import { accounts, accountSnapshots, apiTokens, cursors, jobs, launches, metrics, nowIso, posts, settings } from './db/schema.ts';

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
 * newsletter issue or one blog article per language.
 */
export type PostKind = 'post' | 'story' | 'comment' | `issue:${Language}` | `article:${Language}`;

/** `scheduled`, `edited` and `deleted` are for what comes next (scheduling, edits); the engine records `live` today */
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
    const values = {
      launchId: post.launchId,
      channel: post.channel,
      accountId: post.accountId ?? null,
      kind: post.kind ?? 'post',
      externalId: post.externalId,
      url: post.url,
      status: post.status ?? 'live',
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

  /** The newest first: a launch's, those created since a moment, those in some states */
  async jobs(filter: { launchId?: number; since?: string; states?: readonly JobState[]; queues?: readonly string[]; limit?: number } = {}): Promise<JobRecord[]> {
    const where: SQL[] = [];
    if (filter.launchId !== undefined) where.push(eq(jobs.launchId, filter.launchId));
    if (filter.since !== undefined) where.push(gte(jobs.createdAt, filter.since));
    if (filter.states) where.push(inArray(jobs.state, [...filter.states]));
    if (filter.queues) where.push(inArray(jobs.queue, [...filter.queues]));
    const rows = await this.#db
      .select()
      .from(jobs)
      .where(and(...where))
      .orderBy(desc(jobs.createdAt), desc(jobs.id))
      .limit(filter.limit ?? 100);
    return rows.map(toJob);
  }

  /** Forgets the jobs that ended before a moment; returns how many */
  async pruneJobs(endedBefore: string): Promise<number> {
    const deleted = await this.#db.delete(jobs).where(lt(jobs.endedAt, endedBefore)).returning({ id: jobs.id });
    return deleted.length;
  }

  async close(): Promise<void> {
    await this.#close();
  }
}
