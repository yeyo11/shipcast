import type { JobState, Registry } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jobsPage, jobsView } from '../src/server/jobs.server.ts';

const ids = (view: { jobs: Array<{ id: string }> }) => view.jobs.map((j) => j.id);

/** Jobs recorded one after another, so newest first is the reverse of `states`; ids sort the same way on a tie */
async function seeded(states: readonly JobState[], launchId?: number): Promise<Registry> {
  const registry = await memoryRegistry();
  for (const [i, state] of states.entries()) {
    const id = `job-${String(i).padStart(4, '0')}`;
    await registry.recordJob({ id, queue: 'launch', title: `Job ${i}`, launchId: launchId ?? null });
    if (state !== 'created') await registry.updateJob(id, { state, ...(state === 'completed' || state === 'failed' ? { ended: true } : {}) });
  }
  return registry;
}

// 25 jobs: 3 failed, 2 active, the rest completed
const states: JobState[] = Array.from({ length: 25 }, (_, i) => (i < 3 ? 'failed' : i < 5 ? 'active' : 'completed'));

test('the work list is cut in pages of ten and counts every state', async () => {
  const registry = await seeded(states);
  const first = await jobsPage(registry, { page: 1, state: 'all' });
  assert.equal(first.jobs.length, 10);
  assert.equal(first.pageCount, 3);
  assert.deepEqual(first.counts, { all: 25, running: 2, failed: 3, done: 20 });
  assert.equal(ids(first)[0], 'job-0024', 'the newest first');
  const last = await jobsPage(registry, { page: 3, state: 'all' });
  assert.deepEqual(ids(last), ['job-0004', 'job-0003', 'job-0002', 'job-0001', 'job-0000']);
});

test('the work list is filtered by state before it is paged', async () => {
  const registry = await seeded(states);
  const failed = await jobsPage(registry, { page: 1, state: 'failed' });
  assert.equal(failed.total, 3);
  assert.equal(failed.pageCount, 1);
  assert.ok(failed.jobs.every((j) => j.state === 'failed'));
  const running = await jobsPage(registry, { page: 1, state: 'running' });
  assert.deepEqual(ids(running), ['job-0004', 'job-0003']);
});

test('a page that no longer exists falls back to the last one', async () => {
  const registry = await seeded(states);
  const view = await jobsPage(registry, { page: 9, state: 'done' });
  assert.equal(view.page, 2);
  assert.equal(view.jobs.length, 10);
});

test('a busy day is paged whole: no job is cut past a fixed number of rows', async () => {
  // More than the 200 the list used to read; the oldest of the day must still be on the last page
  const registry = await seeded(Array.from({ length: 215 }, () => 'completed' as const));
  const first = await jobsPage(registry, { page: 1, state: 'all' });
  assert.equal(first.counts.all, 215);
  assert.equal(first.pageCount, 22);
  const last = await jobsPage(registry, { page: 22, state: 'all' });
  assert.deepEqual(ids(last), ['job-0004', 'job-0003', 'job-0002', 'job-0001', 'job-0000']);
});

test('rounds that ended well and jobs that found automation off are neither listed nor counted', async () => {
  const registry = await seeded(['completed', 'failed']);
  await registry.recordJob({ id: 'round-ok', queue: 'round', title: 'Round' });
  await registry.updateJob('round-ok', { state: 'completed', ended: true });
  await registry.recordJob({ id: 'round-running', queue: 'round', title: 'Round' });
  await registry.updateJob('round-running', { state: 'active', started: true });
  await registry.recordJob({ id: 'off', queue: 'launch', title: 'Launch' });
  await registry.logJob('off', 'Automation is off: nothing to do');
  await registry.updateJob('off', { state: 'completed', ended: true });
  const view = await jobsPage(registry, { page: 1, state: 'all' });
  assert.deepEqual(ids(view), ['round-running', 'job-0001', 'job-0000']);
  assert.deepEqual(view.counts, { all: 3, running: 1, failed: 1, done: 1 });
});

test('a launch’s jobs are listed whenever they ran', async () => {
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.recordJob({ id: 'a', queue: 'draft', title: 'Drafting', launchId: launch.id });
  await registry.recordJob({ id: 'b', queue: 'draft', title: 'Other' });
  assert.deepEqual((await jobsView(registry, { launchId: launch.id })).map((j) => j.id), ['a']);
});
