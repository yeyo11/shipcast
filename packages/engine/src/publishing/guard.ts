import { DEFAULT_LEASE_MS, type Attempt, type Piece, type PublishAttempts } from './attempts.ts';

/** Whether trying again could help: an error says so itself (`retryable`), and anything else is assumed temporary */
export function isRetryable(error: unknown): boolean {
  return !(error instanceof Error && 'retryable' in error) || (error as { retryable: boolean }).retryable;
}

export type Guarded<T> = { ran: true; value: T } | { ran: false; attempt: Attempt };

/**
 * One worker's way to the network for a launch's pieces: each piece is claimed before its call and
 * closed after it, so the same piece is never sent by two workers, and a call whose outcome was lost
 * is never repeated where the network cannot recognise it.
 */
export class PieceGuard {
  readonly #attempts: PublishAttempts;
  readonly #holder: string;
  readonly #leaseMs: number;

  constructor(attempts: PublishAttempts, holder: string, leaseMs = DEFAULT_LEASE_MS) {
    this.#attempts = attempts;
    this.#holder = holder;
    this.#leaseMs = leaseMs;
  }

  /**
   * Runs `send` for a piece if this worker can claim it; its result's `externalId` and `url` are kept
   * on the attempt. A failure is recorded (retryable or not) and thrown on, as if unguarded.
   */
  async run<T extends { externalId?: string | null; url?: string | null } | undefined>(piece: Piece, options: { idempotent: boolean }, send: () => Promise<T>): Promise<Guarded<T>> {
    const claim = await this.#attempts.claim(piece, { holder: this.#holder, leaseMs: this.#leaseMs, idempotent: options.idempotent });
    if (!claim.claimed) return { ran: false, attempt: claim.attempt };
    let value: T;
    try {
      value = await send();
    } catch (error) {
      await this.#attempts.fail(piece, this.#holder, { error: error instanceof Error ? error.message : String(error), retryable: isRetryable(error) });
      throw error;
    }
    await this.#attempts.succeed(piece, this.#holder, { externalId: value?.externalId ?? null, url: value?.url ?? null });
    return { ran: true, value };
  }
}

/** Why a piece was not sent by this worker, in words for the job's log */
export function notSentBecause(attempt: Attempt): string {
  switch (attempt.state) {
    case 'attempting':
      return `another worker (${attempt.holder ?? 'unknown'}) is sending it now`;
    case 'live':
      return 'it is out already';
    case 'unknown':
      return 'a worker stopped while sending it and the network cannot say whether it went out: check the channel, then Try again';
    default:
      return `its last attempt ${attempt.state === 'failed' ? 'failed' : 'will be retried'}`;
  }
}
