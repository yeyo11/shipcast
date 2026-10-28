import type { Flags } from './flags.ts';
import { BullQueue } from './queue-bullmq.ts';
import { WorkQueue, type JobQueue, type QueueOptions, type QueueRepositories } from './queue.ts';
import type { RedisConnections } from './redis/connection.ts';

export interface JobQueueDeps {
  flags: Flags;
  registry: QueueRepositories;
  /** The registry's Postgres, where pg-boss keeps its schema */
  databaseUrl: string;
  /** This process's Redis connections; needed only with `bullmq` on */
  redis?: RedisConnections;
  options?: QueueOptions & { lockSeconds?: number };
}

/**
 * The queue a process works, by the `bullmq` flag: off, pg-boss in the registry's Postgres (what runs
 * today); on, BullMQ on redis-queue, which needs SHIPCAST_REDIS_QUEUE_URL. One switch for every
 * process type (web, worker, heavy worker, CLI), so they never disagree on where a job waits. Not
 * called by the app yet: the composition roots adopt it when the flag is wired.
 */
export function jobQueue(deps: JobQueueDeps): JobQueue {
  const options = deps.options ?? {};
  if (!deps.flags.on('bullmq')) return WorkQueue.postgres(deps.databaseUrl, deps.registry, options);
  if (!deps.redis?.urls.queue) throw new Error('the bullmq flag needs SHIPCAST_REDIS_QUEUE_URL');
  return BullQueue.on(deps.redis, deps.registry, {
    ...(options.instanceName !== undefined && { instanceName: options.instanceName }),
    ...(options.onError && { onError: options.onError }),
    ...(options.retryDelaySeconds !== undefined && { retryDelaySeconds: options.retryDelaySeconds }),
    ...(options.lockSeconds !== undefined && { lockSeconds: options.lockSeconds }),
    ...(options.telemetry && { telemetry: options.telemetry }),
  });
}
