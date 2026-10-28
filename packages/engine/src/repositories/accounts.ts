import { and, asc, count, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { accounts, accountSnapshots } from '../db/schema.ts';
import { lockFor, transaction } from './transaction.ts';

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

/** The connected accounts of each network and brand, which one is the primary, and their daily numbers */
export class AccountRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Runs `work` in one transaction, on a repository over it; a nested call becomes a savepoint */
  #transaction<T>(work: (tx: AccountRepository) => Promise<T>): Promise<T> {
    return transaction(this.#db, (db) => work(new AccountRepository(db)));
  }

  /**
   * Serialises the writers of one network and brand's accounts until the transaction ends: under
   * read committed, two transactions could each see no primary and both insert one.
   */
  async #lockAccounts(brand: string, network: string): Promise<void> {
    await lockFor(this.#db, `accounts:${network}:${brand}`);
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
}
