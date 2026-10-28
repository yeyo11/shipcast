import { httpStatusOf, ShipcastError } from '@shipcast/schema';
import { InvalidInput } from './input.ts';

/*
 * The one mapping from an error to what a caller is answered, for the REST API (api.ts and the
 * routes it spreads in) and the server functions alike. The engine's errors say their own status
 * (ShipcastError.httpStatus: a refusal's reason, a network's 502, a bad request's 400), so no
 * entry point lists the classes of an area: a new refusal answers right everywhere the day it is
 * thrown. Anything that is not a Shipcast error, or one that only knows it is ours (500), is a bug
 * whose words stay in the log.
 */

export type ErrorCode =
  | 'unauthorized'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_input'
  | 'unsupported_media_type'
  | 'refused'
  | 'upstream'
  | 'internal';

/** An answer the API gives as it is: its status, code, message and headers */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;

  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** The statuses a Shipcast error can carry to a caller, each with the API's code for it */
const CODES: Readonly<Record<number, ErrorCode>> = { 400: 'invalid_input', 404: 'not_found', 409: 'refused', 502: 'upstream' };

export const INTERNAL_MESSAGE = 'something went wrong; the details are in the app’s log';

/**
 * The answer an error is given: an ApiError as it is, a Shipcast error with its own status and
 * words, anything else a 500 that says nothing of it (`internal` true: the caller logs it).
 */
export function apiErrorOf(error: unknown): ApiError & { internal?: true } {
  if (error instanceof ApiError) return error;
  const status = httpStatusOf(error);
  const code = CODES[status];
  if (error instanceof ShipcastError && code) return new ApiError(status, code, error.message);
  return Object.assign(new ApiError(500, 'internal', INTERNAL_MESSAGE), { internal: true as const });
}

/** The API's error body, `{ error: { code, message } }` */
export const errorBody = (error: ApiError) => ({ error: { code: error.code, message: error.message } });

/**
 * For a server function: what the owner can act on (anything the mapping answers below 500, or a
 * network's refusal) comes back to the page as an InvalidInput with its words; a bug is thrown as
 * it was, for the server's log.
 */
export async function forOwner<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    const answer = apiErrorOf(error);
    if (answer.internal) throw error;
    throw new InvalidInput(answer.message);
  }
}

/**
 * Why something was not done, for an answer given as data rather than thrown (the launch page's
 * actions): a Shipcast error's own code (a refusal's reason, `invalid`, `upstream`), `failed` for
 * anything else.
 */
export function reasonOf(error: unknown): string {
  return error instanceof ShipcastError && !apiErrorOf(error).internal ? error.code : 'failed';
}
