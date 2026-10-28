import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { buildProcessState, MemoryOneTimeStore, MemoryWindowLimiter, redisClient, type ProcessState } from '@shipcast/runtime/redis';
import { sharedLimiter } from '../src/server/api.ts';
import { consoleLinks } from '../src/server/console-links.ts';

/*
 * The web app's shared state across two replicas: a console link printed by one signs in on the
 * other, once, and wrong API tokens counted by both add up. On the throwaway Redis
 * (SHIPCAST_TEST_REDIS_URL, or 127.0.0.1:6390); skipped without one.
 */

const url = process.env.SHIPCAST_TEST_REDIS_URL || 'redis://127.0.0.1:6390';
const reachable = await (async () => {
  const probe = redisClient(url, 'cache', { name: 'probe' });
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
})();

test('in one process (memory) a console link is good once', async () => {
  const links = consoleLinks(new MemoryOneTimeStore());
  const token = await links.create();
  assert.equal(await links.redeem(token), true);
  assert.equal(await links.redeem(token), false);
  assert.equal(await links.redeem(''), false);
});

test('the shared limiter refuses a client once the window is full', async () => {
  const limiter = sharedLimiter(new MemoryWindowLimiter({ limit: 2, windowSeconds: 60 }));
  assert.equal(await limiter.blocked('a'), undefined);
  await limiter.fail('a');
  await limiter.fail('a');
  assert.ok(((await limiter.blocked('a')) ?? 0) > 0);
  assert.equal(await limiter.blocked('b'), undefined);
});

describe('two web replicas over one Redis', { skip: reachable ? false : `no test Redis at ${url}` }, () => {
  const prefix = `test:${randomUUID()}:`;
  const env = { SHIPCAST_FLAGS: 'redis-state', SHIPCAST_REDIS_QUEUE_URL: url };
  const states: ProcessState[] = [buildProcessState(env, 'web-1', prefix), buildProcessState(env, 'web-2', prefix)];
  after(async () => {
    const sweeper = redisClient(url, 'queue');
    const keys = await sweeper.keys(`${prefix}*`);
    if (keys.length > 0) await sweeper.del(...keys);
    sweeper.disconnect();
    await Promise.all(states.map((s) => s.close()));
  });

  test('a console link made on one is used on the other, once', async () => {
    const [one, two] = states as [ProcessState, ProcessState];
    const token = await consoleLinks(one.shared.oneTime).create();
    assert.equal(await consoleLinks(two.shared.oneTime).redeem(token), true);
    assert.equal(await consoleLinks(one.shared.oneTime).redeem(token), false);
  });

  test('the API limiter counts a client’s wrong tokens across both', async () => {
    const [one, two] = states.map((s) => sharedLimiter(s.shared.signInFailures)) as [ReturnType<typeof sharedLimiter>, ReturnType<typeof sharedLimiter>];
    for (let i = 0; i < 10; i++) await (i % 2 ? one : two).fail('192.0.2.44');
    assert.ok(((await one.blocked('192.0.2.44')) ?? 0) > 0);
    assert.ok(((await two.blocked('192.0.2.44')) ?? 0) > 0);
  });
});
