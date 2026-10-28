import type { Registry } from '@shipcast/engine';
import { BullQueue } from '../src/queue-bullmq.ts';
import type { Handlers, QueueName } from '../src/queue.ts';
import { redisClient } from '../src/redis/index.ts';

/*
 * A worker process for queue-contract.test.ts to kill with SIGKILL: it works one queue with a handler
 * that never ends, says `started <id>` on stdout when it takes a job, and waits to die. A real kill
 * is the only honest one: inside the test process a "dead" worker would keep renewing its lock or its
 * timers. Its rows go nowhere (the test's registry is a PGlite in the parent); the parent's own rows
 * are what the test reads, written by the worker that picks the job up after the stall.
 *
 *   node test/doomed-worker.ts <redis url> <prefix> <queue>
 */
const [url, prefix, queue] = process.argv.slice(2) as [string, string, QueueName];

const registry = {
  jobs: async () => [],
  launches: { launchesPage: async () => ({ launches: [] }) },
  recordJob: async () => ({}),
  updateJob: async () => undefined,
  logJob: async () => undefined,
  job: async () => undefined,
} as unknown as Registry;

const bull = new BullQueue(redisClient(url, 'queue', { name: 'doomed' }), () => redisClient(url, 'bullmq', { name: 'doomed' }), registry, { prefix, lockSeconds: 1, onError: () => {} });
const hang = (_data: unknown, job: { id: string }) => {
  process.stdout.write(`started ${job.id}\n`);
  return new Promise<void>(() => undefined);
};
await bull.work({ [queue]: hang } as Handlers);
process.stdout.write('ready\n');
