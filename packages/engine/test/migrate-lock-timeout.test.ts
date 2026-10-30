import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIGRATION_LOCK_TIMEOUT, retryOnLockTimeout } from '../src/db/connect.ts';

/*
 * The migrator waits at most MIGRATION_LOCK_TIMEOUT for a table's lock: a migration behind a long
 * transaction fails fast and is tried again a few times, instead of waiting with every query of the
 * app queued behind its own lock request.
 */

const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });

test('a lock timeout is retried, a bounded number of times, waiting longer each time', async () => {
  assert.match(MIGRATION_LOCK_TIMEOUT, /^\d+s$/);
  const waits: number[] = [];
  let runs = 0;
  const value = await retryOnLockTimeout(
    async () => {
      runs += 1;
      if (runs < 3) throw lockTimeout();
      return 'migrated';
    },
    { sleep: async (ms) => void waits.push(ms) },
  );
  assert.equal(value, 'migrated');
  assert.equal(runs, 3);
  assert.deepEqual(waits, [1000, 2000]);

  runs = 0;
  await assert.rejects(retryOnLockTimeout(async () => (runs++, Promise.reject(lockTimeout())), { attempts: 4, sleep: async () => {} }), /lock timeout/);
  assert.equal(runs, 4, 'given up after the last attempt, the error thrown on');
});

test('a lock timeout wrapped by the driver (as its cause) is recognised; any other error is thrown at once', async () => {
  let runs = 0;
  await retryOnLockTimeout(
    async () => {
      runs += 1;
      if (runs === 1) throw new Error('Failed query: ALTER TABLE …', { cause: lockTimeout() });
    },
    { sleep: async () => {} },
  );
  assert.equal(runs, 2);

  runs = 0;
  await assert.rejects(retryOnLockTimeout(async () => (runs++, Promise.reject(Object.assign(new Error('syntax error'), { code: '42601' }))), { sleep: async () => {} }), /syntax error/);
  assert.equal(runs, 1);
});
