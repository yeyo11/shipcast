import { Flags } from '../flags.ts';
import { RedisConnections } from './connection.ts';
import { sharedState, type SharedState } from './state.ts';

/**
 * The shared state and Redis connections of this process, built once from the environment. Kept on
 * globalThis because the web app's launcher (main.ts, which prints the console sign-in link) and the
 * bundled app (which redeems it) load this module separately but are one process: they must share
 * one store, and one set of connections. Redis is only connected to when a flag uses it.
 */
export interface ProcessState {
  flags: Flags;
  /** Present when `redis-state` or `bullmq` is on */
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
  const usesRedis = flags.on('redis-state') || flags.on('bullmq');
  const redis = usesRedis ? RedisConnections.fromEnv(env, { name, onError: (error) => console.error(`redis: ${error.message}`) }) : undefined;
  const shared = sharedState(flags, redis, { ...(prefix !== undefined && { prefix }), onError: (error) => console.error(`redis cache: ${error instanceof Error ? error.message : String(error)}`) });
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
