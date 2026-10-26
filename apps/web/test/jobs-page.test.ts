import type { JobRecord, Registry } from '@shipcast/engine';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobsPage } from '../src/server/jobs.server.ts';

const job = (n: number, state: JobRecord['state']): JobRecord => ({
  id: String(n),
  queue: 'launch',
  title: `Job ${n}`,
  launchId: null,
  state,
  attempts: 1,
  log: [],
  link: null,
  createdAt: new Date(2026, 9, 1, 0, n).toISOString(),
  startedAt: null,
  endedAt: null,
});

// 25 jobs: 3 failed, 2 active, the rest completed
const states: JobRecord['state'][] = Array.from({ length: 25 }, (_, i) => (i < 3 ? 'failed' : i < 5 ? 'active' : 'completed'));
const registry = { jobs: async () => states.map((s, i) => job(i, s)) } as unknown as Registry;

test('the work list is cut in pages of ten and counts every state', async () => {
  const first = await jobsPage(registry, { page: 1, state: 'all' });
  assert.equal(first.jobs.length, 10);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(first.counts, { all: 25, running: 2, failed: 3, done: 20 });
  assert.equal((await jobsPage(registry, { page: 3, state: 'all' })).jobs.length, 5);
});

test('the work list is filtered by state before it is paged', async () => {
  const failed = await jobsPage(registry, { page: 1, state: 'failed' });
  assert.equal(failed.total, 3);
  assert.equal(failed.pageCount, 1);
  assert.ok(failed.jobs.every((j) => j.state === 'failed'));
});

test('a page that no longer exists falls back to the last one', async () => {
  const view = await jobsPage(registry, { page: 9, state: 'done' });
  assert.equal(view.page, 2);
  assert.equal(view.jobs.length, 10);
});
