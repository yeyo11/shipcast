import { randomBytes, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { Script } from './connection.ts';
import type { BucketSpec, Cache, DeliveryDedupe, EventBus, EventName, Json, Lock, LockHandle, LockOptions, LockResult, OneTimeStore, ShipcastEvents, TakeResult, TokenBucket, Unsubscribe, WindowLimiter, WindowState } from './ports.ts';
import { acquireFrom, checkSpec, DEFAULT_PREFIX, DELIVERY_TTL_SECONDS, runWithLock, windowOf } from './shared.ts';

/*
 * The ports on Redis. Every key starts with a prefix (`shipcast:` by default) and a short kind
 * (`c:` cache, `l:` lock, `o:` one-time, `w:` window, `b:` bucket, `d:` delivery, `e:` events), so
 * one Redis can hold several installs or test runs and a key says what it is. Anything that must
 * be read and written in one step is a Lua script: two replicas never interleave inside it.
 */

interface Prefixed {
  /** Every key starts with it; tests give each run its own */
  prefix?: string;
}

// ---------------------------------------------------------------------------------------------- cache

/*
 * A namespace's version starts at the current time in milliseconds, not at 0, and a bump adds 1.
 * redis-cache evicts by LRU, so the counter itself can go; recreated from the clock it is still
 * newer than every version handed out before (unless a namespace was bumped more than once per
 * millisecond since it was made), so a key of an old version is never read again.
 */
const VERSION = new Script(`
if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1], 'NX') end
if ARGV[2] == '1' then return redis.call('INCR', KEYS[1]) end
return tonumber(redis.call('GET', KEYS[1]))
`);

export class RedisCache implements Cache {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #onError: (error: unknown) => void;

  /** Reads and writes that fail are misses and no-ops (reported to `onError`): the caller reads the source */
  constructor(redis: Redis, options: Prefixed & { onError?: (error: unknown) => void } = {}) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}c:`;
    this.#onError = options.onError ?? (() => undefined);
  }

  async get<T extends Json>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.#redis.get(this.#prefix + key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (error) {
      this.#onError(error);
      return undefined;
    }
  }

  async set(key: string, value: Json, ttlSeconds: number): Promise<void> {
    try {
      await this.#redis.set(this.#prefix + key, JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlSeconds * 1000)));
    } catch (error) {
      this.#onError(error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#redis.del(this.#prefix + key);
    } catch (error) {
      this.#onError(error);
    }
  }

  async version(namespace: string): Promise<number> {
    return Number(await VERSION.run(this.#redis, [`${this.#prefix}v:${namespace}`], [Date.now(), '0']));
  }

  /** Unlike a read, a bump that fails throws: a caller that changed the source must know the cache may be stale */
  async bump(namespace: string): Promise<number> {
    return Number(await VERSION.run(this.#redis, [`${this.#prefix}v:${namespace}`], [Date.now(), '1']));
  }

  async versioned(namespace: string, key: string): Promise<string> {
    return `${namespace}:v${await this.version(namespace)}:${key}`;
  }

  async remember<T extends Json>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await load();
    await this.set(key, value, ttlSeconds);
    return value;
  }
}

// ----------------------------------------------------------------------------------------------- lock

const RELEASE = new Script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`);
const EXTEND = new Script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`);

/**
 * SET NX PX with a random token: only the holder's token releases or extends it, so a holder whose
 * lock expired (and was taken by another) cannot free the other's. On redis-queue: an evicted lock
 * would let two holders in.
 */
export class RedisLock implements Lock {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: Prefixed = {}) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}l:`;
  }

  async acquire(key: string, ttlMs: number): Promise<LockHandle | undefined> {
    const token = randomUUID();
    const name = this.#prefix + key;
    if ((await this.#redis.set(name, token, 'PX', ttlMs, 'NX')) !== 'OK') return undefined;
    const redis = this.#redis;
    return {
      key,
      token,
      extend: async (ms) => (await EXTEND.run(redis, [name], [token, ms])) === 1,
      release: async () => (await RELEASE.run(redis, [name], [token])) === 1,
    };
  }

  withLock<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, options: LockOptions): Promise<LockResult<T>> {
    return runWithLock((k, ttl) => this.acquire(k, ttl), key, fn, options);
  }
}

// --------------------------------------------------------------------------------------------- events

/**
 * Redis pub/sub, one channel per event. Publishing uses the shared connection; subscribing needs a
 * connection of its own (a subscribed connection can do nothing else), duplicated on first use.
 * ioredis reconnects it and re-subscribes its channels by itself; what was published meanwhile is
 * gone, which is what `onReconnect` tells the subscribers.
 */
export class RedisEventBus implements EventBus {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #reconnect = new Set<() => void>();
  #subscriber: Redis | undefined;

  constructor(redis: Redis, options: Prefixed = {}) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}e:`;
  }

  async publish<E extends EventName>(event: E, payload: ShipcastEvents[E]): Promise<void> {
    await this.#redis.publish(this.#prefix + event, JSON.stringify(payload));
  }

  #connection(): Redis {
    if (this.#subscriber) return this.#subscriber;
    const subscriber = this.#redis.duplicate({ connectionName: `${this.#redis.options.connectionName ?? 'shipcast'}-events` });
    subscriber.on('error', () => undefined);
    subscriber.on('message', (channel: string, message: string) => {
      let payload: unknown;
      try {
        payload = JSON.parse(message);
      } catch {
        return;
      }
      for (const listener of this.#listeners.get(channel) ?? []) {
        try {
          listener(payload);
        } catch {
          // One listener's failure is its own: the others still hear the event
        }
      }
    });
    // The first ready is the connection itself; every later one follows a reconnect
    let connected = false;
    subscriber.on('ready', () => {
      if (!connected) {
        connected = true;
        return;
      }
      for (const listener of this.#reconnect) {
        try {
          listener();
        } catch {
          // as above
        }
      }
    });
    this.#subscriber = subscriber;
    return subscriber;
  }

  async subscribe<E extends EventName>(event: E, listener: (payload: ShipcastEvents[E]) => void): Promise<Unsubscribe> {
    const channel = this.#prefix + event;
    const subscriber = this.#connection();
    let set = this.#listeners.get(channel);
    if (!set) {
      set = new Set();
      this.#listeners.set(channel, set);
      await subscriber.subscribe(channel);
    }
    const entry = listener as (payload: unknown) => void;
    set.add(entry);
    return async () => {
      set.delete(entry);
      if (set.size === 0 && this.#listeners.get(channel) === set) {
        this.#listeners.delete(channel);
        await subscriber.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  onReconnect(listener: () => void): () => void {
    this.#reconnect.add(listener);
    return () => void this.#reconnect.delete(listener);
  }

  async close(): Promise<void> {
    this.#listeners.clear();
    this.#reconnect.clear();
    const subscriber = this.#subscriber;
    this.#subscriber = undefined;
    if (subscriber) await subscriber.quit().catch(() => subscriber.disconnect());
  }
}

// ------------------------------------------------------------------------------------------- one-time

/** Values taken with GETDEL: read and removed in one step, so two replicas never both get one */
export class RedisOneTimeStore implements OneTimeStore {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, options: Prefixed = {}) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}o:`;
  }

  async put(namespace: string, value: Json, ttlSeconds: number): Promise<string> {
    // 24 random bytes: a token is never guessed and, in practice, never collides
    const token = randomBytes(24).toString('base64url');
    if (!(await this.set(namespace, token, value, ttlSeconds))) throw new Error('a one-time token collided');
    return token;
  }

  async set(namespace: string, key: string, value: Json, ttlSeconds: number): Promise<boolean> {
    return (await this.#redis.set(`${this.#prefix}${namespace}:${key}`, JSON.stringify(value), 'PX', Math.max(1, Math.round(ttlSeconds * 1000)), 'NX')) === 'OK';
  }

  async take<T extends Json>(namespace: string, key: string): Promise<T | undefined> {
    const raw = await this.#redis.getdel(`${this.#prefix}${namespace}:${key}`);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }
}

// --------------------------------------------------------------------------------------------- limits

// The window starts at the first hit: later hits leave its expiry alone
const HIT = new Script(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`);

export class RedisWindowLimiter implements WindowLimiter {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #limit: number;
  readonly #windowMs: number;

  /** `name` keeps two limiters apart (the API's sign-ins, another one) on one Redis */
  constructor(redis: Redis, options: Prefixed & { name: string; limit: number; windowSeconds: number }) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}w:${options.name}:`;
    this.#limit = options.limit;
    this.#windowMs = options.windowSeconds * 1000;
  }

  async hit(key: string): Promise<WindowState> {
    const [count, ttl] = (await HIT.run(this.#redis, [this.#prefix + key], [this.#windowMs])) as [number, number];
    return windowOf(count, this.#limit, ttl);
  }

  async peek(key: string): Promise<WindowState> {
    const [[, raw], [, ttl]] = (await this.#redis.multi().get(this.#prefix + key).pttl(this.#prefix + key).exec()) as [[null, string | null], [null, number]];
    return windowOf(raw === null ? 0 : Number(raw), this.#limit, ttl);
  }

  async reset(key: string): Promise<void> {
    await this.#redis.del(this.#prefix + key);
  }
}

/*
 * The steps of shared.ts's takeFrom and observeInto, in Lua, on Redis's clock so every replica
 * reads the same time. Numbers go back as strings: Redis truncates a Lua number to an integer.
 * The key lives as long as a full refill (and a provider's block) takes, then the bucket is full anyway.
 */
const BUCKET = new Script(`
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local cost = tonumber(ARGV[3])
local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local s = redis.call('HMGET', KEYS[1], 'tokens', 'at', 'until')
local tokens = tonumber(s[1]) or cap; local at = tonumber(s[2]) or now; local blocked = tonumber(s[3]) or 0
tokens = math.min(cap, tokens + (now - at) / 1000 * rate)
local ok = 0; local wait = 0
if ARGV[4] == 'observe' then
  tokens = math.max(0, math.min(tokens, tonumber(ARGV[5])))
  if tonumber(ARGV[5]) <= 0 and tonumber(ARGV[6]) > 0 then blocked = math.max(blocked, tonumber(ARGV[6])) end
elseif now < blocked then wait = blocked - now
elseif tokens >= cost then tokens = tokens - cost; ok = 1
else wait = math.ceil((cost - tokens) / rate * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', now, 'until', blocked)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + math.max(0, blocked - now) + 1000)
return {ok, tostring(tokens), wait}
`);

export class RedisTokenBucket implements TokenBucket {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #specs: Record<string, BucketSpec>;

  constructor(redis: Redis, specs: Record<string, BucketSpec>, options: Prefixed = {}) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}b:`;
    this.#specs = specs;
  }

  async #run(provider: string, args: ReadonlyArray<string | number>): Promise<TakeResult> {
    const spec = checkSpec(provider, this.#specs[provider]);
    const [ok, remaining, waitMs] = (await BUCKET.run(this.#redis, [this.#prefix + provider], [spec.capacity, spec.refillPerSecond, ...args])) as [number, string, number];
    return { ok: ok === 1, remaining: Number(remaining), waitMs };
  }

  take(provider: string, cost = 1): Promise<TakeResult> {
    return this.#run(provider, [cost, 'take']);
  }

  acquire(provider: string, options: { cost?: number; maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    return acquireFrom((cost) => this.take(provider, cost), options);
  }

  async observe(provider: string, quota: { remaining: number; resetAt?: Date }): Promise<void> {
    await this.#run(provider, [0, 'observe', quota.remaining, quota.resetAt?.getTime() ?? 0]);
  }
}

// ------------------------------------------------------------------------------------------ deliveries

export class RedisDeliveryDedupe implements DeliveryDedupe {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #ttlSeconds: number;

  constructor(redis: Redis, options: Prefixed & { ttlSeconds?: number } = {}) {
    this.#redis = redis;
    this.#prefix = `${options.prefix ?? DEFAULT_PREFIX}d:`;
    this.#ttlSeconds = options.ttlSeconds ?? DELIVERY_TTL_SECONDS;
  }

  async claim(delivery: string): Promise<boolean> {
    return (await this.#redis.set(this.#prefix + delivery, '1', 'EX', this.#ttlSeconds, 'NX')) === 'OK';
  }

  async release(delivery: string): Promise<void> {
    await this.#redis.del(this.#prefix + delivery);
  }
}
