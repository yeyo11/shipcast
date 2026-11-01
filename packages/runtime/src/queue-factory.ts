import { BullQueue } from './queue-bullmq.ts';
import { WorkQueue, type JobQueue, type QueueOptions, type QueueRepositories } from './queue.ts';
import type { RedisConnections } from './redis/connection.ts';

export interface JobQueueDeps {
  registry: QueueRepositories;
  /** The registry's Postgres, where pg-boss keeps its schema */
  databaseUrl: string;
  /** This process's Redis connections: with them the queue is BullMQ's, without them pg-boss's */
  redis?: RedisConnections;
  options?: QueueOptions & { lockSeconds?: number };
}

/**
 * The queue a process works: BullMQ on redis-queue when the process has Redis (SHIPCAST_REDIS_QUEUE_URL,
 * which every split process and production have, redis/process.ts); pg-boss in the registry's Postgres
 * for a single process without Redis (a desktop install, the tests). Decided by the same environment
 * for every process type (web, worker, heavy worker, CLI), so they never disagree on where a job
 * waits: what every composition root builds its queue with.
 */
export function jobQueue(deps: JobQueueDeps): JobQueue {
  const options = deps.options ?? {};
  if (!deps.redis) return WorkQueue.postgres(deps.databaseUrl, deps.registry, options);
  if (!deps.redis.urls.queue) throw new Error('BullMQ needs SHIPCAST_REDIS_QUEUE_URL');
  return BullQueue.on(deps.redis, deps.registry, {
    ...(options.instanceName !== undefined && { instanceName: options.instanceName }),
    ...(options.onError && { onError: options.onError }),
    ...(options.retryDelaySeconds !== undefined && { retryDelaySeconds: options.retryDelaySeconds }),
    ...(options.lockSeconds !== undefined && { lockSeconds: options.lockSeconds }),
    ...(options.telemetry && { telemetry: options.telemetry }),
    ...(options.reconcileAtStart !== undefined && { reconcileAtStart: options.reconcileAtStart }),
  });
}
