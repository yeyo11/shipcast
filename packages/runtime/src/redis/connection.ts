import { createHash } from 'node:crypto';
import { Redis, type RedisOptions } from 'ioredis';

/*
 * The two Redis instances of docs/plans/performance-refactor.md ("Redis, two instances"):
 *
 * - `redis-queue` (SHIPCAST_REDIS_QUEUE_URL): noeviction and AOF. BullMQ, and every key whose loss
 *   inside its TTL would be wrong rather than slow: locks, the stately slots, one-time values, the
 *   limiters and the delivery seen-set. All of them expire, so noeviction cannot fill up with them.
 * - `redis-cache` (SHIPCAST_REDIS_CACHE_URL): allkeys-lru, no persistence. Caches and pub/sub,
 *   which hold nothing a restart must keep.
 *
 * Neither is a source of truth: Postgres is, and both can be emptied at any moment.
 */

export type RedisRole =
  /** Locks, slots, one-time values, limiters on redis-queue: a few retries, then the caller hears */
  | 'queue'
  /** BullMQ's own connections: blocking reads that must wait out a reconnect, never fail it */
  | 'bullmq'
  /** redis-cache: a slow cache is worse than none, so it gives up fast and the caller reads the source */
  | 'cache';

export interface RedisUrls {
  queue: string | undefined;
  cache: string | undefined;
}

export function redisUrls(env: NodeJS.ProcessEnv): RedisUrls {
  return { queue: env.SHIPCAST_REDIS_QUEUE_URL || undefined, cache: env.SHIPCAST_REDIS_CACHE_URL || undefined };
}

/**
 * Backs off from 100 ms to 5 s and never gives up: a Redis restart is waited out, not turned into a
 * process that stays disconnected until someone restarts it too.
 */
export const retryStrategy = (times: number) => Math.min(100 * 2 ** Math.min(times, 6), 5000);

export function redisOptions(role: RedisRole, name: string): RedisOptions {
  const common: RedisOptions = {
    // Nothing connects until it is used: building the services never blocks on Redis
    lazyConnect: true,
    retryStrategy,
    connectionName: `shipcast-${name}`,
    enableReadyCheck: true,
  };
  if (role === 'bullmq') return { ...common, maxRetriesPerRequest: null };
  if (role === 'cache') return { ...common, maxRetriesPerRequest: 1, commandTimeout: 1000, connectTimeout: 2000 };
  return { ...common, maxRetriesPerRequest: 3, connectTimeout: 5000 };
}

/** A client for a role; errors go to `onError` (ioredis would print them unhandled otherwise) */
export function redisClient(url: string, role: RedisRole, options: { name?: string; onError?: (error: Error) => void } = {}): Redis {
  const client = new Redis(url, redisOptions(role, options.name ?? role));
  client.on('error', options.onError ?? (() => undefined));
  return client;
}

/**
 * The connections of one process, built when first asked for and closed together. Each BullMQ
 * Queue and Worker gets its own `bullmq` connection, since a worker's blocking read holds one.
 */
export class RedisConnections {
  readonly urls: RedisUrls;
  readonly #name: string;
  readonly #onError: ((error: Error) => void) | undefined;
  readonly #open: Redis[] = [];
  #queue: Redis | undefined;
  #cache: Redis | undefined;

  constructor(urls: RedisUrls, options: { name?: string; onError?: (error: Error) => void } = {}) {
    this.urls = urls;
    this.#name = options.name ?? 'app';
    this.#onError = options.onError;
  }

  static fromEnv(env: NodeJS.ProcessEnv, options: { name?: string; onError?: (error: Error) => void } = {}): RedisConnections {
    return new RedisConnections(redisUrls(env), options);
  }

  #client(url: string | undefined, variable: string, role: RedisRole, suffix: string): Redis {
    if (!url) throw new Error(`${variable} is not set`);
    const client = redisClient(url, role, { name: `${this.#name}-${suffix}`, ...(this.#onError && { onError: this.#onError }) });
    this.#open.push(client);
    return client;
  }

  get queue(): Redis {
    this.#queue ??= this.#client(this.urls.queue, 'SHIPCAST_REDIS_QUEUE_URL', 'queue', 'queue');
    return this.#queue;
  }

  get cache(): Redis {
    // A single install may run one Redis for both: the cache then shares redis-queue's
    this.#cache ??= this.urls.cache ? this.#client(this.urls.cache, 'SHIPCAST_REDIS_CACHE_URL', 'cache', 'cache') : this.queue;
    return this.#cache;
  }

  /** A fresh connection to redis-queue for BullMQ */
  bullmq(suffix = 'bullmq'): Redis {
    return this.#client(this.urls.queue, 'SHIPCAST_REDIS_QUEUE_URL', 'bullmq', suffix);
  }

  async close(): Promise<void> {
    await Promise.all(this.#open.splice(0).map((c) => c.quit().catch(() => c.disconnect())));
    this.#queue = this.#cache = undefined;
  }
}

/**
 * A Lua script run by its SHA, loaded on the first NOSCRIPT: one round trip each time, and a Redis
 * that restarted (and forgot its scripts) costs one extra.
 */
export class Script {
  readonly #lua: string;
  readonly #sha: string;

  constructor(lua: string) {
    this.#lua = lua;
    this.#sha = createHash('sha1').update(lua).digest('hex');
  }

  async run(redis: Redis, keys: readonly string[], args: ReadonlyArray<string | number>): Promise<unknown> {
    try {
      return await redis.evalsha(this.#sha, keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('NOSCRIPT')) throw error;
      return redis.eval(this.#lua, keys.length, ...keys, ...args);
    }
  }
}
