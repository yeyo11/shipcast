import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import { MemoryStore, replicaEvents, RuntimeSettings } from '../src/index.ts';
import { buildProcessState, type ProcessState } from '../src/redis/index.ts';
import { redisSkip, TEST_REDIS_URL, testRedis } from './redis-helper.ts';

/*
 * Two replicas in one test: two process states on one throwaway Redis (as two processes have) over
 * one registry. What one starts or saves, the other sees: an OAuth state, a console link, a failed
 * sign-in count, a delivery id, a Settings save.
 */

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('two replicas over one Redis', { skip: redisSkip }, () => {
  const redis = testRedis();
  const env = { SHIPCAST_FLAGS: 'redis-state', SHIPCAST_REDIS_QUEUE_URL: TEST_REDIS_URL };
  const states: ProcessState[] = [];
  const replica = () => {
    const state = buildProcessState(env, `replica-${states.length}`, redis.prefix);
    states.push(state);
    return state;
  };
  after(async () => {
    await Promise.all(states.map((s) => s.close()));
    await redis.cleanup();
  });

  test('the shared state is Redis’s with redis-state on, memory without', () => {
    assert.equal(replica().shared.backend, 'redis');
    const local = buildProcessState({}, 'local');
    assert.equal(local.shared.backend, 'memory');
    assert.equal(local.redis, undefined, 'no flag, no Redis connection');
  });

  test('an OAuth state started on one finishes on the other, once', async () => {
    const [a, b] = [replica(), replica()];
    const state = await a.shared.oneTime.put('oauth-state', { network: 'reddit', brand: 'personal' }, 600);
    assert.deepEqual(await b.shared.oneTime.take('oauth-state', state), { network: 'reddit', brand: 'personal' });
    assert.equal(await a.shared.oneTime.take('oauth-state', state), undefined, 'never good twice');
  });

  test('wrong tokens counted on both replicas add up to one limit', async () => {
    const [a, b] = [replica(), replica()];
    for (let i = 0; i < 5; i++) await a.shared.signInFailures.hit('203.0.113.7');
    for (let i = 0; i < 5; i++) await b.shared.signInFailures.hit('203.0.113.7');
    assert.equal((await a.shared.signInFailures.peek('203.0.113.7')).limited, true);
    assert.equal((await b.shared.signInFailures.peek('198.51.100.1')).limited, false, 'per client');
  });

  test('a delivery received by one is a redelivery for the other', async () => {
    const [a, b] = [replica(), replica()];
    assert.equal(await a.shared.deliveries.claim('delivery-1'), true);
    assert.equal(await b.shared.deliveries.claim('delivery-1'), false);
  });

  test('a Settings save on one reloads the other, and the brand and the installation follow', async () => {
    const registry = await memoryRegistry();
    const secrets = new MemoryStore();
    const make = async () => {
      const settings = new RuntimeSettings({ registry, secrets, env: {} });
      await settings.read();
      const counts = { brand: 0, installation: 0 };
      const events = await replicaEvents(replica().shared, {
        refresh: async () => {
          await settings.read();
        },
        invalidateBrand: () => counts.brand++,
        githubApp: { refresh: () => counts.installation++ },
      });
      return { settings, counts, events };
    };
    const [one, two] = [await make(), await make()];
    await one.settings.write({ launchesRepo: 'josegarridodev/launches' });
    await one.events.settingsSaved('launches-repo');
    assert.equal(one.settings.current().launchesRepo, 'josegarridodev/launches', 'the saving replica at once');
    await until(() => two.settings.current().launchesRepo === 'josegarridodev/launches');
    await until(() => two.counts.brand > 0);
    await one.events.announce('github.installation.changed', { reason: 'test' });
    await until(() => two.counts.installation === 1 && one.counts.installation === 1);
  });
});

test('in memory (redis-state off) a save reloads this process only, as before, and nothing is published', async () => {
  const registry = await memoryRegistry();
  const state = buildProcessState({}, 'local');
  let reads = 0;
  let brand = 0;
  const events = await replicaEvents(state.shared, { refresh: async () => void reads++, invalidateBrand: () => brand++ });
  await events.settingsSaved();
  assert.equal(reads, 1);
  await events.announce('brand.changed', { repo: 'x/y' });
  assert.equal(brand, 1);
  assert.ok(registry);
});
