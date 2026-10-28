import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { redisOptions, type RedisRole } from '../src/redis/index.ts';

/*
 * The throwaway Redis the Redis tests run on: SHIPCAST_TEST_REDIS_URL, or a local container on 6390
 *
 *   docker run -d --rm --name shipcast-test-redis -p 127.0.0.1:6390:6379 redis:7-alpine
 *
 * (CI runs one as a service). Without it the tests are skipped, never failed. Each test writes under
 * a prefix of its own and removes its keys at the end, so runs and tests never see each other's.
 */
export const TEST_REDIS_URL = process.env.SHIPCAST_TEST_REDIS_URL || 'redis://127.0.0.1:6390';

async function reachable(): Promise<boolean> {
  const probe = new Redis(TEST_REDIS_URL, { lazyConnect: true, connectTimeout: 1000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

/** false when there is a Redis to test on; otherwise the reason the Redis tests are skipped */
export const redisSkip: false | string = (await reachable()) ? false : `no test Redis at ${TEST_REDIS_URL} (set SHIPCAST_TEST_REDIS_URL, or run redis:7-alpine on 127.0.0.1:6390)`;

export interface TestRedis {
  prefix: string;
  /** A new client, closed by cleanup */
  client(role?: RedisRole): Redis;
  /** Removes every key under the prefix and closes the clients */
  cleanup(): Promise<void>;
}

export function testRedis(): TestRedis {
  const prefix = `test:${randomUUID()}:`;
  const clients: Redis[] = [];
  const client = (role: RedisRole = 'queue') => {
    const c = new Redis(TEST_REDIS_URL, redisOptions(role, 'test'));
    c.on('error', () => undefined);
    clients.push(c);
    return c;
  };
  return {
    prefix,
    client,
    async cleanup() {
      const sweeper = client();
      let cursor = '0';
      do {
        const [next, keys] = await sweeper.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
        cursor = next;
        if (keys.length > 0) await sweeper.del(...keys);
      } while (cursor !== '0');
      await Promise.all(clients.splice(0).map((c) => c.quit().catch(() => c.disconnect())));
    },
  };
}
