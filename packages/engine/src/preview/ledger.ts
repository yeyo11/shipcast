import { sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { RawQueries } from '../repositories/sql.ts';

/*
 * The fake networks' own record, on a preview with fake networks: every post, edit, delete, notice,
 * reply and sign-in a fake network answered, written by the fake itself and not by the publishing
 * code, so a test compares what the networks "received" with what the registry says went out. Its
 * table lives only in a preview's database: it is made here on first use, never by a migration, so
 * production's schema never carries it.
 */

export type FakeAction = 'publish' | 'edit' | 'delete' | 'notify' | 'reply' | 'connect' | 'profile';

export interface FakeNetworkEntry {
  channel: string;
  action: FakeAction;
  /** The piece's kind as the registry names it (`post`, `story`, `issue:en`, `post:short`, `post:<subreddit>`) */
  kind: string;
  externalId: string | null;
  /** The scale test's marker found in what was sent (`[scale <run> <n>]`), when there is one */
  marker: string | null;
  /** What was sent, as JSON without bytes, cut to DETAIL_MAX characters */
  detail: string;
}

export interface FakeNetworkRecord extends FakeNetworkEntry {
  id: number;
  at: string;
  /** The process that answered, as SHIPCAST_ROLE and the host name say it */
  process: string;
}

export interface FakeNetworkLedger {
  record(entry: FakeNetworkEntry): Promise<void>;
  /**
   * The first entry of a channel's kind whose detail holds `text`: how a fake network answers the
   * question its real one answers (Mastodon's idempotency key, Reddit's search for a lost submission)
   */
  find(channel: string, kind: string, text: string): Promise<FakeNetworkRecord | undefined>;
}

export const LEDGER_TABLE = 'preview_fake_network';
export const DETAIL_MAX = 2000;

/** The scale test's marker: which run, which of its launches */
const MARKER = /\[scale [a-z0-9-]+ \d+\]/;

/** The marker a text carries, if any */
export function markerIn(text: string): string | null {
  return MARKER.exec(text)?.[0] ?? null;
}

/** What was sent, as JSON with bytes as their length; the marker is read from the whole of it, then it is cut */
export function describeSent(payload: unknown): { detail: string; marker: string | null } {
  const json = JSON.stringify(payload ?? null, (_key, value: unknown) => (value instanceof Uint8Array ? `<${value.byteLength} bytes>` : value)) ?? 'null';
  return { detail: json.slice(0, DETAIL_MAX), marker: markerIn(json) };
}

type Row = { id: number | string; at: string | Date; process: string; channel: string; action: string; kind: string; external_id: string | null; marker: string | null; detail: string };

const toRecord = (r: Row): FakeNetworkRecord => ({
  id: Number(r.id),
  at: new Date(r.at).toISOString(),
  process: r.process,
  channel: r.channel,
  action: r.action as FakeAction,
  kind: r.kind,
  externalId: r.external_id,
  marker: r.marker,
  detail: r.detail,
});

/** The record in the preview's own Postgres, shared by every replica of the preview */
export class PostgresFakeNetworkLedger implements FakeNetworkLedger {
  readonly #db: Database;
  readonly #raw: RawQueries;
  readonly #process: string;
  #ready: Promise<void> | undefined;

  constructor(db: Database, process: string) {
    this.#db = db;
    this.#raw = new RawQueries(db);
    this.#process = process;
  }

  /** Makes the table once per process; replicas starting together may race, and the loser finds it made */
  ensure(): Promise<void> {
    this.#ready ??= this.#create().catch((error: unknown) => {
      this.#ready = undefined;
      throw error;
    });
    return this.#ready;
  }

  async #create(): Promise<void> {
    try {
      await this.#db.execute(
        sql.raw(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
          id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          at timestamptz NOT NULL DEFAULT now(),
          process text NOT NULL,
          channel text NOT NULL,
          action text NOT NULL,
          kind text NOT NULL,
          external_id text,
          marker text,
          detail text NOT NULL
        )`),
      );
      await this.#db.execute(sql.raw(`CREATE INDEX IF NOT EXISTS ${LEDGER_TABLE}_by_marker ON ${LEDGER_TABLE} (marker)`));
    } catch (error) {
      // Two processes creating it at once: one of them gets a duplicate-type error, and the table is there
      const made = await this.#raw.selectRows<{ made: string | null }>(sql`SELECT to_regclass(${LEDGER_TABLE})::text AS made`);
      if (!made[0]?.made) throw error;
    }
  }

  async record(entry: FakeNetworkEntry): Promise<void> {
    await this.ensure();
    await this.#db.execute(
      sql`INSERT INTO ${sql.raw(LEDGER_TABLE)} (process, channel, action, kind, external_id, marker, detail)
          VALUES (${this.#process}, ${entry.channel}, ${entry.action}, ${entry.kind}, ${entry.externalId}, ${entry.marker}, ${entry.detail})`,
    );
  }

  async find(channel: string, kind: string, text: string): Promise<FakeNetworkRecord | undefined> {
    await this.ensure();
    const rows = await this.#raw.selectRows<Row>(
      sql`SELECT * FROM ${sql.raw(LEDGER_TABLE)} WHERE channel = ${channel} AND kind = ${kind} AND action = 'publish' AND strpos(detail, ${text}) > 0 ORDER BY id LIMIT 1`,
    );
    return rows[0] && toRecord(rows[0]);
  }

  /** Every entry, oldest first; from `since` (ISO 8601) when given */
  async entries(since?: string): Promise<FakeNetworkRecord[]> {
    await this.ensure();
    const rows = await this.#raw.selectRows<Row>(
      since === undefined ? sql`SELECT * FROM ${sql.raw(LEDGER_TABLE)} ORDER BY id` : sql`SELECT * FROM ${sql.raw(LEDGER_TABLE)} WHERE at >= ${since}::timestamptz ORDER BY id`,
    );
    return rows.map(toRecord);
  }
}

/** The record in memory, for tests and for a preview without a database to keep it in */
export class MemoryFakeNetworkLedger implements FakeNetworkLedger {
  readonly entries: FakeNetworkRecord[] = [];
  readonly #process: string;

  constructor(process = 'test') {
    this.#process = process;
  }

  async record(entry: FakeNetworkEntry): Promise<void> {
    this.entries.push({ ...entry, id: this.entries.length + 1, at: new Date().toISOString(), process: this.#process });
  }

  async find(channel: string, kind: string, text: string): Promise<FakeNetworkRecord | undefined> {
    return this.entries.find((e) => e.channel === channel && e.kind === kind && e.action === 'publish' && e.detail.includes(text));
  }
}
