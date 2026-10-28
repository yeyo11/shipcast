import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobRecord } from '@shipcast/engine';
import { jobView } from '../src/server/jobs.server.ts';
import { laneOf } from '../src/server/launch-list.ts';
import { stateOf } from '../src/server/launches.server.ts';

test('a drafted launch with pieces out or scheduled is approved, not waiting for the owner', () => {
  const drafted = { status: 'drafted' as const };
  assert.deepEqual(stateOf(drafted, 0), { label: 'Waiting for you', tone: 'waiting' });
  // Approved: the blog is live and the other channels wait for their times
  const going = stateOf(drafted, 0, [{ status: 'live' }, { status: 'scheduled' }]);
  assert.deepEqual(going, { label: 'Going out', tone: 'published' });
  assert.equal(laneOf({ status: 'drafted', state: going }), 'out');
  assert.deepEqual(stateOf(drafted, 0, [{ status: 'scheduled' }]), { label: 'Scheduled', tone: 'published' });
  assert.deepEqual(stateOf(drafted, 1, [{ status: 'live' }]), { label: 'Partly published', tone: 'failed' });
});

test('a job waiting in the queue for its time is queued, not work in progress', () => {
  const job = (state: string, startedAt: string | null) =>
    ({ id: 'j', title: 'bluesky at 2026-10-28 14:00 UTC', state, log: [], link: null, startedAt, createdAt: '2026-10-27T22:38:00.000Z' }) as unknown as JobRecord;
  assert.equal(jobView(job('created', null)).queued, true);
  assert.equal(jobView(job('active', '2026-10-28T14:00:01.000Z')).queued, false);
  assert.equal(jobView(job('retry', '2026-10-28T14:00:01.000Z')).queued, false);
});
