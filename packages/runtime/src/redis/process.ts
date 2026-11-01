import { ConfigError } from '../config.ts';
import { Flags } from '../flags.ts';
import { roleFromEnv, split } from '../roles.ts';
import { RedisConnections } from './connection.ts';
import { sharedState, type SharedState } from './state.ts';

/**
 * The shared state and Redis connections of this process, built once from the environment. Kept on
 * globalThis because the web app's launcher (main.ts, which prints the console sign-in link) and the
 * bundled app (which redeems it) load this module separately but are one process: they must share
 * one store, and one set of connections.
 *
 * Redis is used when SHIPCAST_REDIS_QUEUE_URL is set: the shared state on its two instances and every
 * queue on BullMQ. A split process (SHIPCAST_ROLE web, worker or heavy), which production runs, cannot
 * start without it: its replicas share locks, one-time values and events, and one queue. A single
 * process without it (a desktop install, the tests) keeps them in its memory and its queue in pg-boss.
 */
export interface ProcessState {
  flags: Flags;
  /** Present when SHIPCAST_REDIS_QUEUE_URL is set */
  redis: RedisConnections | undefined;
  shared: SharedState;
  /** Whether Redis is in use: what /readyz pings */
  usesRedis: boolean;
  /** Closes the subscriptions and the Redis connections, last thing before the database */
  close(): Promise<void>;
}

const store = globalThis as { __shipcastProcessState?: ProcessState };

/** `prefix` keeps a test's keys apart on a shared Redis; a deployment uses the default */
export function buildProcessState(env: NodeJS.ProcessEnv, name = 'app', prefix?: string): ProcessState {
  const flags = Flags.fromEnv(env);
  const usesRedis = Boolean(env.SHIPCAST_REDIS_QUEUE_URL?.trim());
  if (!usesRedis && env.SHIPCAST_REDIS_CACHE_URL?.trim()) throw new ConfigError('SHIPCAST_REDIS_CACHE_URL is set without SHIPCAST_REDIS_QUEUE_URL: Redis needs both (redis-cache alone holds nothing that must last)');
  if (!usesRedis && split(roleFromEnv(env))) throw new ConfigError(`SHIPCAST_ROLE=${roleFromEnv(env)} needs SHIPCAST_REDIS_QUEUE_URL: split processes share their queue, locks and events through Redis`);
  const redis = usesRedis ? RedisConnections.fromEnv(env, { name, onError: (error) => console.error(`redis: ${error.message}`) }) : undefined;
  const shared = sharedState(redis, { ...(prefix !== undefined && { prefix }), onError: (error) => console.error(`redis cache: ${error instanceof Error ? error.message : String(error)}`) });
  let closed: Promise<void> | undefined;
  return {
    flags,
    redis,
    shared,
    usesRedis,
    close: () => (closed ??= shared.events.close().catch(() => undefined).then(() => redis?.close())),
  };
}

/** This process's state, built on first use */
export function processState(env: NodeJS.ProcessEnv = process.env, name?: string): ProcessState {
  store.__shipcastProcessState ??= buildProcessState(env, name);
  return store.__shipcastProcessState;
}
