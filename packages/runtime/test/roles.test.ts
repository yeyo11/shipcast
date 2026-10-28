import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { GitHubRest, PipelineDeps, Repositories } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import {
  handlersOf,
  MemoryStore,
  poolOptions,
  QUEUE_NAMES,
  QUEUE_ROLES,
  queuePoolMax,
  queuesOf,
  roleFromEnv,
  ROUND_KEY,
  startWorking,
  type Handlers,
  type JobQueue,
  type QueueName,
  type Role,
  type WorkDeps,
} from '../src/index.ts';

/*
 * The process split: which queues each role works and what each schedules at its start. The first
 * test is the characterisation of startWorking as one process (`all`) ran it before the split; the
 * others hold each role to its share of the queue table.
 */

interface Call {
  method: string;
  queue?: string;
  key?: string;
}

/** A queue that records what a start asks of it */
function recorder(registry: Repositories): JobQueue & { calls: Call[]; worked: QueueName[] } {
  const calls: Call[] = [];
  const worked: QueueName[] = [];
  return {
    calls,
    worked,
    registry,
    start: async () => undefined,
    send: async (queue, _data, options) => {
      calls.push({ method: 'send', queue, ...(options?.singletonKey && { key: options.singletonKey }) });
      return 'sent';
    },
    upsert: async (queue, _data, options) => {
      calls.push({ method: 'upsert', queue, key: options.singletonKey });
      return 'upserted';
    },
    schedule: async (queue, _cron, _data, options) => {
      calls.push({ method: 'schedule', queue, ...(options?.singletonKey && { key: options.singletonKey }) });
    },
    queued: async () => [],
    work: async (handlers: Handlers) => {
      worked.push(...(Object.keys(handlers) as QueueName[]));
    },
    wait: async () => undefined,
    reconcile: async () => undefined,
    stop: async () => undefined,
  };
}

const deps = (registry: Repositories): WorkDeps => ({
  env: {},
  registry,
  github: {} as unknown as GitHubRest,
  secrets: new MemoryStore(),
  pipeline: {} as unknown as PipelineDeps,
  brand: () => Promise.reject(new Error('no brand in these tests')),
});

const probe = { probe: async () => undefined };

async function started(role: Role | undefined) {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const post = await registry.posts.schedulePost(launch.id, 'bluesky', new Date(Date.now() + 3600_000));
  assert.ok(post);
  const queue = recorder(registry);
  await startWorking(queue, deps(registry), { handlers: probe, ...(role && { role }) });
  return { queue, post };
}

const CRONS = ['checks', 'probe', 'metrics', 'instagram-tokens', 'snapshots', 'comments', 'round'];

test('characterisation: one process works every queue, schedules every cron, moves the round to soon and arms each scheduled piece', async () => {
  const { queue, post } = await started(undefined);
  assert.deepEqual([...queue.worked].sort(), [...QUEUE_NAMES].sort());
  assert.deepEqual(
    queue.calls.filter((c) => c.method === 'schedule').map((c) => c.queue),
    CRONS,
  );
  assert.deepEqual(queue.calls.filter((c) => c.method !== 'schedule'), [
    { method: 'upsert', queue: 'round', key: ROUND_KEY },
    { method: 'upsert', queue: 'scheduled', key: `post:${post.id}` },
  ]);
  assert.deepEqual((await started('all')).queue.calls.length, queue.calls.length, '`all` is the same');
});

test('the queue table gives every queue to exactly one of the worker roles', () => {
  const worker = queuesOf('worker');
  const heavy = queuesOf('heavy');
  assert.deepEqual([...worker, ...heavy].sort(), [...QUEUE_NAMES].sort());
  assert.equal(worker.filter((q) => heavy.includes(q)).length, 0);
  assert.deepEqual(queuesOf('web'), []);
  assert.deepEqual(heavy.sort(), ['article', 'assistant-check', 'comments', 'draft', 'probe', 'profile-review']);
  for (const q of QUEUE_NAMES) assert.ok(QUEUE_ROLES[q]);
});

describe('each role registers exactly its queues', () => {
  test('web works nothing and schedules nothing', async () => {
    const { queue } = await started('web');
    assert.deepEqual(queue.worked, []);
    assert.deepEqual(queue.calls, []);
  });

  test('a worker works its queues, schedules every cron (the probe’s for the heavy workers) and only sends a round, never moving one', async () => {
    const { queue, post } = await started('worker');
    assert.deepEqual([...queue.worked].sort(), queuesOf('worker').sort());
    assert.deepEqual(
      queue.calls.filter((c) => c.method === 'schedule').map((c) => c.queue),
      CRONS,
    );
    assert.deepEqual(queue.calls.filter((c) => c.method !== 'schedule'), [
      { method: 'send', queue: 'round', key: ROUND_KEY },
      { method: 'upsert', queue: 'scheduled', key: `post:${post.id}` },
    ]);
  });

  test('a heavy worker works its queues and schedules nothing', async () => {
    const { queue } = await started('heavy');
    assert.deepEqual([...queue.worked].sort(), queuesOf('heavy').sort());
    assert.deepEqual(queue.calls, []);
  });

  test('handlersOf keeps only the role’s handlers', () => {
    const all = Object.fromEntries(QUEUE_NAMES.map((q) => [q, async () => undefined])) as Handlers;
    assert.deepEqual(Object.keys(handlersOf('heavy', all)).sort(), queuesOf('heavy').sort());
    assert.deepEqual(Object.keys(handlersOf('all', all)).sort(), [...QUEUE_NAMES].sort());
  });
});

test('the role and the pools come from the environment, today’s when unset', () => {
  assert.equal(roleFromEnv({}), 'all');
  assert.equal(roleFromEnv({ SHIPCAST_ROLE: 'heavy' }), 'heavy');
  assert.throws(() => roleFromEnv({ SHIPCAST_ROLE: 'cron' }), /SHIPCAST_ROLE/);
  assert.deepEqual(poolOptions({}), {});
  assert.equal(queuePoolMax({}), 4);
  assert.deepEqual(poolOptions({ SHIPCAST_DB_POOL_MAX: '3', SHIPCAST_DB_PREPARE: 'false', SHIPCAST_DATABASE_MIGRATE_URL: 'postgres://direct/db' }), { max: 3, prepare: false, migrateUrl: 'postgres://direct/db' });
  assert.equal(queuePoolMax({ SHIPCAST_QUEUE_POOL_MAX: '2' }), 2);
  assert.throws(() => poolOptions({ SHIPCAST_DB_POOL_MAX: '0' }), /SHIPCAST_DB_POOL_MAX/);
});
