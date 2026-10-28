import type { JobRecord } from '@shipcast/engine';

/*
 * The shared ephemeral state of docs/plans/performance-refactor.md ("Scaling out: process types and
 * shared state"): what one process kept in a Map and every replica now has to see. Each port has a
 * Redis adapter and an in-memory one (tests, and a single local install with no Redis). None of
 * them holds truth: Postgres does, so everything here can be lost (a flush, a new instance) and only
 * costs a re-read, a re-sign-in or a rebuilt schedule.
 *
 * The ports live in the runtime because the runtime builds the adapters. A package below it (the
 * connectors, the engine) that needs one declares the narrow structural interface it uses, as
 * `EtagCache` does in the connectors, and these adapters satisfy it without an import upward.
 */

/** Values are JSON: what goes in is what comes out, through any process */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * A cache for values that are cheap to lose. Freshness is by event, not by guessing a TTL: a key
 * that embeds its namespace's version (`versioned`) stops being read the moment the version is
 * bumped, on every replica at once, and the old entries age out on their own.
 */
export interface Cache {
  get<T extends Json>(key: string): Promise<T | undefined>;
  set(key: string, value: Json, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** The namespace's version now; a namespace never seen starts at a fresh one, never an old one */
  version(namespace: string): Promise<number>;
  /** Moves the namespace to a new version: every key built from the old one is no longer read */
  bump(namespace: string): Promise<number>;
  /** The key of `key` under the namespace's current version */
  versioned(namespace: string, key: string): Promise<string>;
  /** The cached value, or `load`'s, stored for next time */
  remember<T extends Json>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T>;
}

/** A lock held by this process; its token is what makes release and extend safe against another holder */
export interface LockHandle {
  readonly key: string;
  readonly token: string;
  /** Pushes the expiry out; false when the lock was lost (expired and taken by another) */
  extend(ttlMs: number): Promise<boolean>;
  /** Lets it go; false when it was no longer ours, which is then left alone */
  release(): Promise<boolean>;
}

export interface LockOptions {
  /** How long the lock lives without a renewal: what a crashed holder costs the next one */
  ttlMs: number;
  /** How long to keep trying for a lock someone holds; 0 (the default) gives up at once */
  waitMs?: number;
  /** Between two tries while waiting */
  retryMs?: number;
}

export type LockResult<T> = { acquired: true; value: T } | { acquired: false };

export interface Lock {
  /** The lock, or undefined when another holds it */
  acquire(key: string, ttlMs: number): Promise<LockHandle | undefined>;
  /**
   * Runs `fn` holding the lock, renewed every third of its TTL while `fn` runs, so `fn` never runs
   * twice at once across processes however long it takes. If a renewal finds the lock lost (Redis
   * unreachable past the TTL), `signal` aborts: `fn` should stop writing.
   */
  withLock<T>(key: string, fn: (signal: AbortSignal) => Promise<T>, options: LockOptions): Promise<LockResult<T>>;
}

/** The events every replica reacts to; each is a hint to re-read Postgres, never the data itself */
export interface ShipcastEvents {
  /** A setting was saved: every replica reloads it */
  'settings.changed': { key: string };
  /** A launch's row, its failures or its drafts snapshot changed; a claim is a new one */
  'launch.changed': { launchId: number };
  /** A piece was recorded, edited, deleted or (un)scheduled; null when a whole channel's schedule was cleared */
  'post.changed': { postId: number | null; launchId: number };
  /** A job's row: sent, started, a line of its log (coalesced), ended */
  'job.changed': { id: string; queue: string; state: JobRecord['state']; launchId: number | null };
  /** A comment was recorded, drafted, sent or set aside */
  'comment.changed': { commentId: number; launchId: number };
  /** A launch's numbers were read: one per run per launch, not one per reading */
  'metrics.changed': { launchId: number };
  /** An account was connected, edited, checked, made primary, removed or its numbers were read */
  'account.changed': { accountId: number };
  /** The bell's dismissals changed */
  'attention.changed': { dismissed: number };
  /** The GitHub App's installation changed: every replica looks it up again */
  'github.installation.changed': { reason: string };
  /** The launches repo changed (a push): every replica reads the brand again */
  'brand.changed': { repo: string };
}

export type EventName = keyof ShipcastEvents;
export type Unsubscribe = () => Promise<void>;

/**
 * Publish and subscribe across replicas. Delivery is at most once (Redis pub/sub keeps nothing), so
 * a subscriber that was disconnected is told through `onReconnect` and re-reads what it holds.
 */
export interface EventBus {
  publish<E extends EventName>(event: E, payload: ShipcastEvents[E]): Promise<void>;
  /** Resolves once the subscription is live, so an event published after it is received */
  subscribe<E extends EventName>(event: E, listener: (payload: ShipcastEvents[E]) => void): Promise<Unsubscribe>;
  /** Called after the subscriber's connection came back: events may have been missed meanwhile */
  onReconnect(listener: () => void): () => void;
  close(): Promise<void>;
}

/** Values that expire and can be taken once: an OAuth `state`, a console sign-in link */
export interface OneTimeStore {
  /** Stores under a fresh random token, which it returns */
  put(namespace: string, value: Json, ttlSeconds: number): Promise<string>;
  /** Stores under a key the caller chose; false when the key is in use */
  set(namespace: string, key: string, value: Json, ttlSeconds: number): Promise<boolean>;
  /** The value, removed in the same step: two replicas taking it at once get it once */
  take<T extends Json>(namespace: string, key: string): Promise<T | undefined>;
}

/** One client's window: how many hits, and when it ends */
export interface WindowState {
  count: number;
  /** Whether `count` reached the limit */
  limited: boolean;
  /** Seconds until the window ends; 0 when there is none */
  resetInSeconds: number;
}

/**
 * Fixed-window counters keyed by client, the window starting at the first hit, as the API's
 * in-memory FailureLimiter counts failed sign-ins: N failures in the window and the client waits
 * for its end.
 */
export interface WindowLimiter {
  hit(key: string): Promise<WindowState>;
  peek(key: string): Promise<WindowState>;
  reset(key: string): Promise<void>;
}

export interface BucketSpec {
  /** Most tokens the bucket holds: the largest burst */
  capacity: number;
  /** Tokens added per second */
  refillPerSecond: number;
}

export interface TakeResult {
  ok: boolean;
  /** Tokens left after the take */
  remaining: number;
  /** When not ok, how long until `cost` tokens are there */
  waitMs: number;
}

/**
 * A token bucket per provider, shared by every process that calls it, so replicas together stay
 * under what a network allows. `observe` folds in what the provider itself reported (its remaining
 * quota), which wins over the local estimate when it is lower.
 */
export interface TokenBucket {
  take(provider: string, cost?: number): Promise<TakeResult>;
  /** Waits for the tokens, up to `maxWaitMs`; false when they did not come in time */
  acquire(provider: string, options?: { cost?: number; maxWaitMs?: number; signal?: AbortSignal }): Promise<boolean>;
  observe(provider: string, quota: { remaining: number; resetAt?: Date }): Promise<void>;
}

/** GitHub's X-GitHub-Delivery ids seen lately: a redelivery of one already handled is dropped */
export interface DeliveryDedupe {
  /** True the first time an id is seen (and records it), false for a repeat */
  claim(delivery: string): Promise<boolean>;
  /** Forgets an id whose handling failed, so GitHub's redelivery is taken */
  release(delivery: string): Promise<void>;
}
