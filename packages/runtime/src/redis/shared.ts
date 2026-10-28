import type { BucketSpec, Lock, LockOptions, LockResult, TakeResult } from './ports.ts';

/*
 * What the Redis adapters and the in-memory ones share, so the two cannot drift: the lock's renewal
 * loop and the token bucket's arithmetic (the Redis one runs the same steps in Lua).
 */

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** GitHub lets a delivery be redelivered for three days: past that no repeat can come */
export const DELIVERY_TTL_SECONDS = 3 * 24 * 3600;

/** The default prefix of every key Shipcast writes, so a shared Redis can tell them apart */
export const DEFAULT_PREFIX = 'shipcast:';

/**
 * The body of `Lock.withLock` over any `acquire`. Renewal every third of the TTL leaves two chances
 * to renew before expiry; a holder that cannot reach Redis for a whole TTL can no longer claim the
 * lock is still its own, so its signal aborts then rather than at the first failed renewal.
 */
export async function runWithLock<T>(acquire: Lock['acquire'], key: string, fn: (signal: AbortSignal) => Promise<T>, options: LockOptions): Promise<LockResult<T>> {
  const { ttlMs, waitMs = 0, retryMs = 50 } = options;
  const deadline = Date.now() + waitMs;
  let handle = await acquire(key, ttlMs);
  while (!handle && Date.now() < deadline) {
    await sleep(Math.max(1, Math.min(retryMs, deadline - Date.now())));
    handle = await acquire(key, ttlMs);
  }
  if (!handle) return { acquired: false };
  const held = handle;
  const controller = new AbortController();
  let renewedAt = Date.now();
  const renew = setInterval(
    () => {
      held.extend(ttlMs).then(
        (ok) => {
          if (ok) renewedAt = Date.now();
          else controller.abort(new Error(`the lock ${key} was lost`));
        },
        () => {
          if (Date.now() - renewedAt >= ttlMs) controller.abort(new Error(`the lock ${key} could not be renewed`));
        },
      );
    },
    Math.max(5, Math.floor(ttlMs / 3)),
  );
  try {
    return { acquired: true, value: await fn(controller.signal) };
  } finally {
    clearInterval(renew);
    // A release that fails leaves the lock to expire: the next holder waits at most one TTL
    await held.release().catch(() => false);
  }
}

/** A bucket's stored state: tokens at a moment, and a provider's own "nothing until" */
export interface BucketState {
  tokens: number;
  at: number;
  until: number;
}

/** One take at `now`, with the refill since the last; the new state and the answer */
export function takeFrom(spec: BucketSpec, state: BucketState | undefined, cost: number, now: number): { state: BucketState; result: TakeResult } {
  const until = state?.until ?? 0;
  let tokens = Math.min(spec.capacity, (state?.tokens ?? spec.capacity) + ((now - (state?.at ?? now)) / 1000) * spec.refillPerSecond);
  let ok = false;
  let waitMs = 0;
  if (now < until) waitMs = until - now;
  else if (tokens >= cost) {
    tokens -= cost;
    ok = true;
  } else waitMs = Math.ceil(((cost - tokens) / spec.refillPerSecond) * 1000);
  return { state: { tokens, at: now, until }, result: { ok, remaining: tokens, waitMs } };
}

/** What a provider reported: never more tokens than it says remain, and none until its reset when it says none */
export function observeInto(spec: BucketSpec, state: BucketState | undefined, quota: { remaining: number; resetAt?: Date }, now: number): BucketState {
  const { state: refilled } = takeFrom(spec, state, 0, now);
  const tokens = Math.max(0, Math.min(refilled.tokens, quota.remaining));
  const until = quota.remaining <= 0 && quota.resetAt ? Math.max(refilled.until, quota.resetAt.getTime()) : refilled.until;
  return { tokens, at: now, until };
}

export function checkSpec(provider: string, spec: BucketSpec | undefined): BucketSpec {
  if (!spec) throw new Error(`no token bucket for ${provider}`);
  if (!(spec.capacity > 0) || !(spec.refillPerSecond > 0)) throw new Error(`the token bucket of ${provider} needs a capacity and a refill above 0`);
  return spec;
}

/** `acquire` over any `take`: sleeps for the wait the bucket names, never past the caller's limit */
export async function acquireFrom(take: (cost: number) => Promise<TakeResult>, options: { cost?: number; maxWaitMs?: number; signal?: AbortSignal }): Promise<boolean> {
  const cost = options.cost ?? 1;
  const deadline = Date.now() + (options.maxWaitMs ?? 60_000);
  for (;;) {
    const result = await take(cost);
    if (result.ok) return true;
    const left = deadline - Date.now();
    if (result.waitMs > left) return false;
    await sleep(Math.max(1, result.waitMs), options.signal);
  }
}

/** The window an expiring counter describes */
export const windowOf = (count: number, limit: number, ttlMs: number) => ({ count, limited: count >= limit, resetInSeconds: ttlMs > 0 ? Math.ceil(ttlMs / 1000) : 0 });
