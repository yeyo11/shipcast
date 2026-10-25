import { DatabaseSync } from 'node:sqlite';
import type { Channel, PackKind } from '@shipcast/schema';

/** What started a launch; the launch.yml `triggers` decide which of these are honoured. */
export type Trigger = 'release' | 'manual' | 'public' | 'enabled';

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

/**
 * Each entry upgrades the schema by one version (`PRAGMA user_version`). Append only: an edited
 * migration would never run again on a database that already passed it.
 */
const MIGRATIONS = [
  `CREATE TABLE launches (
     id INTEGER PRIMARY KEY,
     repo TEXT NOT NULL,
     ref TEXT NOT NULL,
     trigger TEXT NOT NULL,
     kind TEXT NOT NULL,
     brand TEXT NOT NULL,
     status TEXT NOT NULL,
     detail TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     UNIQUE (repo, ref)
   );
   CREATE TABLE posts (
     launch_id INTEGER NOT NULL REFERENCES launches (id),
     channel TEXT NOT NULL,
     url TEXT,
     external_id TEXT,
     published_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     PRIMARY KEY (launch_id, channel)
   );
   CREATE TABLE cursors (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // Every reading is kept, so the dashboard shows how a launch grew, not only where it stands
  `CREATE TABLE metrics (
     launch_id INTEGER NOT NULL REFERENCES launches (id),
     source TEXT NOT NULL,
     name TEXT NOT NULL,
     value REAL NOT NULL,
     taken_at TEXT NOT NULL
   );
   CREATE INDEX metrics_by_launch ON metrics (launch_id, source, name, taken_at);`,
  // Accounts connected from the app: public settings here, secrets in the keychain under `account:<id>`
  `CREATE TABLE accounts (
     id INTEGER PRIMARY KEY,
     network TEXT NOT NULL,
     brand TEXT NOT NULL,
     label TEXT NOT NULL,
     settings TEXT NOT NULL DEFAULT '{}',
     is_primary INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'unchecked',
     identity TEXT,
     problem TEXT,
     checked_at TEXT,
     created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
     UNIQUE (network, brand, label)
   );`,
];

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

interface AccountRow {
  id: number;
  network: string;
  brand: string;
  label: string;
  settings: string;
  is_primary: number;
  status: string;
  identity: string | null;
  problem: string | null;
  checked_at: string | null;
  created_at: string;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    network: row.network,
    brand: row.brand,
    label: row.label,
    settings: JSON.parse(row.settings) as Record<string, string>,
    primary: row.is_primary === 1,
    status: row.status as AccountStatus,
    identity: row.identity,
    problem: row.problem,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
  };
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

interface LaunchRow {
  id: number;
  repo: string;
  ref: string;
  trigger: string;
  kind: string;
  brand: string;
  status: string;
  detail: string | null;
  created_at: string;
  updated_at: string;
}

function toLaunch(row: LaunchRow): Launch {
  return {
    id: row.id,
    repo: row.repo,
    ref: row.ref,
    trigger: row.trigger as Trigger,
    kind: row.kind as PackKind,
    brand: row.brand,
    status: row.status as LaunchStatus,
    detail: row.detail,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The launch registry: the record that makes "a launch happens once" hold. A release is claimed
 * before anything is generated, and the claim is a unique row, so a second poll, a re-run or a
 * crash halfway through never starts the same campaign twice.
 */
export class Registry {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.#migrate();
  }

  #migrate(): void {
    const { user_version: current } = this.#db.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let version = current; version < MIGRATIONS.length; version++) {
      this.#db.exec('BEGIN');
      try {
        this.#db.exec(MIGRATIONS[version]!);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
        this.#db.exec('COMMIT');
      } catch (error) {
        this.#db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /**
   * Records a launch unless one exists for the same repo and ref. `claimed: false` returns the
   * existing launch, whatever its status: the caller does nothing with a release it did not claim.
   */
  claim(launch: NewLaunch): { claimed: boolean; launch: Launch } {
    const inserted = this.#db
      .prepare(
        `INSERT INTO launches (repo, ref, trigger, kind, brand, status)
         VALUES (?, ?, ?, ?, ?, 'detected')
         ON CONFLICT (repo, ref) DO NOTHING`,
      )
      .run(launch.repo, launch.ref, launch.trigger, launch.kind, launch.brand);
    return { claimed: inserted.changes === 1, launch: this.find(launch.repo, launch.ref)! };
  }

  find(repo: string, ref: string): Launch | undefined {
    const row = this.#db.prepare('SELECT * FROM launches WHERE repo = ? AND ref = ?').get(repo, ref);
    return row ? toLaunch(row as unknown as LaunchRow) : undefined;
  }

  get(id: number): Launch | undefined {
    const row = this.#db.prepare('SELECT * FROM launches WHERE id = ?').get(id);
    return row ? toLaunch(row as unknown as LaunchRow) : undefined;
  }

  /** The newest launches first, for `shipcast status`. */
  recent(limit = 20): Launch[] {
    const rows = this.#db.prepare('SELECT * FROM launches ORDER BY created_at DESC, id DESC LIMIT ?').all(limit);
    return (rows as unknown as LaunchRow[]).map(toLaunch);
  }

  setStatus(id: number, status: LaunchStatus, detail: string | null = null): Launch {
    const result = this.#db
      .prepare(
        `UPDATE launches SET status = ?, detail = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
      .run(status, detail, id);
    if (result.changes !== 1) throw new Error(`no launch with id ${id}`);
    return this.get(id)!;
  }

  /**
   * The ref of the repo's last launch that reached its audience, to infer the next pack: a project
   * that never launched gets the `launch` pack, whatever its version number says.
   */
  lastPublishedRef(repo: string): string | undefined {
    const row = this.#db
      .prepare(
        `SELECT ref FROM launches WHERE repo = ? AND status = 'published'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(repo) as { ref: string } | undefined;
    return row?.ref;
  }

  /** One post per launch and channel: publishing the same piece twice is refused, not repeated. */
  recordPost(post: Omit<Post, 'publishedAt'>): { recorded: boolean } {
    const result = this.#db
      .prepare(
        `INSERT INTO posts (launch_id, channel, url, external_id) VALUES (?, ?, ?, ?)
         ON CONFLICT (launch_id, channel) DO NOTHING`,
      )
      .run(post.launchId, post.channel, post.url, post.externalId);
    return { recorded: result.changes === 1 };
  }

  posts(launchId: number): Post[] {
    const rows = this.#db
      .prepare('SELECT * FROM posts WHERE launch_id = ? ORDER BY published_at, channel')
      .all(launchId) as unknown as Array<{
      launch_id: number;
      channel: string;
      url: string | null;
      external_id: string | null;
      published_at: string;
    }>;
    return rows.map((r) => ({
      launchId: r.launch_id,
      channel: r.channel as Channel,
      url: r.url,
      externalId: r.external_id,
      publishedAt: r.published_at,
    }));
  }

  recordMetrics(launchId: number, source: string, values: Record<string, number>, takenAt: Date): void {
    const insert = this.#db.prepare('INSERT INTO metrics (launch_id, source, name, value, taken_at) VALUES (?, ?, ?, ?, ?)');
    const at = takenAt.toISOString();
    for (const [name, value] of Object.entries(values)) {
      if (Number.isFinite(value)) insert.run(launchId, source, name, value, at);
    }
  }

  /** The newest reading of every metric of a launch. */
  latestMetrics(launchId: number): MetricReading[] {
    const rows = this.#db
      .prepare(
        `SELECT m.launch_id, m.source, m.name, m.value, m.taken_at FROM metrics m
         JOIN (SELECT source, name, MAX(taken_at) AS at FROM metrics WHERE launch_id = ? GROUP BY source, name) last
           ON last.source = m.source AND last.name = m.name AND last.at = m.taken_at
         WHERE m.launch_id = ? ORDER BY m.source, m.name`,
      )
      .all(launchId, launchId) as unknown as Array<{ launch_id: number; source: string; name: string; value: number; taken_at: string }>;
    return rows.map((r) => ({ launchId: r.launch_id, source: r.source, name: r.name, value: r.value, takenAt: r.taken_at }));
  }

  /** Every reading of one metric of a launch, oldest first: its curve. */
  metricHistory(launchId: number, source: string, name: string): MetricReading[] {
    const rows = this.#db
      .prepare('SELECT launch_id, source, name, value, taken_at FROM metrics WHERE launch_id = ? AND source = ? AND name = ? ORDER BY taken_at')
      .all(launchId, source, name) as unknown as Array<{ launch_id: number; source: string; name: string; value: number; taken_at: string }>;
    return rows.map((r) => ({ launchId: r.launch_id, source: r.source, name: r.name, value: r.value, takenAt: r.taken_at }));
  }

  /** Small pieces of polling state, such as the ETag of the last events page. */
  cursor(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM cursors WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setCursor(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO cursors (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  /**
   * Gives a channel whose publishing failed for good another chance, once its cause is fixed: the
   * failure is forgotten and its launch goes back to `drafted`, so the next publish round tries that
   * channel again. Channels already posted stay posted; the registry never posts one twice.
   */
  retryChannel(channel: Channel): Launch[] {
    const keys = this.#db.prepare("SELECT key FROM cursors WHERE key LIKE 'publish-failed:%:' || ?").all(channel) as Array<{ key: string }>;
    const reopened: Launch[] = [];
    for (const { key } of keys) {
      const id = Number(key.split(':')[1]);
      this.#db.prepare('DELETE FROM cursors WHERE key = ?').run(key);
      const launch = this.get(id);
      if (launch && !this.posts(id).some((p) => p.channel === channel)) reopened.push(this.setStatus(id, 'drafted', launch.detail));
    }
    return reopened;
  }

  accounts(filter: { brand?: string; network?: string } = {}): Account[] {
    const rows = this.#db
      .prepare('SELECT * FROM accounts WHERE (?1 IS NULL OR brand = ?1) AND (?2 IS NULL OR network = ?2) ORDER BY network, brand, is_primary DESC, label')
      .all(filter.brand ?? null, filter.network ?? null) as unknown as AccountRow[];
    return rows.map(toAccount);
  }

  account(id: number): Account | undefined {
    const row = this.#db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);
    return row ? toAccount(row as unknown as AccountRow) : undefined;
  }

  /** The account a brand publishes with on a network, if it has one */
  primaryAccount(brand: string, network: string): Account | undefined {
    const row = this.#db.prepare('SELECT * FROM accounts WHERE brand = ? AND network = ? AND is_primary = 1').get(brand, network);
    return row ? toAccount(row as unknown as AccountRow) : undefined;
  }

  /** A new account; the first one of its network and brand becomes the primary */
  addAccount(account: { network: string; brand: string; label: string; settings: Record<string, string> }): Account {
    const first = this.accounts({ brand: account.brand, network: account.network }).length === 0;
    const result = this.#db
      .prepare('INSERT INTO accounts (network, brand, label, settings, is_primary) VALUES (?, ?, ?, ?, ?)')
      .run(account.network, account.brand, account.label, JSON.stringify(account.settings), first ? 1 : 0);
    return this.account(Number(result.lastInsertRowid))!;
  }

  updateAccount(id: number, change: { label?: string; settings?: Record<string, string> }): Account {
    const current = this.account(id);
    if (!current) throw new Error(`no account with id ${id}`);
    this.#db
      .prepare('UPDATE accounts SET label = ?, settings = ? WHERE id = ?')
      .run(change.label ?? current.label, JSON.stringify(change.settings ?? current.settings), id);
    return this.account(id)!;
  }

  recordCheck(id: number, check: { ok: true; account: string } | { ok: false; problem: string }, at = new Date()): Account {
    this.#db
      .prepare('UPDATE accounts SET status = ?, identity = ?, problem = ?, checked_at = ? WHERE id = ?')
      .run(check.ok ? 'ok' : 'failed', check.ok ? check.account : null, check.ok ? null : check.problem, at.toISOString(), id);
    return this.account(id)!;
  }

  /** Makes one account the one its brand publishes with on that network */
  makePrimary(id: number): Account {
    const account = this.account(id);
    if (!account) throw new Error(`no account with id ${id}`);
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('UPDATE accounts SET is_primary = 0 WHERE brand = ? AND network = ?').run(account.brand, account.network);
      this.#db.prepare('UPDATE accounts SET is_primary = 1 WHERE id = ?').run(id);
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
    return this.account(id)!;
  }

  /** Removes an account; when it was the primary, the next one of its network and brand takes over */
  deleteAccount(id: number): void {
    const account = this.account(id);
    if (!account) return;
    this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    if (account.primary) {
      const next = this.accounts({ brand: account.brand, network: account.network })[0];
      if (next) this.makePrimary(next.id);
    }
  }

  close(): void {
    this.#db.close();
  }
}
