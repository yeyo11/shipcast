import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Repositories } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { draining, onStop, readiness, resetLifecycle, stopProcess } from '../src/index.ts';
import { RedisConnections } from '../src/redis/index.ts';
import { redisSkip, TEST_REDIS_URL } from './redis-helper.ts';

afterEach(() => resetLifecycle());

test('ready while the registry answers, and 503-worthy from the first moment of a stop', async () => {
  const registry = await memoryRegistry();
  assert.deepEqual(await readiness({ registry }), { ready: true, checks: { process: 'ok', postgres: 'ok' } });

  let release!: () => void;
  const httpClosed = new Promise<void>((r) => (release = r));
  onStop('http', 'the server', () => httpClosed);
  const stopping = stopProcess({ log: () => {} });
  assert.equal(draining(), true, 'draining before the server has even closed');
  const during = await readiness({ registry });
  assert.equal(during.ready, false);
  assert.equal(during.checks.process, 'draining');
  release();
  await stopping;
});

test('a registry that fails, or does not answer in time, is not ready', async () => {
  const failing = { database: { execute: () => Promise.reject(new Error('connection refused')) } } as unknown as Pick<Repositories, 'database'>;
  const failed = await readiness({ registry: failing, draining: () => false }, 500);
  assert.deepEqual(failed, { ready: false, checks: { process: 'ok', postgres: 'connection refused' } });
  const hanging = { database: { execute: () => new Promise(() => undefined) } } as unknown as Pick<Repositories, 'database'>;
  const slow = await readiness({ registry: hanging, draining: () => false }, 100);
  assert.equal(slow.ready, false);
  assert.match(slow.checks.postgres ?? '', /no answer in 100 ms/);
});

test('a stop runs its steps in order, HTTP first and the registry last, and a failing step does not stop the rest', async () => {
  const order: string[] = [];
  onStop('db', 'the registry', async () => void order.push('db'));
  onStop('telemetry', 'the telemetry', async () => void order.push('telemetry'));
  onStop('queue', 'the queue', async () => {
    order.push('queue');
    throw new Error('stuck');
  });
  onStop('http', 'the server', async () => void order.push('http'));
  onStop('redis', 'Redis', async () => void order.push('redis'));
  const logged: string[] = [];
  await Promise.all([stopProcess({ log: (l) => logged.push(l) }), stopProcess({ log: (l) => logged.push(l) })]);
  assert.deepEqual(order, ['http', 'queue', 'telemetry', 'redis', 'db'], 'once, in order');
  assert.deepEqual(logged, ['stopping the queue: stuck']);
});

test('Redis is pinged when the process uses it', { skip: redisSkip }, async () => {
  const registry = await memoryRegistry();
  const redis = new RedisConnections({ queue: TEST_REDIS_URL, cache: undefined }, { name: 'health-test' });
  try {
    const result = await readiness({ registry, redis, draining: () => false });
    assert.deepEqual(result, { ready: true, checks: { process: 'ok', postgres: 'ok', 'redis-queue': 'ok' } });
  } finally {
    await redis.close();
  }
});
