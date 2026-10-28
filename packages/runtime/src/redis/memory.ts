import { randomBytes, randomUUID } from 'node:crypto';
import type { BucketSpec, Cache, DeliveryDedupe, EventBus, EventName, Json, Lock, LockHandle, LockOptions, LockResult, OneTimeStore, ShipcastEvents, TakeResult, TokenBucket, Unsubscribe, WindowLimiter, WindowState } from './ports.ts';
import { acquireFrom, checkSpec, DELIVERY_TTL_SECONDS, observeInto, runWithLock, takeFrom, windowOf, type BucketState } from './shared.ts';

/*
 * Every port in one process's memory: for tests, and for a single local install that runs no Redis
 * (one process, so "shared" is trivially true). Same semantics as the Redis adapters, down to the
 * expiries, which are read against `now` so a test can move time.
 */

type Now = () => number;

/** A Map whose entries expire, read lazily: what every store below is built on */
class Expiring<V> {
  readonly #entries = new Map<string, { value: V; expires: number }>();
  readonly #now: Now;

  constructor(now: Now) {
    this.#now = now;
  }

  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Milliseconds left, 0 when absent */
  ttl(key: string): number {
    const entry = this.#entries.get(key);
    return entry && entry.expires > this.#now() ? entry.expires - this.#now() : 0;
  }

  set(key: string, value: V, ttlMs: number): void {
    // Expired entries go once the map grows, so keys nobody reads again cannot grow it for ever
    if (this.#entries.size > 10_000) for (const [k, e] of this.#entries) if (e.expires <= this.#now()) this.#entries.delete(k);
    this.#entries.set(key, { value, expires: this.#now() + ttlMs });
  }

  delete(key: string): boolean {
    return this.#entries.delete(key);
  }
}

// Values go through JSON as they would through Redis, so a caller cannot mutate what is cached
const clone = <T extends Json>(value: Json): T => JSON.parse(JSON.stringify(value)) as T;

export class MemoryCache implements Cache {
  readonly #values: Expiring<Json>;
  readonly #versions = new Map<string, number>();
  readonly #now: Now;

  constructor(options: { now?: Now } = {}) {
    this.#now = options.now ?? Date.now;
    this.#values = new Expiring(this.#now);
  }

  async get<T extends Json>(key: string): Promise<T | undefined> {
    const value = this.#values.get(key);
    return value === undefined ? undefined : clone<T>(value);
  }

  async set(key: string, value: Json, ttlSeconds: number): Promise<void> {
    this.#values.set(key, clone(value), ttlSeconds * 1000);
  }

  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }

  async version(namespace: string): Promise<number> {
    let version = this.#versions.get(namespace);
    if (version === undefined) this.#versions.set(namespace, (version = this.#now()));
    return version;
  }

  async bump(namespace: string): Promise<number> {
    const version = (await this.version(namespace)) + 1;
    this.#versions.set(namespace, version);
    return version;
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

export class MemoryLock implements Lock {
  readonly #held: Expiring<string>;

  constructor(options: { now?: Now } = {}) {
    this.#held = new Expiring(options.now ?? Date.now);
  }

  async acquire(key: string, ttlMs: number): Promise<LockHandle | undefined> {
    if (this.#held.get(key) !== undefined) return undefined;
    const token = randomUUID();
    this.#held.set(key, token, ttlMs);
    const held = this.#held;
    return {
      key,
      token,
      async extend(ms) {
        if (held.get(key) !== token) return false;
        held.set(key, token, ms);
        return true;
      },
      async release() {
        if (held.get(key) !== token) return false;
        return held.delete(key);
      },
    };
  }

  withLock<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, options: LockOptions): Promise<LockResult<T>> {
    return runWithLock((k, ttl) => this.acquire(k, ttl), key, fn, options);
  }
}

export class MemoryEventBus implements EventBus {
  readonly #listeners = new Map<EventName, Set<(payload: never) => void>>();

  async publish<E extends EventName>(event: E, payload: ShipcastEvents[E]): Promise<void> {
    const copy = clone<Json>(payload as unknown as Json) as unknown as ShipcastEvents[E];
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        (listener as (p: ShipcastEvents[E]) => void)(copy);
      } catch {
        // One listener's failure is its own: the others still hear the event
      }
    }
  }

  async subscribe<E extends EventName>(event: E, listener: (payload: ShipcastEvents[E]) => void): Promise<Unsubscribe> {
    const set = this.#listeners.get(event) ?? new Set();
    this.#listeners.set(event, set);
    set.add(listener as (payload: never) => void);
    return async () => void set.delete(listener as (payload: never) => void);
  }

  /** One process never loses its own events */
  onReconnect(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {
    this.#listeners.clear();
  }
}

export class MemoryOneTimeStore implements OneTimeStore {
  readonly #values: Expiring<Json>;

  constructor(options: { now?: Now } = {}) {
    this.#values = new Expiring(options.now ?? Date.now);
  }

  async put(namespace: string, value: Json, ttlSeconds: number): Promise<string> {
    const token = randomBytes(24).toString('base64url');
    await this.set(namespace, token, value, ttlSeconds);
    return token;
  }

  async set(namespace: string, key: string, value: Json, ttlSeconds: number): Promise<boolean> {
    if (this.#values.get(`${namespace}:${key}`) !== undefined) return false;
    this.#values.set(`${namespace}:${key}`, clone(value), ttlSeconds * 1000);
    return true;
  }

  async take<T extends Json>(namespace: string, key: string): Promise<T | undefined> {
    const value = this.#values.get(`${namespace}:${key}`);
    this.#values.delete(`${namespace}:${key}`);
    return value === undefined ? undefined : clone<T>(value);
  }
}

export class MemoryWindowLimiter implements WindowLimiter {
  readonly #counts: Expiring<number>;
  readonly #limit: number;
  readonly #windowMs: number;

  constructor(options: { limit: number; windowSeconds: number; now?: Now }) {
    this.#counts = new Expiring(options.now ?? Date.now);
    this.#limit = options.limit;
    this.#windowMs = options.windowSeconds * 1000;
  }

  async hit(key: string): Promise<WindowState> {
    const count = (this.#counts.get(key) ?? 0) + 1;
    // The window starts at the first hit and is not pushed out by the later ones
    this.#counts.set(key, count, count === 1 ? this.#windowMs : this.#counts.ttl(key));
    return windowOf(count, this.#limit, this.#counts.ttl(key));
  }

  async peek(key: string): Promise<WindowState> {
    return windowOf(this.#counts.get(key) ?? 0, this.#limit, this.#counts.ttl(key));
  }

  async reset(key: string): Promise<void> {
    this.#counts.delete(key);
  }
}

export class MemoryTokenBucket implements TokenBucket {
  readonly #specs: Record<string, BucketSpec>;
  readonly #state = new Map<string, BucketState>();
  readonly #now: Now;

  constructor(specs: Record<string, BucketSpec>, options: { now?: Now } = {}) {
    this.#specs = specs;
    this.#now = options.now ?? Date.now;
  }

  async take(provider: string, cost = 1): Promise<TakeResult> {
    const { state, result } = takeFrom(checkSpec(provider, this.#specs[provider]), this.#state.get(provider), cost, this.#now());
    this.#state.set(provider, state);
    return result;
  }

  acquire(provider: string, options: { cost?: number; maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    return acquireFrom((cost) => this.take(provider, cost), options);
  }

  async observe(provider: string, quota: { remaining: number; resetAt?: Date }): Promise<void> {
    this.#state.set(provider, observeInto(checkSpec(provider, this.#specs[provider]), this.#state.get(provider), quota, this.#now()));
  }
}

export class MemoryDeliveryDedupe implements DeliveryDedupe {
  readonly #seen: Expiring<true>;
  readonly #ttlMs: number;

  constructor(options: { ttlSeconds?: number; now?: Now } = {}) {
    this.#seen = new Expiring(options.now ?? Date.now);
    this.#ttlMs = (options.ttlSeconds ?? DELIVERY_TTL_SECONDS) * 1000;
  }

  async claim(delivery: string): Promise<boolean> {
    if (this.#seen.get(delivery)) return false;
    this.#seen.set(delivery, true, this.#ttlMs);
    return true;
  }

  async release(delivery: string): Promise<void> {
    this.#seen.delete(delivery);
  }
}
