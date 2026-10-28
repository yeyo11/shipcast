import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import type { PGlite } from '@electric-sql/pglite';
import type { Registry } from '@shipcast/engine';
import { clonePglite, connectPglite, registryOn } from '@shipcast/engine/testing';
import { Queue } from 'bullmq';
import { BullQueue, drainPgBoss } from '../src/queue-bullmq.ts';
import { jobQueue } from '../src/queue-factory.ts';
import { Flags } from '../src/flags.ts';
import { currentOrigin, LOST_RUNNING, RetryLater, TelemetryRecorder, WorkQueue, type JobQueue, type QueueName } from '../src/index.ts';
import { RedisConnections, RedisLock, redisUrls } from '../src/redis/index.ts';
import { redisSkip, TEST_REDIS_URL, testRedis, type TestRedis } from './redis-helper.ts';

/*
 * One contract for the durable work, run against pg-boss (WorkQueue, on PGlite, as queue.test.ts
 * does) and BullMQ (BullQueue, on the throwaway Redis): retries, the rows of the `jobs` table, the
 * telemetry, stately keys, upsert, delays, restarts and stops behave the same on both, so the
 * `bullmq` flag changes where jobs wait and nothing else. What only BullMQ has (stalls, schedulers
 * in Redis, rebuilding the scheduled posts after Redis is lost) is tested after the contract, and
 * the pg-boss cutover's drain at the end.
 */

const template = (async () => {
  const { client, close } = await connectPglite();
  const queue = WorkQueue.pglite(client, await registryOn(client), { schedule: false, supervise: false, onError: () => {} });
  await queue.start();
  await queue.stop();
  return { client, close };
})();

after(async () => (await template).close());

interface Db {
  client: PGlite;
  registry: Registry;
}

async function database(): Promise<Db> {
  const client = await clonePglite((await template).client);
  return { client, registry: await registryOn(client) };
}

interface ProcessOptions {
  telemetry?: TelemetryRecorder;
  lockSeconds?: number;
}

/** A backend for one test: `process` makes one more "process" on the same database (and Redis) */
interface Backend {
  process(db: Db, options?: ProcessOptions): JobQueue;
  cleanup(): Promise<void>;
}

function pgBoss(): Backend {
  const queues: JobQueue[] = [];
  return {
    process(db, options = {}) {
      const queue = WorkQueue.pglite(db.client, db.registry, { schedule: false, supervise: false, pollingIntervalSeconds: 0.5, retryDelaySeconds: 1, onError: () => {}, ...(options.telemetry && { telemetry: options.telemetry }) });
      queues.push(queue);
      return queue;
    },
    async cleanup() {
      await Promise.all(queues.map((q) => q.stop(1000)));
    },
  };
}

function bullmq(redis: TestRedis = testRedis()): Backend & { redis: TestRedis; doomed(queue: QueueName): Promise<{ started(): string | undefined; kill(): Promise<void> }> } {
  const queues: JobQueue[] = [];
  // A child left alive by a failed test would keep this file from ever exiting
  const children: ChildProcess[] = [];
  return {
    redis,
    /**
     * A worker of `queue` in a child process, killed with SIGKILL once it has taken a job: what a
     * crashed process leaves in Redis, a job active under a lock nobody renews
     */
    async doomed(queue) {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./doomed-worker.ts', import.meta.url)), TEST_REDIS_URL, redis.prefix, queue], { stdio: ['ignore', 'pipe', 'inherit'] });
      children.push(child);
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => void (out += chunk.toString()));
      await until(() => out.includes('ready'), 30_000);
      return {
        started: () => /started (\S+)/.exec(out)?.[1],
        kill: async () => {
          const exited = new Promise((r) => child.once('exit', r));
          child.kill('SIGKILL');
          await exited;
        },
      };
    },
    process(db, options = {}) {
      const queue = new BullQueue(redis.client('queue'), () => redis.client('bullmq'), db.registry, {
        prefix: redis.prefix,
        retryDelaySeconds: 1,
        lockSeconds: options.lockSeconds ?? 5,
        deferMs: 200,
        onError: () => {},
        ...(options.telemetry && { telemetry: options.telemetry }),
      });
      queues.push(queue);
      return queue;
    },
    async cleanup() {
      for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
      await Promise.all(queues.map((q) => q.stop(1000)));
      await redis.cleanup();
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(50);
  }
}

async function launch(registry: Registry): Promise<number> {
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  return launch.id;
}

/** Counts how many handlers run at once */
function overlap() {
  const state = { running: 0, most: 0, runs: 0 };
  return {
    state,
    async run(ms: number) {
      state.running++;
      state.most = Math.max(state.most, state.running);
      state.runs++;
      await sleep(ms);
      state.running--;
    },
  };
}

function contract(name: string, make: () => Backend, skip: false | string) {
  describe(`the job queue on ${name}`, { skip }, () => {
    const run = (title: string, fn: (backend: Backend, db: Db) => Promise<void>) =>
      test(title, { timeout: 60_000 }, async () => {
        const backend = make();
        try {
          await fn(backend, await database());
        } finally {
          await backend.cleanup();
        }
      });

    run('a job that cannot finish yet is tried again, and its row tells each attempt', async (backend, db) => {
      const launchId = await launch(db.registry);
      const queue = backend.process(db);
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
      assert.equal(done?.title, 'Publishing claudio v1.0.0');
      assert.equal(done?.link, `/launches/${launchId}`);
      assert.deepEqual(done?.log, ['Waiting: the site has not deployed yet', 'Waiting: the site has not deployed yet', 'devto: https://dev.to/x']);
      assert.ok(done?.startedAt && done.endedAt);
    });

    run('each attempt is timed, its wait counted, and its work runs under the job’s origin', async (backend, db) => {
      const launchId = await launch(db.registry);
      const timings: Array<{ kind: string; outcome: string }> = [];
      const telemetry = new TelemetryRecorder({ process: 'test', store: () => undefined });
      telemetry.timing = (sample) => void timings.push({ kind: sample.kind, outcome: sample.outcome });
      const queue = backend.process(db, { telemetry });
      const origins: string[] = [];
      await queue.work({
        async publish(_data, job) {
          origins.push(currentOrigin().name);
          if (job.attempt < 2) throw new RetryLater('not yet');
        },
      });
      const id = await queue.send('publish', { launchId }, { launchId, singletonKey: `launch:${launchId}` });
      assert.equal((await queue.wait(id!, 20_000, 100))?.state, 'completed');
      assert.deepEqual(origins, ['job:publish', 'job:publish']);
      assert.deepEqual(
        timings.filter((t) => t.kind === 'job').map((t) => t.outcome),
        ['retry', 'ok'],
      );
      assert.equal(timings.filter((t) => t.kind === 'job-wait').length, 2);
    });

    run('a job that fails with no retries left is failed, with its error in the log', async (backend, db) => {
      const queue = backend.process(db);
      let runs = 0;
      await queue.work({
        async draft() {
          runs++;
          throw new Error('launch.yml is not valid');
        },
      });
      const id = await queue.send('draft', { launchId: await launch(db.registry) }, { title: 'Drafting' });
      const done = await queue.wait(id!, 20_000, 100);
      assert.equal(done?.state, 'failed');
      assert.equal(done?.attempts, 1);
      assert.deepEqual(done?.log, ['launch.yml is not valid']);
      await sleep(1500);
      assert.equal(runs, 1, 'a draft costs an AI run: it is never repeated on its own');
    });

    run('stately: of many sends of one key at once, one is queued and the others are refused', async (backend, db) => {
      const a = backend.process(db);
      const b = backend.process(db);
      const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).send('round', { reason: `send ${i}` }, { singletonKey: 'round', startAfter: 60 })));
      const sent = ids.filter((id) => id !== null);
      assert.equal(sent.length, 1, `one queued, not ${sent.length}`);
      assert.deepEqual(await a.queued('round', 'round'), sent);
      assert.deepEqual(await b.queued('round'), sent);
      assert.equal(await a.send('round', { reason: 'other key' }, { singletonKey: 'other', startAfter: 60 }) !== null, true, 'another key is its own');
      // A stately queue without a key is one key, '' (pg-boss's COALESCE): one metrics run queued at most
      assert.ok(await a.send('metrics', { reason: 'by hand' }, { startAfter: 60 }));
      assert.equal(await b.send('metrics', { reason: 'by hand' }, { startAfter: 60 }), null);
    });

    run('stately: one may wait while one runs, a third is refused, and the two never run at once', async (backend, db) => {
      const a = backend.process(db);
      const b = backend.process(db);
      const seen = overlap();
      const order: string[] = [];
      const comments = async (data: { reason: string }) => {
        order.push(data.reason);
        await seen.run(data.reason === 'first' ? 1500 : 200);
      };
      // Two processes, two workers each: only the key keeps them apart
      await a.work({ comments });
      await b.work({ comments });
      const first = await a.send('comments', { reason: 'first' }, { singletonKey: 'comments' });
      assert.ok(first);
      await until(() => seen.state.running === 1);
      const second = await b.send('comments', { reason: 'second' }, { singletonKey: 'comments' });
      assert.ok(second, 'one may wait while one runs');
      assert.equal(await a.send('comments', { reason: 'third' }, { singletonKey: 'comments' }), null, 'but only one');
      assert.equal((await b.wait(second, 20_000, 100))?.state, 'completed');
      assert.equal(seen.state.most, 1, 'never two of a key at once');
      assert.deepEqual(order, ['first', 'second']);
    });

    run('stately: a failed attempt may retry while another job of its key waits', async (backend, db) => {
      const queue = backend.process(db);
      const seen = overlap();
      const attempts: string[] = [];
      await queue.work({
        async metrics(data, job) {
          attempts.push(`${data.reason}#${job.attempt}`);
          await seen.run(300);
          if (data.reason === 'first' && job.attempt === 1) throw new Error('the network said 503');
        },
      });
      const first = await queue.send('metrics', { reason: 'first' }, { singletonKey: 'k' });
      await until(() => seen.state.running === 1);
      const second = await queue.send('metrics', { reason: 'second' }, { singletonKey: 'k' });
      assert.ok(second);
      assert.equal((await queue.wait(first!, 20_000, 100))?.state, 'completed');
      assert.equal((await queue.wait(second, 20_000, 100))?.state, 'completed');
      assert.deepEqual([...attempts].sort(), ['first#1', 'first#2', 'second#1']);
      assert.equal(seen.state.most, 1);
    });

    run('upsert moves the queued job of a key, keeping its id, or sends one', async (backend, db) => {
      const queue = backend.process(db);
      const sent = await queue.upsert('round', { reason: 'polling' }, { singletonKey: 'round', startAfter: 60, title: 'Automation round' });
      assert.ok(sent);
      assert.equal(await queue.upsert('round', { reason: 'later' }, { singletonKey: 'round', startAfter: 120 }), sent, 'moved, not added');
      assert.deepEqual(await queue.queued('round', 'round'), [sent]);
      const reasons: string[] = [];
      await queue.work({
        async round(data) {
          reasons.push(data.reason);
        },
      });
      await sleep(1500);
      assert.equal(reasons.length, 0, 'still waiting for its time');
      assert.equal(await queue.upsert('round', { reason: 'by hand' }, { singletonKey: 'round', title: 'Automation round, by hand' }), sent, 'run now: the same job');
      const done = await queue.wait(sent, 20_000, 100);
      assert.equal(done?.state, 'completed');
      assert.equal(done?.title, 'Automation round, by hand');
      assert.deepEqual(reasons, ['by hand'], 'once, with the latest data');
      const next = await queue.upsert('round', { reason: 'next' }, { singletonKey: 'round', startAfter: 60 });
      assert.ok(next && next !== sent, 'with none queued, a new one is sent');
    });

    run('a waiting job given a later time by upsert waits for it', async (backend, db) => {
      const queue = backend.process(db);
      const now = await queue.upsert('round', { reason: 'now' }, { singletonKey: 'round' });
      assert.equal(await queue.upsert('round', { reason: 'later' }, { singletonKey: 'round', startAfter: 60 }), now);
      let runs = 0;
      await queue.work({
        async round() {
          runs++;
        },
      });
      await sleep(1500);
      assert.equal(runs, 0);
      assert.deepEqual(await queue.queued('round', 'round'), [now]);
    });

    run('two processes asking for a round at once run it once', async (backend, db) => {
      const app = backend.process(db);
      const watch = backend.process(db);
      const seen = overlap();
      const queued = await app.upsert('round', { reason: 'after a start' }, { singletonKey: 'round', startAfter: 60 });
      // "Run it now" from both sides at once: the round already queued is moved, never a second one
      // added. (Once a worker has taken it, a later "run now" is a new round, after it, on both queues.)
      const ids = await Promise.all([app.upsert('round', { reason: 'by hand' }, { singletonKey: 'round' }), watch.upsert('round', { reason: 'by hand' }, { singletonKey: 'round' })]);
      assert.deepEqual(ids, [queued, queued], 'one job, the one queued');
      await app.work({ round: () => seen.run(1000) });
      await watch.work({ round: () => seen.run(1000) });
      await until(() => seen.state.runs >= 1 && seen.state.running === 0);
      await sleep(1000);
      assert.equal(seen.state.runs, 1);
    });

    run('a delayed job runs at its time, not before', async (backend, db) => {
      const queue = backend.process(db);
      let ranAt = 0;
      await queue.work({
        async scheduled() {
          ranAt = Date.now();
        },
      });
      const sentAt = Date.now();
      const id = await queue.upsert('scheduled', { postId: 1, launchId: 1 }, { singletonKey: 'post:1', startAfter: new Date(sentAt + 2000) });
      assert.equal((await queue.wait(id!, 20_000, 100))?.state, 'completed');
      assert.ok(ranAt - sentAt >= 1900, `ran ${ranAt - sentAt} ms after it was sent`);
    });

    run('a job sent before a restart runs after it, in the next process', async (backend, db) => {
      const launchId = await launch(db.registry);
      const before = backend.process(db);
      const id = await before.send('draft', { launchId }, { title: 'Drafting claudio v1.0.0', launchId });
      assert.equal((await db.registry.job(id!))?.state, 'created');
      await before.stop();
      const afterRestart = backend.process(db);
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

    run('a row whose job the queue no longer has is not left running after a start', async (backend, db) => {
      await db.registry.recordJob({ id: '00000000-0000-4000-8000-000000000000', queue: 'draft', title: 'Lost' });
      await db.registry.updateJob('00000000-0000-4000-8000-000000000000', { state: 'active', attempts: 1, started: true });
      await backend.process(db).start();
      const row = await db.registry.job('00000000-0000-4000-8000-000000000000');
      assert.equal(row?.state, 'failed');
      assert.deepEqual(row?.log, [LOST_RUNNING]);
    });

    run('a graceful stop lets the running job finish', async (backend, db) => {
      const queue = backend.process(db);
      let started = false;
      await queue.work({
        async snapshots(_data, job) {
          started = true;
          await sleep(800);
          job.log('synced');
        },
      });
      const id = await queue.send('snapshots', { reason: 'by hand' });
      await until(() => started);
      await queue.stop(10_000);
      const row = await db.registry.job(id!);
      assert.equal(row?.state, 'completed');
      assert.deepEqual(row?.log, ['synced']);
    });
  });
}

contract('pg-boss', pgBoss, false);
contract('BullMQ', () => bullmq(), redisSkip);

describe('BullMQ beyond the contract', { skip: redisSkip }, () => {
  const run = (title: string, fn: (backend: ReturnType<typeof bullmq>, db: Db) => Promise<void>) =>
    test(title, { timeout: 60_000 }, async () => {
      const backend = bullmq();
      try {
        await fn(backend, await database());
      } finally {
        await backend.cleanup();
      }
    });

  run('a worker killed mid-job: the job is tried again once its lock lapses, never twice at once', async (backend, db) => {
    const dying = await backend.doomed('delivery');
    const id = await backend.process(db).send('delivery', { action: { kind: 'claim' } as never, delivery: 'd-1' });
    await until(() => dying.started() === id);
    const killedAt = Date.now();
    await dying.kill();

    const next = backend.process(db, { lockSeconds: 1 });
    let secondStarted = 0;
    await next.work({
      async delivery(_data, job) {
        secondStarted = Date.now();
        job.log(`attempt ${job.attempt}`);
      },
    });
    const done = await next.wait(id!, 30_000, 100);
    assert.equal(done?.state, 'completed');
    assert.equal(done?.attempts, 2, 'the stall counted as an attempt');
    assert.deepEqual(done?.log, ['Tried again: the process running it stopped', 'attempt 2']);
    assert.ok(secondStarted - killedAt >= 500, `the second run waited for the dead one's lock: ${secondStarted - killedAt} ms`);
  });

  run('a draft whose worker was killed is failed, not drafted again behind the owner’s back', async (backend, db) => {
    const dying = await backend.doomed('draft');
    const id = await backend.process(db).send('draft', { launchId: await launch(db.registry) });
    await until(() => dying.started() === id);
    await dying.kill();
    const next = backend.process(db, { lockSeconds: 1 });
    let again = false;
    await next.work({
      async draft() {
        again = true;
      },
    });
    const done = await next.wait(id!, 30_000, 100);
    assert.equal(done?.state, 'failed');
    assert.deepEqual(done?.log, ['The process running it stopped, and it has no attempts left']);
    assert.equal(again, false);
  });

  run('crons are job schedulers: two processes scheduling the same cron make one, and its jobs keep the key', async (backend, db) => {
    const app = backend.process(db);
    const watch = backend.process(db);
    await Promise.all([app.schedule('round', '* * * * * *', { reason: 'watchdog' }, { singletonKey: 'round' }), watch.schedule('round', '* * * * * *', { reason: 'watchdog' }, { singletonKey: 'round' })]);
    await app.schedule('metrics', '0 */6 * * *', { reason: 'every 6 hours' });
    const inspect = new Queue('round', { connection: backend.redis.client('bullmq'), prefix: `${backend.redis.prefix}bull` });
    try {
      assert.equal((await inspect.getJobSchedulers()).length, 1, 'one schedule for the round');
      // A round queued by hand for later: the watchdog's occurrences are dropped while it waits
      const queued = await app.upsert('round', { reason: 'polling' }, { singletonKey: 'round', startAfter: 60 });
      const reasons: string[] = [];
      await app.work({
        async round(data) {
          reasons.push(data.reason);
        },
      });
      await sleep(2500);
      assert.equal(reasons.length, 0, 'dropped: a round is already queued');
      assert.deepEqual(await app.queued('round', 'round'), [queued]);
      await app.upsert('round', { reason: 'by hand' }, { singletonKey: 'round' });
      await until(() => reasons.includes('by hand'));
      // The chain has none queued now, so the next occurrence runs
      await until(() => reasons.includes('watchdog'), 5000);
    } finally {
      await inspect.close();
    }
  });

  run('Redis lost: the scheduled posts are rebuilt from Postgres, once however often it runs', async (backend, db) => {
    const launchId = await launch(db.registry);
    await db.registry.launches.setStatus(launchId, 'drafted', 'https://github.com/yeyo11/launches/pull/7');
    const soon = (await db.registry.posts.schedulePost(launchId, 'bluesky', new Date(Date.now() + 1500)))!;
    const later = (await db.registry.posts.schedulePost(launchId, 'mastodon', new Date(Date.now() + 3600_000)))!;
    const first = backend.process(db) as BullQueue;
    assert.equal(await first.reconcileScheduled(), 2);
    await first.stop();
    // Everything in Redis is gone, as after a flush or a fresh instance
    await backend.redis.cleanup();
    const queue = backend.process(db) as BullQueue;
    // Two processes at once (the start of two replicas): the lock lets one in at a time
    const held = await new RedisLock(backend.redis.client(), { prefix: backend.redis.prefix }).acquire('reconcile:scheduled', 5000);
    assert.equal(await queue.reconcileScheduled(), undefined, 'another process holds it: this one skips');
    await held?.release();
    await Promise.all([queue.reconcileScheduled(), (backend.process(db) as BullQueue).reconcileScheduled()]);
    assert.equal(await queue.reconcileScheduled(), 2, 'again: the same jobs moved, none added');
    assert.equal((await queue.queued('scheduled', `post:${soon.id}`)).length, 1);
    assert.equal((await queue.queued('scheduled', `post:${later.id}`)).length, 1);
    const woke: number[] = [];
    await queue.work({
      async scheduled(data) {
        woke.push(data.postId);
      },
    });
    await until(() => woke.length === 1, 10_000);
    assert.deepEqual(woke, [soon.id]);
  });
});

describe('the cutover from pg-boss', () => {
  test('drainPgBoss reports what pg-boss holds, and waits only for what nothing rebuilds', async () => {
    const db = await database();
    const queue = WorkQueue.pglite(db.client, db.registry, { schedule: false, supervise: false, pollingIntervalSeconds: 0.5, onError: () => {} });
    try {
      await queue.send('draft', { launchId: await launch(db.registry) });
      await queue.upsert('scheduled', { postId: 1, launchId: 1 }, { singletonKey: 'post:1', startAfter: 3600 });
      await queue.upsert('round', { reason: 'polling' }, { singletonKey: 'round', startAfter: 300 });
      const before = await drainPgBoss(queue);
      assert.deepEqual(before.blocking, ['draft']);
      assert.equal(before.drained, false);
      assert.deepEqual(before.held.scheduled, { queued: 1, active: 0 });
      await queue.work({ async draft() {} });
      const after = await drainPgBoss(queue, { timeoutMs: 20_000, everyMs: 200 });
      assert.equal(after.drained, true, 'the scheduled post and the round are rebuilt from Postgres by BullMQ');
      assert.deepEqual(after.held.draft, { queued: 0, active: 0 });
    } finally {
      await queue.stop(1000);
    }
  });

  test('the bullmq flag picks the queue: off pg-boss, on BullMQ on redis-queue, which it needs', async () => {
    const { registry } = await database();
    const url = 'postgres://nobody@127.0.0.1:1/none';
    // Nothing connects until a queue starts, so building either is free
    assert.ok(jobQueue({ flags: new Flags(), registry, databaseUrl: url }) instanceof WorkQueue);
    const redis = new RedisConnections(redisUrls({ SHIPCAST_REDIS_QUEUE_URL: 'redis://127.0.0.1:1' }));
    assert.ok(jobQueue({ flags: new Flags(['bullmq']), registry, databaseUrl: url, redis }) instanceof BullQueue);
    assert.throws(() => jobQueue({ flags: new Flags(['bullmq']), registry, databaseUrl: url }), /SHIPCAST_REDIS_QUEUE_URL/);
    await redis.close();
  });
});
