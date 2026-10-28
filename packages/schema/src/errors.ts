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

/**
 * A request that is wrong as it was sent: a field out of its range, a setting with a bad value, a
 * period backwards. Nothing about the state of things; the same request is refused every time (400).
 */
export class InvalidRequest extends ShipcastError {
  constructor(message: string) {
    super(message, { code: 'invalid', httpStatus: 400 });
  }
}

/** The HTTP status an error answers with: its own for a Shipcast error, 500 for anything else */
export function httpStatusOf(error: unknown): number {
  return error instanceof ShipcastError ? error.httpStatus : 500;
}

/**
 * Why an AI call gave no usable answer. `ai_not_connected`: a setting or key is missing or refused,
 * which only the owner fixes (reconnect the provider); `ai_rate_limited` and `ai_unavailable`: the
 * provider's state, worth the job queue's retry; `ai_refused`: the request as sent (a 4xx), refused
 * every time; `ai_timeout` and `ai_aborted`: the run's own deadline or its caller's; `ai_invalid_output`
 * and `ai_no_answer`: the model answered, but not with what the task asked, even after its repair.
 */
export type AiErrorCode =
  | 'ai_not_connected'
  | 'ai_rate_limited'
  | 'ai_unavailable'
  | 'ai_refused'
  | 'ai_timeout'
  | 'ai_aborted'
  | 'ai_invalid_output'
  | 'ai_no_answer';

const AI_ERRORS: Record<AiErrorCode, { retryable: boolean; httpStatus: number }> = {
  ai_not_connected: { retryable: false, httpStatus: 409 },
  ai_rate_limited: { retryable: true, httpStatus: 503 },
  ai_unavailable: { retryable: true, httpStatus: 502 },
  ai_refused: { retryable: false, httpStatus: 502 },
  // A run that ran out of time may finish on the next try, when the provider is less loaded
  ai_timeout: { retryable: true, httpStatus: 504 },
  ai_aborted: { retryable: false, httpStatus: 499 },
  ai_invalid_output: { retryable: false, httpStatus: 502 },
  ai_no_answer: { retryable: false, httpStatus: 502 },
};

/** Every failure of the AI layer, whichever provider: the code says what to do about it */
export class AiError extends ShipcastError {
  declare readonly code: AiErrorCode;
  /** The provider's id, when the failure is one provider's */
  readonly provider: string | undefined;

  constructor(code: AiErrorCode, message: string, options: { provider?: string; cause?: unknown } = {}) {
    super(message, { code, ...AI_ERRORS[code], cause: options.cause });
    this.name = 'AiError';
    this.provider = options.provider;
  }
}
