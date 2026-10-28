import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecordingQueue } from '../../src/testing/queue.ts';

test('a send of a key still queued is refused, an upsert moves it, and only what waits is listed', async () => {
  const queue = new RecordingQueue();
  const first = await queue.send('publish', { launchId: 1 }, { singletonKey: 'launch:1' });
  assert.equal(first, 'job-1');
  assert.equal(await queue.send('publish', { launchId: 1 }, { singletonKey: 'launch:1' }), null);
  assert.equal(await queue.send('publish', { launchId: 2 }, { singletonKey: 'launch:2' }), 'job-2');
  await queue.upsert('scheduled', { postId: 5 }, { singletonKey: 'post:5', startAfter: new Date('2026-11-03T10:00:00Z') });
  await queue.upsert('scheduled', { postId: 5 }, { singletonKey: 'post:5', startAfter: new Date('2026-11-03T12:00:00Z') });
  assert.deepEqual(queue.waiting('scheduled').map((j) => j.options.startAfter), [new Date('2026-11-03T12:00:00Z')]);
  assert.deepEqual(await queue.queued('publish'), ['job-1', 'job-2']);
  assert.deepEqual(await queue.queued('publish', 'launch:2'), ['job-2']);
  await queue.schedule('comments', '*/30 * * * *', { reason: 'cron' });
  assert.equal(queue.schedules.length, 1);
  assert.throws(() => queue.registry, /without a registry/);
});
