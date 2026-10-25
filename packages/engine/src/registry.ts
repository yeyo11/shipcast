import { and, asc, count, desc, eq, like, sql, type SQL } from 'drizzle-orm';
import type { Channel, PackKind } from '@shipcast/schema';
import { connectPglite, connectPostgres, type Database } from './db/connect.ts';
import { accounts, cursors, launches, metrics, nowIso, posts } from './db/schema.ts';

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

export interface Post {
  launchId: number;
  channel: Channel;
  url: string | null;
  externalId: string | null;
  publishedAt: string;
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
}

/** One number read from one source for one launch, at one moment. */
export interface MetricReading {
  launchId: number;
  /** A channel (`devto`, `bluesky`…), or a site-level source (`blog`, `search`, `github`) */
  source: string;
  name: string;
  value: number;
  takenAt: string;
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

const reading = {
  launchId: metrics.launchId,
  source: metrics.source,
  name: metrics.name,
  value: metrics.value,
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

  /** One post per launch and channel: publishing the same piece twice is refused, not repeated. */
  async recordPost(post: Omit<Post, 'publishedAt'>): Promise<{ recorded: boolean }> {
    const inserted = await this.#db
      .insert(posts)
      .values({ launchId: post.launchId, channel: post.channel, url: post.url, externalId: post.externalId })
      .onConflictDoNothing({ target: [posts.launchId, posts.channel] })
      .returning({ launchId: posts.launchId });
    return { recorded: inserted.length === 1 };
  }

  async posts(launchId: number): Promise<Post[]> {
    const rows = await this.#db
      .select()
      .from(posts)
      .where(eq(posts.launchId, launchId))
      .orderBy(asc(posts.publishedAt), asc(posts.channel));
    return rows.map((r) => ({ launchId: r.launchId, channel: r.channel as Channel, url: r.url, externalId: r.externalId, publishedAt: r.publishedAt }));
  }

  async recordMetrics(launchId: number, source: string, values: Record<string, number>, takenAt: Date): Promise<void> {
    const at = takenAt.toISOString();
    const rows = Object.entries(values)
      .filter(([, value]) => Number.isFinite(value))
      .map(([name, value]) => ({ launchId, source, name, value, takenAt: at }));
    if (rows.length > 0) await this.#db.insert(metrics).values(rows);
  }

  /** The newest reading of every metric of a launch. */
  async latestMetrics(launchId: number): Promise<MetricReading[]> {
    const last = this.#db
      .select({ source: metrics.source, name: metrics.name, at: sql<string>`max(${metrics.takenAt})`.as('at') })
      .from(metrics)
      .where(eq(metrics.launchId, launchId))
      .groupBy(metrics.source, metrics.name)
      .as('last');
    return this.#db
      .select(reading)
      .from(metrics)
      .innerJoin(last, and(eq(last.source, metrics.source), eq(last.name, metrics.name), eq(last.at, metrics.takenAt)))
      .where(eq(metrics.launchId, launchId))
      .orderBy(asc(metrics.source), asc(metrics.name));
  }

  /** Every reading of one metric of a launch, oldest first: its curve. */
  async metricHistory(launchId: number, source: string, name: string): Promise<MetricReading[]> {
    return this.#db
      .select(reading)
      .from(metrics)
      .where(and(eq(metrics.launchId, launchId), eq(metrics.source, source), eq(metrics.name, name)))
      .orderBy(asc(metrics.takenAt));
  }

  /** Small pieces of polling state, such as the ETag of the last events page. */
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
   * channel again. Channels already posted stay posted; the registry never posts one twice.
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
        if (launch && !(await tx.posts(id)).some((p) => p.channel === channel)) reopened.push(await tx.setStatus(id, 'drafted', launch.detail));
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

  async recordCheck(id: number, check: { ok: true; account: string } | { ok: false; problem: string }, at = new Date()): Promise<Account> {
    const [row] = await this.#db
      .update(accounts)
      .set({
        status: check.ok ? 'ok' : 'failed',
        identity: check.ok ? check.account : null,
        problem: check.ok ? null : check.problem,
        checkedAt: at.toISOString(),
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

  async close(): Promise<void> {
    await this.#close();
  }
}
