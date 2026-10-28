import type { Flags } from '../flags.ts';
import { RedisCache, RedisDeliveryDedupe, RedisEventBus, RedisLock, RedisOneTimeStore, RedisTokenBucket, RedisWindowLimiter } from './adapters.ts';
import type { RedisConnections } from './connection.ts';
import { MemoryCache, MemoryDeliveryDedupe, MemoryEventBus, MemoryLock, MemoryOneTimeStore, MemoryTokenBucket, MemoryWindowLimiter } from './memory.ts';
import type { BucketSpec, Cache, DeliveryDedupe, EventBus, Lock, OneTimeStore, TokenBucket, WindowLimiter } from './ports.ts';

/** The shared ephemeral state of one process, every port built once */
export interface SharedState {
  /** On redis-cache: evictable */
  cache: Cache;
  /** On redis-cache: pub/sub stores nothing, so it needs no persistence */
  events: EventBus;
  /** On redis-queue, as everything below: their loss inside a TTL would be wrong, not just slow */
  lock: Lock;
  oneTime: OneTimeStore;
  /** The API's failed sign-ins per client: ten in ten minutes, as the in-memory FailureLimiter */
  signInFailures: WindowLimiter;
  buckets: TokenBucket;
  deliveries: DeliveryDedupe;
  /** Whether it is Redis's, for the health answer */
  backend: 'redis' | 'memory';
}

export interface SharedStateOptions {
  prefix?: string;
  buckets?: Record<string, BucketSpec>;
  signIn?: { limit: number; windowSeconds: number };
  onError?: (error: unknown) => void;
}

const SIGN_IN = { limit: 10, windowSeconds: 600 };

/**
 * Builds the state from the flags: with `redis-state` on, on the two Redis instances (it is an error
 * to turn it on without SHIPCAST_REDIS_QUEUE_URL); off, in this process's memory, as a single
 * install without Redis runs. Not called by the app yet: it is wired behind the flag.
 */
export function sharedState(flags: Flags, connections: RedisConnections | undefined, options: SharedStateOptions = {}): SharedState {
  const signIn = options.signIn ?? SIGN_IN;
  const buckets = options.buckets ?? {};
  if (!flags.on('redis-state')) {
    return {
      cache: new MemoryCache(),
      events: new MemoryEventBus(),
      lock: new MemoryLock(),
      oneTime: new MemoryOneTimeStore(),
      signInFailures: new MemoryWindowLimiter(signIn),
      buckets: new MemoryTokenBucket(buckets),
      deliveries: new MemoryDeliveryDedupe(),
      backend: 'memory',
    };
  }
  if (!connections?.urls.queue) throw new Error('the redis-state flag needs SHIPCAST_REDIS_QUEUE_URL');
  const prefixed = options.prefix !== undefined ? { prefix: options.prefix } : {};
  const queue = connections.queue;
  const cache = connections.cache;
  return {
    cache: new RedisCache(cache, { ...prefixed, ...(options.onError && { onError: options.onError }) }),
    events: new RedisEventBus(cache, prefixed),
    lock: new RedisLock(queue, prefixed),
    oneTime: new RedisOneTimeStore(queue, prefixed),
    signInFailures: new RedisWindowLimiter(queue, { ...prefixed, name: 'sign-in', ...signIn }),
    buckets: new RedisTokenBucket(queue, buckets, prefixed),
    deliveries: new RedisDeliveryDedupe(queue, prefixed),
    backend: 'redis',
  };
}
