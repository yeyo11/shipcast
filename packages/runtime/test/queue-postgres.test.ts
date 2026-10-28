import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectRepositories } from '@shipcast/engine';
import { WorkQueue } from '../src/index.ts';

/*
 * The queue on a real Postgres server, through pg-boss's own pool as the app runs it. Only with
 * SHIPCAST_TEST_DATABASE_URL set, to a database the test may write to (never the live one), e.g.
 * a throwaway container:
 *
 *   docker run --rm -d --name shipcast-pg-test -p 127.0.0.1:5499:5432 -e POSTGRES_PASSWORD=x postgres:17
 *   SHIPCAST_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:5499/postgres pnpm --filter @shipcast/runtime test
 */
const url = process.env.SHIPCAST_TEST_DATABASE_URL;

test('on Postgres, pg-boss installs its schema and a job sent before a restart runs after it', { skip: !url && 'SHIPCAST_TEST_DATABASE_URL is not set' }, async () => {
  const registry = await connectRepositories(url!);
  try {
    const before = WorkQueue.postgres(url!, registry, { instanceName: 'test-before', schedule: false, pollingIntervalSeconds: 0.5 });
    const id = await before.send('metrics', { reason: 'by hand' }, { title: 'A reading for the test', singletonKey: `test-${Date.now()}` });
    assert.ok(id);
    await before.stop();

    const afterRestart = WorkQueue.postgres(url!, registry, { instanceName: 'test-after', schedule: false, pollingIntervalSeconds: 0.5 });
    try {
      await afterRestart.work({
        async metrics(_data, job) {
          job.log('read');
        },
      });
      const done = await afterRestart.wait(id, 30_000, 200);
      assert.equal(done?.state, 'completed');
      assert.deepEqual(done?.log, ['read']);
    } finally {
      await afterRestart.stop();
    }
  } finally {
    await registry.close();
  }
});
