import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { GitHubRest, PipelineDeps, Registry } from '@shipcast/engine';
import { clonePglite, connectPglite, registryOn } from '@shipcast/engine/testing';
import { MemoryStore, RetryLater, ROUND_KEY, scheduleRound, startWorking, WorkQueue, workHandlers, writeAutomation, type QueueOptions, type WorkDeps } from '../src/index.ts';

/*
 * The queue on PGlite: the real pg-boss and the real SQL in this process. Installing pg-boss's schema
 * takes seconds, so one instance gets the registry's migrations and pg-boss's schema, and every test
 * runs on a clone of it, as the registry's tests do.
 */

const quiet: QueueOptions = { schedule: false, supervise: false, pollingIntervalSeconds: 0.5, retryDelaySeconds: 1, onError: () => {} };

const template = (async () => {
  const { client, close } = await connectPglite();
  const queue = WorkQueue.pglite(client, await registryOn(client), quiet);
  await queue.start();
  await queue.stop();
  return { client, close };
})();

const queues: WorkQueue[] = [];
after(async () => {
  await Promise.all(queues.splice(0).map((q) => q.stop(1000)));
  await (await template).close();
});

/** A database with the registry and pg-boss in it, as a server holds them */
async function database(): Promise<{ client: PGlite; registry: Registry }> {
  const client = await clonePglite((await template).client);
  return { client, registry: await registryOn(client) };
}

/** A queue over a database: one per "process" */
function queueOn(db: { client: PGlite; registry: Registry }, options: QueueOptions = {}): WorkQueue {
  const queue = WorkQueue.pglite(db.client, db.registry, { ...quiet, ...options });
  queues.push(queue);
  return queue;
}

async function until(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// No handler under test reaches GitHub, the AI or the keychain
const deps = (registry: Registry): WorkDeps => ({
  env: {},
  registry,
  github: {} as unknown as GitHubRest,
  secrets: new MemoryStore(),
  pipeline: {} as unknown as PipelineDeps,
  brand: () => Promise.reject(new Error('no brand in these tests')),
});

async function launch(registry: Registry): Promise<number> {
  const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  return launch.id;
}

test('a job that cannot finish yet is tried again, and its row tells each attempt', async () => {
  const db = await database();
  const launchId = await launch(db.registry);
  const queue = queueOn(db);
  let attempts = 0;
  await queue.work({
    async publish(_data, job) {
      attempts++;
      job.link(`/launches/${launchId}`);
      if (job.attempt < 3) throw new RetryLater('the site has not deployed yet');
      job.log('devto: https://dev.to/x');
    },
  });
  const id = await queue.send('publish', { launchId }, { title: 'Publishing claudio v1.0.0', launchId, singletonKey: `launch:${launchId}` });
  assert.ok(id);
  const done = await queue.wait(id, 20_000, 100);
  assert.equal(done?.state, 'completed');
  assert.equal(attempts, 3);
  assert.equal(done?.attempts, 3);
  assert.equal(done?.link, `/launches/${launchId}`);
  assert.deepEqual(done?.log, ['Waiting: the site has not deployed yet', 'Waiting: the site has not deployed yet', 'devto: https://dev.to/x']);
  assert.equal(done?.launchId, launchId);
  assert.ok(done?.startedAt && done.endedAt);
});

test('a job that fails with no retries left is failed, with its error in the log', async () => {
  const db = await database();
  const queue = queueOn(db);
  await queue.work({
    async draft() {
      throw new Error('launch.yml is not valid');
    },
  });
  const id = await queue.send('draft', { launchId: await launch(db.registry) }, { title: 'Drafting' });
  const done = await queue.wait(id!, 20_000, 100);
  assert.equal(done?.state, 'failed');
  assert.equal(done?.attempts, 1, 'a draft costs an AI run: it is never repeated on its own');
  assert.deepEqual(done?.log, ['launch.yml is not valid']);
});

test('two processes share one round: one queued at most, never two running at once', async () => {
  const db = await database();
  const app = queueOn(db, { instanceName: 'app' });
  const watch = queueOn(db, { instanceName: 'watch' });
  // Both start and each asks for the next round, as the app and `shipcast watch` do
  const first = await scheduleRound(app, 'after a start', 60);
  const second = await scheduleRound(watch, 'after a start', 60);
  assert.equal(second, first, 'the second moves the round already queued');
  assert.equal(await app.send('round', { reason: 'polling' }, { singletonKey: ROUND_KEY, startAfter: 60 }), null, 'a plain send is refused');
  assert.deepEqual(await app.queued('round'), [first]);

  let running = 0;
  let most = 0;
  let runs = 0;
  const round = async () => {
    running++;
    most = Math.max(most, running);
    runs++;
    await new Promise((r) => setTimeout(r, 1500));
    running--;
  };
  await app.work({ round });
  await watch.work({ round });
  // Run it now, from both sides at once
  await Promise.all([scheduleRound(app, 'by hand'), scheduleRound(watch, 'by hand')]);
  await until(async () => runs >= 1 && running === 0);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(runs, 1);
  assert.equal(most, 1);
});

test('with automation off a round does nothing and sends no next one; a start sends none either', async () => {
  const db = await database();
  await writeAutomation(db.registry, { mode: 'off', intervalSeconds: 300 });
  const queue = queueOn(db);
  await startWorking(queue, deps(db.registry), { firstRoundInSeconds: 0 });
  assert.deepEqual(await queue.queued('round', ROUND_KEY), [], 'no round after a start while off');

  // A watchdog round, as the schedule sends it
  const id = await queue.send('round', { reason: 'watchdog' }, { singletonKey: ROUND_KEY });
  const done = await queue.wait(id!, 20_000, 100);
  assert.equal(done?.state, 'completed');
  assert.deepEqual(done?.log, ['Automation is off: no round']);
  assert.deepEqual(await queue.queued('round', ROUND_KEY), [], 'the chain stops');
  assert.equal(await db.registry.cursor('automation:last-round'), undefined, 'no round was run');

  const metrics = await queue.send('metrics', { reason: 'every 6 hours' });
  assert.deepEqual((await queue.wait(metrics!, 20_000, 100))?.log, ['Automation is off: the numbers are read by hand']);
});

test('a job sent before a restart runs after it, in the next process', async () => {
  const db = await database();
  const launchId = await launch(db.registry);
  const before = queueOn(db);
  const id = await before.send('draft', { launchId }, { title: 'Drafting claudio v1.0.0', launchId });
  assert.equal((await db.registry.job(id!))?.state, 'created');
  await before.stop();

  const afterRestart = queueOn(db);
  await afterRestart.work({
    async draft(data, job) {
      job.log(`drafting launch ${data.launchId}`);
    },
  });
  const done = await afterRestart.wait(id!, 20_000, 100);
  assert.equal(done?.state, 'completed');
  assert.equal(done?.title, 'Drafting claudio v1.0.0');
  assert.deepEqual(done?.log, [`drafting launch ${launchId}`]);
});

test('a row whose job the queue no longer has is not left running after a start', async () => {
  const db = await database();
  await db.registry.recordJob({ id: '00000000-0000-4000-8000-000000000000', queue: 'draft', title: 'Lost' });
  await db.registry.updateJob('00000000-0000-4000-8000-000000000000', { state: 'active', attempts: 1, started: true });
  await queueOn(db).start();
  const row = await db.registry.job('00000000-0000-4000-8000-000000000000');
  assert.equal(row?.state, 'failed');
  assert.deepEqual(row?.log, ['The queue no longer has this job']);
});

test('a launch left generating by a draft that was cut short is failed at a start, so it can be launched again', async () => {
  const db = await database();
  // The first process: one draft is cut short (its launch generating, its job gone), another is still
  // queued, waiting for a worker
  const first = queueOn(db);
  await first.start();
  const cut = await launch(db.registry);
  await db.registry.setStatus(cut, 'generating');
  const { launch: queued } = await db.registry.claim({ repo: 'yeyo11/shipcast', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  await first.send('draft', { launchId: queued.id }, { launchId: queued.id });
  await db.registry.setStatus(queued.id, 'generating');
  await first.stop(1000);

  await queueOn(db).start();
  const failed = await db.registry.get(cut);
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.detail ?? '', /interrupted/);
  assert.equal((await db.registry.get(queued.id))?.status, 'generating');
});

test('the handlers of a publish job retry a channel only once and leave a launch that is not drafted', async () => {
  const db = await database();
  const launchId = await launch(db.registry);
  const queue = queueOn(db);
  await db.registry.setCursor(`publish-failed:${launchId}:devto`, 'HTTP 500');
  await queue.work({ publish: workHandlers(queue, deps(db.registry)).publish });
  const id = await queue.send('publish', { launchId, retryChannel: 'devto' }, { launchId, singletonKey: `launch:${launchId}` });
  const done = await queue.wait(id!, 20_000, 100);
  assert.equal(done?.state, 'completed');
  assert.deepEqual(done?.log, ['Nothing to publish: the launch is detected']);
  assert.equal(await db.registry.cursor(`publish-failed:${launchId}:devto`), undefined, 'the failure is forgotten');
});
