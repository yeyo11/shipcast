import { AiError } from '@shipcast/schema';
import { APICallError, RetryError } from 'ai';

/** What turning a failure into an AiError needs to know about the run */
export interface FailureContext {
  provider: { id: string; name: string };
  /** Every secret of the provider's settings: none may reach a message, whatever the server echoed */
  secrets: readonly string[];
  /** Whether the run's own deadline fired, and after how long */
  timedOut?: { ms: number };
  /** Whether the caller gave up */
  aborted?: boolean;
}

/** A message with every secret taken out */
export function redact(message: string, secrets: readonly string[]): string {
  let out = message;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('***');
  return out;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/**
 * Any failure of a model call as an AiError. A provider's HTTP answer says what it is: 401 and 403 are
 * credentials only the owner can fix, 429 and 5xx are the provider's state and worth the job queue's
 * retry, another 4xx is the request and fails the same way every time. An error that is not the
 * provider's (a bug) is returned as it was, so it is never retried as if it were the network.
 */
export function toAiError(error: unknown, context: FailureContext): unknown {
  if (error instanceof AiError) return error;
  const { provider, secrets } = context;
  const options = { provider: provider.id, cause: error };
  if (context.timedOut) return new AiError('ai_timeout', `the ${provider.name} did not answer within ${minutes(context.timedOut.ms)}`, options);
  if (context.aborted) return new AiError('ai_aborted', `the ${provider.name} call was cancelled`, options);
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode;
    const said = redact(cause.message, secrets).slice(0, 500);
    if (status === 401 || status === 403) return new AiError('ai_not_connected', `the ${provider.name} refused its credentials (${status}): reconnect the AI provider`, options);
    if (status === 429) return new AiError('ai_rate_limited', `the ${provider.name} is rate limiting (429): ${said}`, options);
    if (status === undefined || status === 408 || status >= 500) return new AiError('ai_unavailable', `the ${provider.name} is unavailable${status ? ` (${status})` : ''}: ${said}`, options);
    return new AiError('ai_refused', `the ${provider.name} refused the request (${status}): ${said}`, options);
  }
  // fetch's own failure: the server could not be reached at all
  if (cause instanceof TypeError && /fetch|network|ECONNREFUSED|ENOTFOUND/i.test(`${cause.message} ${String(cause.cause ?? '')}`)) {
    return new AiError('ai_unavailable', `the ${provider.name} could not be reached: ${redact(cause.message, secrets)}`, options);
  }
  return error;
}
