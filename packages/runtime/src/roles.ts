import type { PoolOptions } from '@shipcast/engine';
import { ConfigError } from './config.ts';
import { QUEUE_NAMES, type Handlers, type QueueName } from './queue.ts';

/*
 * The process split of docs/plans/performance-refactor.md ("Scaling out: process types and shared
 * state"), chosen by SHIPCAST_ROLE. Every process is the same image and the same entry point; the
 * role decides what it takes on:
 *
 * - `web` serves HTTP and enqueues; it never works a queue and never schedules.
 * - `worker` works the short, network-bound queues, schedules the crons, sends the round and keeps
 *   the jobs' rows and the scheduled posts in line with the queue (startMaintenance).
 * - `heavy` works what runs an AI, a browser, git, ffmpeg or satori: long, CPU- or memory-hungry
 *   work that must not slow a request or a publish.
 * - `all` (the default) is today: one process doing everything, as a single install runs.
 */

export type Role = 'web' | 'worker' | 'heavy' | 'all';
export const ROLES: readonly Role[] = ['web', 'worker', 'heavy', 'all'];

/** The process type that works each queue: the one table the split is defined by */
export const QUEUE_ROLES: Readonly<Record<QueueName, 'worker' | 'heavy'>> = {
  // A clone and a long AI run, then satori, Chromium and ffmpeg for the assets
  draft: 'heavy',
  article: 'heavy',
  // An AI run per account
  'profile-review': 'heavy',
  // Reads the comments and drafts each new one's reply with the AI, in one job: the AI makes it heavy
  // until reading and drafting are separate queues
  comments: 'heavy',
  // Headless Chromium
  probe: 'heavy',
  publish: 'worker',
  scheduled: 'worker',
  delivery: 'worker',
  round: 'worker',
  metrics: 'worker',
  'instagram-tokens': 'worker',
  snapshots: 'worker',
  checks: 'worker',
};

/** SHIPCAST_ROLE, `all` when unset */
export function roleFromEnv(env: NodeJS.ProcessEnv): Role {
  const value = env.SHIPCAST_ROLE?.trim() || 'all';
  if (!(ROLES as readonly string[]).includes(value)) throw new ConfigError(`SHIPCAST_ROLE is ${ROLES.join(', ')}, not "${value}"`);
  return value as Role;
}

/** The queues a role works */
export function queuesOf(role: Role): QueueName[] {
  if (role === 'all') return [...QUEUE_NAMES];
  if (role === 'web') return [];
  return QUEUE_NAMES.filter((q) => QUEUE_ROLES[q] === role);
}

/** Only the handlers of the role's queues: a process registers exactly its own */
export function handlersOf(role: Role, handlers: Handlers): Handlers {
  const mine = new Set(queuesOf(role));
  return Object.fromEntries(Object.entries(handlers).filter(([queue]) => mine.has(queue as QueueName))) as Handlers;
}

/** Whether a role schedules the crons, sends the round and reconciles: one kind of process does */
export const runsTheClock = (role: Role) => role === 'all' || role === 'worker';

/** Whether processes run side by side, each with its share: what turns on the boot rules for many */
export const split = (role: Role) => role !== 'all';

function positive(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a whole number above 0, not "${value}"`);
  return n;
}

/**
 * The registry pool of this process, so each process type is sized to fit behind PgBouncer:
 * SHIPCAST_DB_POOL_MAX (postgres.js's max, 10 when unset), SHIPCAST_DB_PREPARE=false (transaction
 * pooling) and SHIPCAST_DATABASE_MIGRATE_URL (the migrator's direct connection past PgBouncer).
 */
export function poolOptions(env: NodeJS.ProcessEnv): PoolOptions {
  const max = positive(env, 'SHIPCAST_DB_POOL_MAX');
  const prepare = env.SHIPCAST_DB_PREPARE?.trim();
  if (prepare !== undefined && prepare !== '' && prepare !== 'true' && prepare !== 'false') throw new ConfigError(`SHIPCAST_DB_PREPARE is true or false, not "${prepare}"`);
  const migrateUrl = env.SHIPCAST_DATABASE_MIGRATE_URL?.trim();
  return {
    ...(max !== undefined && { max }),
    ...(prepare === 'false' && { prepare: false }),
    ...(migrateUrl && { migrateUrl }),
  };
}

/** pg-boss's pool for this process: SHIPCAST_QUEUE_POOL_MAX, 4 when unset */
export const queuePoolMax = (env: NodeJS.ProcessEnv): number => positive(env, 'SHIPCAST_QUEUE_POOL_MAX') ?? 4;
