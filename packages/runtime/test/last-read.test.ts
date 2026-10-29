import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Post } from '@shipcast/engine';
import { RecordingQueue } from '@shipcast/engine/testing';
import { armLastReads, type WorkQueue } from '../src/index.ts';

/*
 * An Instagram story's numbers last 24 hours: after a publish, its last read is queued for 23 h 30
 * min after it went out, one job per story, moved rather than doubled by arming again. Nothing else
 * is armed: a post, a story gone or failed, a story whose moment passed.
 */

const piece = (over: Partial<Post>): Post => ({
  id: 1,
  launchId: 4,
  channel: 'instagram',
  accountId: null,
  kind: 'story',
  externalId: 'ig-story',
  url: null,
  status: 'live',
  contentHash: null,
  scheduledAt: null,
  publishedAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...over,
});

test('a launch’s story gets its last read queued at 23 h 30 min; nothing else does', async () => {
  const recorder = new RecordingQueue();
  const queue = recorder as unknown as WorkQueue;
  const posts = [
    piece({ id: 1 }),
    piece({ id: 2, kind: 'post', externalId: 'ig-post' }),
    piece({ id: 3, status: 'deleted' }),
    piece({ id: 4, externalId: null, status: 'failed' }),
    piece({ id: 5, publishedAt: '2026-10-27T10:00:00.000Z' }),
  ];
  const registry = { posts: { posts: async () => posts } } as unknown as Parameters<typeof armLastReads>[1];
  const now = new Date('2026-10-29T10:05:00.000Z');

  assert.equal(await armLastReads(queue, registry, 4, now), 1);
  await armLastReads(queue, registry, 4, now);
  const waiting = recorder.waiting('metrics');
  assert.equal(waiting.length, 1, 'moved, not doubled');
  assert.deepEqual(waiting[0]?.data, { reason: 'last read', postId: 1 });
  assert.deepEqual(waiting[0]?.options, { singletonKey: 'last-read:1', startAfter: new Date('2026-10-30T09:30:00.000Z'), title: 'Last read of the instagram story', launchId: 4 });
});
