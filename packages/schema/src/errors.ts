/** What a Shipcast error says about itself besides its message */
export interface ShipcastErrorOptions {
  /** A stable, machine-readable name for the failure (`not_found`, `upstream`…); `internal` by default */
  code?: string;
  /** Whether the same call could succeed later as it is; false by default */
  retryable?: boolean;
  /** The status an HTTP answer gives it; 500 by default */
  httpStatus?: number;
  cause?: unknown;
}

/**
 * The base of Shipcast's own errors, so one place can answer any of them: a job by whether to try
 * again, the API and the pages by their HTTP status. `retryable` and `httpStatus` are getters so a
 * subclass can derive them (a connector's from the network's status). The name is left as each
 * class set it: messages and logs read as they did before the base existed.
 */
export class ShipcastError extends Error {
  readonly code: string;
  readonly #retryable: boolean;
  readonly #httpStatus: number;

  constructor(message: string, options: ShipcastErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? 'internal';
    this.#retryable = options.retryable ?? false;
    this.#httpStatus = options.httpStatus ?? 500;
  }

  get retryable(): boolean {
    return this.#retryable;
  }

  get httpStatus(): number {
    return this.#httpStatus;
  }
}

/** The status a refusal's reason answers with: the client's problem, or a state that does not allow it (409) */
const REFUSAL_STATUS: Record<string, number> = { not_found: 404, invalid: 400 };

/**
 * Why the engine did not do what it was asked: a reason the caller answers by (404, 400, 409) and the
 * words for the owner. Each kind of request has its own subclass, which is what callers tell apart
 * with instanceof; the reason is the code.
 */
export class Refused<R extends string = string> extends ShipcastError {
  readonly reason: R;

  constructor(reason: R, message: string) {
    super(message, { code: reason, httpStatus: REFUSAL_STATUS[reason] ?? 409 });
    this.reason = reason;
  }
}

/** The HTTP status an error answers with: its own for a Shipcast error, 500 for anything else */
export function httpStatusOf(error: unknown): number {
  return error instanceof ShipcastError ? error.httpStatus : 500;
}
