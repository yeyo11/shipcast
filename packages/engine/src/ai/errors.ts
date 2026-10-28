import { AiError, type AiErrorCode } from '@shipcast/schema';
import { APICallError, RetryError } from 'ai';

/**
 * What a provider's own error codes mean, by the code its error body carries (`error.code` of an
 * OpenAI-shaped body): one table per provider, declared by its module, so a provider whose codes
 * change is fixed in one place. `message` finishes "the <provider> …".
 */
export type AiErrorTable = Readonly<Record<string, { code: AiErrorCode; message: string }>>;

/** What turning a failure into an AiError needs to know about the run */
export interface FailureContext {
  provider: { id: string; name: string; errors?: AiErrorTable };
  /** Every secret of the provider's settings: none may reach a message, whatever the server echoed */
  secrets: readonly string[];
  /** Whether the run's own deadline fired, and after how long */
  timedOut?: { ms: number };
  /** Whether the caller gave up */
  aborted?: boolean;
}

/** A provider's failed HTTP answer, whoever read it: the AI SDK (APICallError) or a provider's own adapter */
export interface HttpFailure {
  /** None when no answer came */
  status: number | undefined;
  /** The answer's body as text, or a message when there was no body */
  body: string;
  /** Lower-cased names, as the SDK keeps them */
  headers?: Readonly<Record<string, string | undefined>>;
}

/** A message with every secret taken out */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***');
  return out;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The code and message of an error body: OpenAI's `{ error: { code, message } }`, the inner object
 * alone (an error chunk of a stream), or a flat `{ code | error: string, message }`.
 */
export function errorBodyOf(body: unknown): { code?: string; message?: string } {
  const parsed = typeof body === 'string' ? safeJson(body) : body;
  if (!isRecord(parsed)) return {};
  const inner = isRecord(parsed.error) ? parsed.error : parsed;
  const code = typeof inner.code === 'string' ? inner.code : typeof parsed.error === 'string' ? parsed.error : undefined;
  const message = typeof inner.message === 'string' ? inner.message : undefined;
  return { ...(code !== undefined && { code }), ...(message !== undefined && { message }) };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `Retry-After` in milliseconds: seconds or an HTTP date */
function retryAfterOf(headers: HttpFailure['headers']): number | undefined {
  const value = headers?.['retry-after']?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * A provider's failed answer as an AiError. A code of the provider's table says what it is; else the
 * status does: 401 and 403 are credentials only the owner can fix, 429 and 5xx are the provider's
 * state and worth the job queue's retry, another 4xx is the request and fails the same way every time.
 */
export function fromHttpFailure(failure: HttpFailure, context: Pick<FailureContext, 'provider' | 'secrets'>, cause?: unknown): AiError {
  const { provider, secrets } = context;
  const { code, message } = errorBodyOf(failure.body);
  const said = redact(message ?? failure.body, secrets).slice(0, 500);
  const retryAfterMs = retryAfterOf(failure.headers);
  const options = { provider: provider.id, cause, ...(retryAfterMs !== undefined && { retryAfterMs }) };
  const status = failure.status;
  const known = code === undefined ? undefined : provider.errors?.[code];
  if (known) return new AiError(known.code, `the ${provider.name} ${known.message} (${code}${status ? `, ${status}` : ''})${said ? `: ${said}` : ''}`, options);
  if (status === 401 || status === 403) return new AiError('ai_not_connected', `the ${provider.name} refused its credentials (${status}): reconnect the AI provider`, options);
  if (status === 429) return new AiError('ai_rate_limited', `the ${provider.name} is rate limiting (429): ${said}`, options);
  if (status === undefined || status === 408 || status >= 500) return new AiError('ai_unavailable', `the ${provider.name} is unavailable${status ? ` (${status})` : ''}: ${said}`, options);
  return new AiError('ai_refused', `the ${provider.name} refused the request (${status}): ${said}`, options);
}

/**
 * Any failure of a model call as an AiError. An error that is not the provider's (a bug) is returned
 * as it was, so it is never retried as if it were the network.
 */
export function toAiError(error: unknown, context: FailureContext): unknown {
  if (error instanceof AiError) return error;
  const { provider, secrets } = context;
  const options = { provider: provider.id, cause: error };
  if (context.timedOut) return new AiError('ai_timeout', `the ${provider.name} did not answer within ${minutes(context.timedOut.ms)}`, options);
  if (context.aborted) return new AiError('ai_aborted', `the ${provider.name} call was cancelled`, options);
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) {
    return fromHttpFailure({ status: cause.statusCode, body: cause.responseBody ?? cause.message, ...(cause.responseHeaders && { headers: cause.responseHeaders }) }, context, error);
  }
  // fetch's own failure: the server could not be reached at all
  if (cause instanceof TypeError && /fetch|network|ECONNREFUSED|ENOTFOUND/i.test(`${cause.message} ${String(cause.cause ?? '')}`)) {
    return new AiError('ai_unavailable', `the ${provider.name} could not be reached: ${redact(cause.message, secrets)}`, options);
  }
  // An error chunk in the middle of a stream: the SDK passes the provider's error object as it came,
  // with no status, so its code is all there is to go by
  if (isRecord(cause) && !(cause instanceof Error) && errorBodyOf(cause).message !== undefined) {
    return fromHttpFailure({ status: undefined, body: JSON.stringify(cause) }, context, error);
  }
  return error;
}
