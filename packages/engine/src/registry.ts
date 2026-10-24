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
];

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

  close(): void {
    this.#db.close();
  }
}
