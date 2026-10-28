import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Flags } from '../src/flags.ts';
import {
  MemoryCache,
  MemoryDeliveryDedupe,
  MemoryEventBus,
  MemoryLock,
  MemoryOneTimeStore,
  MemoryTokenBucket,
  MemoryWindowLimiter,
  RedisCache,
  RedisConnections,
  RedisDeliveryDedupe,
  RedisEventBus,
  RedisLock,
  RedisOneTimeStore,
  RedisTokenBucket,
  RedisWindowLimiter,
  redisOptions,
  redisUrls,
  sharedState,
  type BucketSpec,
  type Cache,
  type DeliveryDedupe,
  type EventBus,
  type Lock,
  type OneTimeStore,
  type TokenBucket,
  type WindowLimiter,
} from '../src/redis/index.ts';
import { redisSkip, testRedis, type TestRedis } from './redis-helper.ts';

/*
 * One contract per port, run against the in-memory adapter and the Redis one: they are
 * interchangeable, so what a single install without Redis does is what the replicas do together.
 * "Two processes" on Redis are two clients; in memory, one shared instance.
 */

const BUCKETS: Record<string, BucketSpec> = { bluesky: { capacity: 3, refillPerSecond: 10 } };

interface Ports {
  cache: () => Cache;
  lock: () => Lock;
  events: () => EventBus;
  oneTime: () => OneTimeStore;
  limiter: () => WindowLimiter;
  buckets: () => TokenBucket;
  deliveries: () => DeliveryDedupe;
  /** Takes a lock from whoever holds it, as a flush or an expiry the holder missed would */
  dropLock: (key: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

function memoryPorts(): Ports {
  const cache = new MemoryCache();
  // The lock's own clock, so dropping a lock is moving past its expiry
  let skew = 0;
  const lock = new MemoryLock({ now: () => Date.now() + skew });
  const events = new MemoryEventBus();
  const oneTime = new MemoryOneTimeStore();
  const limiter = new MemoryWindowLimiter({ limit: 3, windowSeconds: 1 });
  const buckets = new MemoryTokenBucket(BUCKETS);
  const deliveries = new MemoryDeliveryDedupe({ ttlSeconds: 1 });
  return { cache: () => cache, lock: () => lock, events: () => events, oneTime: () => oneTime, limiter: () => limiter, buckets: () => buckets, deliveries: () => deliveries, dropLock: async () => void (skew += 3600_000), cleanup: async () => undefined };
}

function redisPorts(redis: TestRedis): Ports {
  const { prefix } = redis;
  const buses: EventBus[] = [];
  return {
    cache: () => new RedisCache(redis.client('cache'), { prefix }),
    lock: () => new RedisLock(redis.client(), { prefix }),
    events: () => {
      const bus = new RedisEventBus(redis.client('cache'), { prefix });
      buses.push(bus);
      return bus;
    },
    oneTime: () => new RedisOneTimeStore(redis.client(), { prefix }),
    limiter: () => new RedisWindowLimiter(redis.client(), { prefix, name: 'sign-in', limit: 3, windowSeconds: 1 }),
    buckets: () => new RedisTokenBucket(redis.client(), BUCKETS, { prefix }),
    deliveries: () => new RedisDeliveryDedupe(redis.client(), { prefix, ttlSeconds: 1 }),
    dropLock: async (key) => void (await redis.client().del(`${prefix}l:${key}`)),
    cleanup: async () => {
      await Promise.all(buses.map((b) => b.close()));
      await redis.cleanup();
    },
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function contract(backend: string, make: () => Ports, skip: false | string) {
  describe(`shared state on ${backend}`, { skip }, () => {
    const run = (name: string, fn: (ports: Ports) => Promise<void>) =>
      test(name, async () => {
        const ports = make();
        try {
          await fn(ports);
        } finally {
          await ports.cleanup();
        }
      });

    run('the cache returns what was set, until its TTL or a delete', async ({ cache }) => {
      const a = cache();
      const b = cache();
      assert.equal(await a.get('brand'), undefined);
      await a.set('brand', { name: 'josegarridodev', tags: ['dev'] }, 0.3);
      assert.deepEqual(await b.get('brand'), { name: 'josegarridodev', tags: ['dev'] }, 'another process reads it');
      await b.delete('brand');
      assert.equal(await a.get('brand'), undefined);
      await a.set('short', 1, 0.1);
      await wait(200);
      assert.equal(await a.get('short'), undefined, 'gone after its TTL');
      let loads = 0;
      const load = async () => ++loads;
      assert.equal(await a.remember('n', 5, load), 1);
      assert.equal(await b.remember('n', 5, load), 1, 'remembered for the other process too');
      assert.equal(loads, 1);
    });

    run('a bumped namespace is never read at its old version, from any process', async ({ cache }) => {
      const a = cache();
      const b = cache();
      const before = await a.versioned('installations', 'yeyo11');
      assert.equal(await b.versioned('installations', 'yeyo11'), before, 'both processes agree on the version');
      await a.set(before, 'stale', 60);
      const next = await b.bump('installations');
      const after = await a.versioned('installations', 'yeyo11');
      assert.notEqual(after, before);
      assert.match(after, new RegExp(`:v${next}:`));
      assert.equal(await a.get(after), undefined, 'the old entry is not under the new key');
      assert.ok((await a.version('another')) > 0, 'a fresh namespace starts at the clock, not 0');
    });

    run('a lock has one holder; only its token releases or extends it', async ({ lock }) => {
      const a = lock();
      const b = lock();
      const held = await a.acquire('token-refresh:github', 500);
      assert.ok(held);
      assert.equal(await b.acquire('token-refresh:github', 500), undefined);
      assert.equal(await held.extend(500), true);
      await held.release();
      const next = await b.acquire('token-refresh:github', 100);
      assert.ok(next, 'released, another takes it');
      assert.equal(await held.release(), false, 'the old holder cannot free the new one');
      await wait(200);
      assert.equal(await next.extend(100), false, 'expired: it is no longer the holder’s');
      assert.ok(await a.acquire('token-refresh:github', 100), 'and it can be taken again');
    });

    run('withLock never runs two at once, renews while fn runs, and waits when asked to', async ({ lock }) => {
      const locks = [lock(), lock(), lock()];
      let running = 0;
      let most = 0;
      let runs = 0;
      // Each run outlives the TTL several times: only renewal keeps the others out
      const work = async () => {
        running++;
        most = Math.max(most, running);
        runs++;
        await wait(350);
        running--;
        return runs;
      };
      const results = await Promise.all(locks.map((l) => l.withLock('round', work, { ttlMs: 100 })));
      assert.equal(results.filter((r) => r.acquired).length, 1, 'without a wait, the others give up');
      assert.equal(most, 1);
      const waited = await Promise.all(locks.map((l) => l.withLock('round', work, { ttlMs: 100, waitMs: 3000, retryMs: 20 })));
      assert.ok(waited.every((r) => r.acquired), 'with a wait, each runs in turn');
      assert.equal(most, 1, 'never two at once');
      assert.equal(runs, 4);
    });

    run('a lock lost while fn runs aborts its signal', async ({ lock, dropLock }) => {
      const a = lock();
      const result = await a.withLock(
        'lost',
        async (signal) => {
          assert.equal(await a.acquire('lost', 60), undefined, 'held');
          // Gone from under its holder (a flush): the next renewal finds it so
          await dropLock('lost');
          await wait(150);
          return signal.aborted;
        },
        { ttlMs: 60 },
      );
      assert.deepEqual(result, { acquired: true, value: true });
    });

    run('events reach every subscriber of their name, in another process too', async ({ events }) => {
      const publisher = events();
      const subscriber = events();
      const seen: unknown[] = [];
      const other: unknown[] = [];
      const off = await subscriber.subscribe('settings.changed', (p) => seen.push(p));
      await subscriber.subscribe('post.changed', (p) => other.push(p));
      await publisher.publish('settings.changed', { key: 'automation:mode' });
      await until(() => seen.length === 1);
      assert.deepEqual(seen, [{ key: 'automation:mode' }]);
      assert.deepEqual(other, []);
      await off();
      await publisher.publish('settings.changed', { key: 'automation:interval' });
      await wait(100);
      assert.equal(seen.length, 1, 'unsubscribed, it hears no more');
    });

    run('a one-time value is taken once, and not after its TTL', async ({ oneTime }) => {
      const a = oneTime();
      const b = oneTime();
      const token = await a.put('oauth', { network: 'linkedin', brand: 'personal' }, 5);
      assert.ok(token.length >= 32);
      const [first, second] = await Promise.all([a.take('oauth', token), b.take('oauth', token)]);
      assert.deepEqual([first, second].filter(Boolean), [{ network: 'linkedin', brand: 'personal' }], 'two replicas taking it at once get it once');
      assert.equal(await a.set('console', 'abc', true, 0.1), true);
      assert.equal(await b.set('console', 'abc', true, 5), false, 'a key in use is not overwritten');
      await wait(200);
      assert.equal(await a.take('console', 'abc'), undefined, 'expired');
    });

    run('the window limiter counts per client from its first hit, and forgets at the window’s end', async ({ limiter }) => {
      const a = limiter();
      const b = limiter();
      assert.deepEqual(await a.peek('203.0.113.7'), { count: 0, limited: false, resetInSeconds: 0 });
      await a.hit('203.0.113.7');
      await b.hit('203.0.113.7');
      const third = await a.hit('203.0.113.7');
      assert.equal(third.count, 3);
      assert.equal(third.limited, true, 'three in the window is the limit, whichever replica counted them');
      assert.equal(third.resetInSeconds, 1);
      assert.equal((await b.peek('198.51.100.1')).limited, false, 'another client is not limited');
      await wait(1100);
      assert.equal((await a.peek('203.0.113.7')).count, 0, 'the window ended');
      await a.hit('203.0.113.7');
      await a.reset('203.0.113.7');
      assert.equal((await b.peek('203.0.113.7')).count, 0);
    });

    run('the token bucket is shared: a burst up to its capacity, then a wait, and the provider’s word wins', async ({ buckets }) => {
      const a = buckets();
      const b = buckets();
      const takes = await Promise.all([a.take('bluesky'), b.take('bluesky'), a.take('bluesky'), b.take('bluesky')]);
      assert.equal(takes.filter((t) => t.ok).length, 3, 'capacity 3 across both processes');
      const refused = takes.find((t) => !t.ok)!;
      assert.ok(refused.waitMs > 0 && refused.waitMs <= 100, `a refill of 10/s is a wait of at most 100 ms, not ${refused.waitMs}`);
      assert.equal(await a.acquire('bluesky', { maxWaitMs: 1000 }), true, 'acquire waits for the refill');
      await a.observe('bluesky', { remaining: 0, resetAt: new Date(Date.now() + 400) });
      await wait(150);
      const blocked = await b.take('bluesky');
      assert.equal(blocked.ok, false, 'the provider said none until its reset: the refill does not override it');
      assert.ok(blocked.waitMs > 100);
      assert.equal(await b.acquire('bluesky', { maxWaitMs: 50 }), false, 'not in time');
      await assert.rejects(() => a.take('unknown'), /no token bucket for unknown/);
    });

    run('a delivery is claimed once, until released or its TTL ends', async ({ deliveries }) => {
      const a = deliveries();
      const b = deliveries();
      const claims = await Promise.all([a.claim('72d3162e-cc78-11e3-81ab-4c9367dc0958'), b.claim('72d3162e-cc78-11e3-81ab-4c9367dc0958')]);
      assert.deepEqual(claims.sort(), [false, true], 'a redelivery racing the first is dropped');
      await a.release('72d3162e-cc78-11e3-81ab-4c9367dc0958');
      assert.equal(await b.claim('72d3162e-cc78-11e3-81ab-4c9367dc0958'), true, 'released after a failure, the redelivery is taken');
      await wait(1100);
      assert.equal(await a.claim('72d3162e-cc78-11e3-81ab-4c9367dc0958'), true, 'past its TTL it is new again');
    });
  });
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await wait(10);
  }
}

contract('memory', memoryPorts, false);
contract('Redis', () => redisPorts(testRedis()), redisSkip);

describe('Redis connections', { skip: redisSkip }, () => {
  test('a subscriber whose connection was killed reconnects, says so, and hears the next events', async () => {
    const redis = testRedis();
    const subscriberClient = redis.client('cache');
    const bus = new RedisEventBus(subscriberClient, { prefix: redis.prefix });
    const publisher = new RedisEventBus(redis.client('cache'), { prefix: redis.prefix });
    try {
      const seen: number[] = [];
      let reconnects = 0;
      bus.onReconnect(() => reconnects++);
      await bus.subscribe('launch.changed', (p) => seen.push(p.launchId));
      await publisher.publish('launch.changed', { launchId: 1 });
      await until(() => seen.length === 1);
      // Kill every pub/sub connection of this test, as a Redis restart or a network cut would
      const admin = redis.client();
      const clients = (await admin.client('LIST')) as string;
      for (const line of clients.split('\n')) {
        if (!line.includes('sub=1') || !line.includes('name=shipcast-test-events')) continue;
        const id = /id=(\d+)/.exec(line)?.[1];
        if (id) await admin.client('KILL', 'ID', id);
      }
      await until(() => reconnects === 1, 10_000);
      await publisher.publish('launch.changed', { launchId: 2 });
      await until(() => seen.length === 2, 5000);
      assert.deepEqual(seen, [1, 2]);
    } finally {
      await bus.close();
      await publisher.close();
      await redis.cleanup();
    }
  });

  test('each role gets its client options: BullMQ never fails a command on a reconnect, the cache gives up fast', () => {
    assert.equal(redisOptions('bullmq', 'w').maxRetriesPerRequest, null);
    assert.equal(redisOptions('cache', 'w').maxRetriesPerRequest, 1);
    assert.equal(redisOptions('queue', 'w').lazyConnect, true);
    assert.equal(redisOptions('queue', 'web').connectionName, 'shipcast-web');
  });
});

describe('the state the flags build', () => {
  test('off, every port is in memory; on without SHIPCAST_REDIS_QUEUE_URL, it refuses', () => {
    assert.equal(sharedState(new Flags(), undefined).backend, 'memory');
    assert.throws(() => sharedState(new Flags(['redis-state']), new RedisConnections(redisUrls({}))), /SHIPCAST_REDIS_QUEUE_URL/);
  });

  test('on, the ports are Redis’s, the cache on redis-cache and the rest on redis-queue', async () => {
    const connections = new RedisConnections(redisUrls({ SHIPCAST_REDIS_QUEUE_URL: 'redis://127.0.0.1:1/0', SHIPCAST_REDIS_CACHE_URL: 'redis://127.0.0.1:1/1' }));
    const state = sharedState(new Flags(['redis-state']), connections);
    assert.equal(state.backend, 'redis');
    assert.ok(state.cache instanceof RedisCache && state.lock instanceof RedisLock && state.oneTime instanceof RedisOneTimeStore);
    assert.notEqual(connections.cache, connections.queue);
    // Nothing connected: lazy clients make building the services free
    assert.equal(connections.queue.status, 'wait');
    await connections.close();
  });
});
