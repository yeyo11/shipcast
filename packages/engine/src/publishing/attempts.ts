import { and, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { nowIso, publishAttempts } from '../db/schema.ts';

/** One piece of a launch: what a posts row holds once it is out */
export interface Piece {
  launchId: number;
  channel: string;
  kind: string;
}

export type AttemptState = 'attempting' | 'live' | 'retryable' | 'failed' | 'unknown';

export interface Attempt extends Piece {
  state: AttemptState;
  attempts: number;
  leaseUntil: string | null;
  holder: string | null;
  error: string | null;
  externalId: string | null;
  url: string | null;
  startedAt: string;
  updatedAt: string;
}

export type Claim =
  | { claimed: true; attempt: Attempt }
  /** Someone else holds it, it is out already, or its last attempt's outcome is not known */
  | { claimed: false; attempt: Attempt };

export interface ClaimOptions {
  /** Who claims it (a job's id), shown on the row */
  holder: string;
  /** How long the claim is the holder's; a worker that dies leaves it to expire */
  leaseMs?: number;
  /**
   * Whether calling the network again after a call whose answer was lost is safe: the network takes
   * an idempotency key (Mastodon), a record key it refuses twice (Bluesky), or Shipcast looks for the
   * piece before sending it again (Reddit). False for the rest: a stale claim becomes `unknown`.
   */
  idempotent: boolean;
  /**
   * Whether a piece that went out may be claimed again: for a channel's whole run (the newsletter's
   * languages, Reddit's subreddits), which the caller re-checks after claiming, never for one piece
   */
  reclaimLive?: boolean;
  now?: Date;
}

/** Long enough for the slowest piece (an Instagram carousel waits for its containers), short enough that a crash is noticed the same hour */
export const DEFAULT_LEASE_MS = 20 * 60_000;

const toAttempt = (row: typeof publishAttempts.$inferSelect): Attempt => ({ ...row, state: row.state as AttemptState });

/**
 * The publish attempts of each piece (the outbox of docs/plans/performance-refactor.md, phase 2): a
 * worker claims a piece before it calls the network, in one statement, so of two workers that reach
 * it at once exactly one gets it. The claim is a lease: the holder marks the piece live or failed,
 * and a holder that died leaves a lease in the past, which a later worker takes over only where the
 * network makes a second call safe.
 */
export class PublishAttempts {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Claims a piece for one attempt. A piece never tried, or whose last attempt failed, is claimed; one
   * held by a live lease, or live, is not; one whose lease expired is claimed again if the network is
   * idempotent, and otherwise becomes `unknown`: the owner looks before it goes out again.
   */
  async claim(piece: Piece, options: ClaimOptions): Promise<Claim> {
    const now = options.now ?? new Date();
    const lease = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
    const nowText = now.toISOString();
    const takeable = or(
      inArray(publishAttempts.state, options.reclaimLive ? ['retryable', 'failed', 'live'] : ['retryable', 'failed']),
      options.idempotent ? and(eq(publishAttempts.state, 'attempting'), lt(publishAttempts.leaseUntil, nowText)) : sql`false`,
    );
    const [claimed] = await this.#db
      .insert(publishAttempts)
      .values({ ...piece, state: 'attempting', attempts: 1, leaseUntil: lease, holder: options.holder })
      .onConflictDoUpdate({
        target: [publishAttempts.launchId, publishAttempts.channel, publishAttempts.kind],
        set: { state: 'attempting', attempts: sql`${publishAttempts.attempts} + 1`, leaseUntil: lease, holder: options.holder, error: null, updatedAt: nowIso },
        setWhere: takeable,
      })
      .returning();
    if (claimed) return { claimed: true, attempt: toAttempt(claimed) };

    // Not ours: a stale claim on a network that cannot be asked again becomes unknown, once
    if (!options.idempotent) {
      await this.#db
        .update(publishAttempts)
        .set({ state: 'unknown', leaseUntil: null, error: 'the worker publishing it stopped before it said whether the piece went out', updatedAt: nowIso })
        .where(and(this.#is(piece), eq(publishAttempts.state, 'attempting'), lt(publishAttempts.leaseUntil, nowText)));
    }
    return { claimed: false, attempt: (await this.get(piece))! };
  }

  /** The piece went out: only its holder's claim is closed, so a late answer never overwrites another's */
  async succeed(piece: Piece, holder: string, result: { externalId?: string | null; url?: string | null } = {}): Promise<void> {
    await this.#db
      .update(publishAttempts)
      .set({ state: 'live', leaseUntil: null, error: null, externalId: result.externalId ?? null, url: result.url ?? null, updatedAt: nowIso })
      .where(and(this.#is(piece), eq(publishAttempts.holder, holder), ne(publishAttempts.state, 'live')));
  }

  /** The attempt failed: retryable is tried by the next run, failed waits for the owner's Try again */
  async fail(piece: Piece, holder: string, failure: { error: string; retryable: boolean }): Promise<void> {
    await this.#db
      .update(publishAttempts)
      .set({ state: failure.retryable ? 'retryable' : 'failed', leaseUntil: null, error: failure.error.slice(0, 2000), updatedAt: nowIso })
      .where(and(this.#is(piece), eq(publishAttempts.holder, holder), eq(publishAttempts.state, 'attempting')));
  }

  /** The owner's Try again on a channel: what failed or is unknown may be attempted again; what is live stays */
  async reset(launchId: number, channel: string): Promise<number> {
    const rows = await this.#db
      .delete(publishAttempts)
      .where(and(eq(publishAttempts.launchId, launchId), eq(publishAttempts.channel, channel), ne(publishAttempts.state, 'live'), ne(publishAttempts.state, 'attempting')))
      .returning();
    return rows.length;
  }

  async get(piece: Piece): Promise<Attempt | undefined> {
    const [row] = await this.#db.select().from(publishAttempts).where(this.#is(piece));
    return row ? toAttempt(row) : undefined;
  }

  async ofLaunch(launchId: number): Promise<Attempt[]> {
    return (await this.#db.select().from(publishAttempts).where(eq(publishAttempts.launchId, launchId))).map(toAttempt);
  }

  /** Every piece in a state, for the correctness check and the attention list */
  async inState(state: AttemptState): Promise<Attempt[]> {
    return (await this.#db.select().from(publishAttempts).where(eq(publishAttempts.state, state))).map(toAttempt);
  }

  #is(piece: Piece) {
    return and(eq(publishAttempts.launchId, piece.launchId), eq(publishAttempts.channel, piece.channel), eq(publishAttempts.kind, piece.kind));
  }
}
