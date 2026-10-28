import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Post } from '@shipcast/engine';
import { RecordingQueue } from '@shipcast/engine/testing';
import { armScheduled, type WorkQueue } from '../src/index.ts';

/*
 * Characterisation: how a scheduled piece's wake-up is queued today, before the round only enqueues
 * (docs/plans/performance-refactor.md, phase 2). One job per piece, keyed by the post, moved by an
 * upsert; a slot already past wakes it at once; a piece no longer scheduled queues nothing.
 */

const post = (over: Partial<Post> = {}): Post => ({
  id: 9,
  launchId: 4,
  channel: 'bluesky',
  accountId: null,
  kind: 'post',
  externalId: null,
  url: null,
  status: 'scheduled',
  contentHash: null,
  scheduledAt: '2099-01-01T09:00:00.000Z',
  publishedAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

test('a scheduled piece is armed once per post, moved by arming again, at once when its slot passed, and not at all once out', async () => {
  const recorder = new RecordingQueue();
  const queue = recorder as unknown as WorkQueue;

  await armScheduled(queue, post());
  await armScheduled(queue, post({ scheduledAt: '2099-01-02T09:00:00.000Z' }));
  const waiting = recorder.waiting('scheduled');
  assert.equal(waiting.length, 1, 'moved, not doubled');
  assert.deepEqual(waiting[0]?.data, { postId: 9, launchId: 4 });
  assert.deepEqual(waiting[0]?.options, { singletonKey: 'post:9', startAfter: new Date('2099-01-02T09:00:00.000Z'), title: 'bluesky at 2099-01-02 09:00 UTC', launchId: 4 });

  const before = Date.now();
  await armScheduled(queue, post({ id: 10, scheduledAt: '2020-01-01T00:00:00.000Z' }));
  const missed = recorder.waiting('scheduled').find((j) => j.options.singletonKey === 'post:10');
  assert.ok(missed?.options.startAfter instanceof Date && missed.options.startAfter.getTime() >= before, 'a slot missed wakes it now, not in the past');
  assert.equal(missed?.options.title, 'bluesky at 2020-01-01 00:00 UTC', 'the title keeps the slot asked for');

  assert.equal(await armScheduled(queue, post({ id: 11, status: 'live' })), null);
  assert.equal(await armScheduled(queue, post({ id: 12, scheduledAt: null })), null);
  assert.equal(recorder.jobs.length, 3);
});
