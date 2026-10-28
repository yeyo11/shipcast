import { randomUUID } from 'node:crypto';
import type { JobRecord, Registry } from '@shipcast/engine';
import { DelayedError, Queue, UnrecoverableError, Worker, type Job, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE_NAMES, QUEUES, reconcileRows, runJob, waitForJob, type Handler, type Handlers, type HeldCounts, type HeldJob, type JobData, type JobQueue, type QueueName, type SendOptions, type WorkQueue } from './queue.ts';
import { RedisLock } from './redis/adapters.ts';
import { Script, type RedisConnections } from './redis/connection.ts';
import type { Lock } from './redis/ports.ts';
import { DEFAULT_PREFIX, sleep } from './redis/shared.ts';
import type { TelemetryRecorder } from './telemetry/recorder.ts';
import { armScheduled } from './work.ts';

/*
 * The durable work on BullMQ, on redis-queue (noeviction, AOF), behind the `bullmq` flag: the same
 * JobQueue as WorkQueue (pg-boss), held to the same semantics by test/queue-contract.test.ts.
 * Postgres stays the truth: the `jobs` rows are the audit, written by the same runJob wrapper, and
 * what Redis loses is rebuilt from Postgres (the scheduled posts by reconcileScheduled, the round
 * chain and the crons by startWorking). See docs/plans/performance-refactor.md, "Queues on BullMQ".
 *
 * How pg-boss's behaviour maps onto BullMQ:
 *
 * - **Job ids** are UUIDs chosen here, as pg-boss's are, so a `jobs` row reads the same on both. The
 *   BullMQ job's *name* is its singleton key ('' for none), which is how a key is found again.
 * - **stately** is pg-boss's unique index on (queue, state, key) for the states created, retry and
 *   active: at most one job of a key in each. BullMQ's own dedupe (`jobId`, `deduplication`) blocks a
 *   key for as long as a job of it exists, so it cannot allow "one waiting while one runs". Instead
 *   each (queue, key) has three slots on redis-queue, each holding a job id:
 *   - `created`: set by send/upsert under a per-key lock, after checking that the job it names is
 *     really still waiting (a stale slot, whose job started or vanished, is overwritten). A second
 *     send while it holds a waiting job is refused (null), as pg-boss's insert is.
 *   - `active`: taken by a job when it starts (SET if empty or already its own, with the lock's TTL,
 *     renewed while it runs). A job that finds another job of its key running is put back as delayed
 *     for a moment (moveToDelayed + DelayedError, which costs no attempt), keeping its `created`
 *     slot: pg-boss's fetch likewise skips a key that has a job active. Once it holds `active`, it
 *     frees its `created` (or `retry`) slot, compare-and-delete, so the next send is accepted.
 *   - `retry`: a failed attempt with retries left takes it before BullMQ backs it off; if another
 *     job of the key is already retrying, this one fails for good, as pg-boss drops a retry that
 *     would break its index.
 *   A job a cron scheduler made never went through send, so on start it adopts the `created` slot,
 *   or is dropped (no row, nothing run) when another job of its key is waiting: the watchdog round
 *   is dropped while the chain has one queued.
 * - **upsert** moves the job in the `created` slot: new data, and its delay changed (a delayed job),
 *   promoted (due now), or removed and re-added under the same id (a waiting job given a later time),
 *   so its row and id stay; with none waiting it sends one.
 * - **crons** are job schedulers whose id is the queue's name: upsertJobScheduler is idempotent, so
 *   every process scheduling the same cron makes one schedule, and scheduling again replaces it.
 * - **retries** are BullMQ attempts with a fixed backoff of the queue's delay. The attempt number is
 *   attemptsMade + stalledCounter + 1: a stall counts as an attempt, as a pg-boss expiry does, and
 *   the last one is decided here (UnrecoverableError), never left to BullMQ's own count.
 * - **expiry** (expireInSeconds) has two halves. A process that dies stops renewing the BullMQ lock
 *   (lockSeconds, 30 s): the stalled check hands the job to another worker, which counts the attempt
 *   and fails it if none are left; a draft is never re-run behind the owner's back. A handler still
 *   running past expireInSeconds is failed (its signal aborted), as pg-boss fails it.
 * - **graceful stop** closes the workers, waiting for the running jobs up to the timeout; then their
 *   signals abort and the workers close by force, the jobs stay active and stall to another process.
 */

/** The data a BullMQ job carries: the queue's own, and when it was due, for the job-wait timing */
interface Envelope<Q extends QueueName> {
  data: JobData[Q];
  /** Milliseconds since the epoch when it may first start */
  at: number;
}

type Slot = 'created' | 'retry' | 'active';

export interface BullQueueOptions {
  /** The prefix of every key, BullMQ's and the slots'; tests give each run its own */
  prefix?: string;
  /** A name for this process's connections: `web`, `worker` */
  instanceName?: string;
  /** Where errors of the workers and queues go; they never reach the caller */
  onError?: (error: Error) => void;
  /** Seconds between any queue's attempts instead of its own: tests make the waits short */
  retryDelaySeconds?: number;
  /** How long a job's BullMQ lock lives unrenewed: what a crashed process costs before its job moves on */
  lockSeconds?: number;
  /** How long a job waits before trying again when another job of its key is running */
  deferMs?: number;
  telemetry?: TelemetryRecorder;
}

/** Waiting, in BullMQ's words: what a `created` or `retry` slot may name */
const WAITING = new Set(['waiting', 'delayed', 'prioritized', 'waiting-children', 'wait', 'paused']);

const TAKE_ACTIVE = new Script(`
local v = redis.call('GET', KEYS[1])
if (not v) or v == ARGV[1] then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0
`);
const RELEASE_SLOT = new Script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`);
const RENEW_SLOT = new Script(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0
`);

const WEEK_SECONDS = 7 * 24 * 3600;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The registry's state of a BullMQ job; undefined when BullMQ no longer has it */
function heldOf(state: string, job: Job | undefined): HeldJob | undefined {
  if (!job || state === 'unknown') return undefined;
  const retryCount = job.attemptsMade + job.stalledCounter;
  if (state === 'active') return { state: 'active', retryCount };
  if (state === 'completed') return { state: 'completed', retryCount };
  if (state === 'failed') return { state: 'failed', retryCount };
  return { state: retryCount > 0 ? 'retry' : 'created', retryCount };
}

export class BullQueue implements JobQueue {
  readonly #redis: Redis;
  readonly #connect: (suffix: string) => Redis;
  readonly #registry: Registry;
  readonly #prefix: string;
  readonly #lock: Lock;
  readonly #onError: (error: Error) => void;
  readonly #retryDelay: number | undefined;
  readonly #lockMs: number;
  readonly #deferMs: number;
  readonly #telemetry: TelemetryRecorder | undefined;
  readonly #queues = new Map<QueueName, Queue>();
  readonly #workers: Worker[] = [];
  readonly #renewals = new Set<ReturnType<typeof setInterval>>();
  readonly #stopping = new AbortController();
  #started: Promise<void> | undefined;
  #stopped = false;

  /**
   * `redis` serves the slots and locks; `connect` makes the connections BullMQ needs (each Queue and
   * Worker its own, with maxRetriesPerRequest null), all to redis-queue.
   */
  constructor(redis: Redis, connect: (suffix: string) => Redis, registry: Registry, options: BullQueueOptions = {}) {
    this.#redis = redis;
    this.#connect = connect;
    this.#registry = registry;
    this.#prefix = options.prefix ?? DEFAULT_PREFIX;
    this.#lock = new RedisLock(redis, { prefix: this.#prefix });
    this.#onError = options.onError ?? ((error) => console.error(`job queue: ${error.message}`));
    this.#retryDelay = options.retryDelaySeconds;
    this.#lockMs = (options.lockSeconds ?? 30) * 1000;
    this.#deferMs = options.deferMs ?? 1000;
    this.#telemetry = options.telemetry;
  }

  /** The queue on a process's connections to redis-queue */
  static on(connections: RedisConnections, registry: Registry, options: BullQueueOptions = {}): BullQueue {
    const name = options.instanceName ?? 'queue';
    return new BullQueue(connections.queue, (suffix) => connections.bullmq(`${name}-bullmq-${suffix}`), registry, options);
  }

  get registry(): Registry {
    return this.#registry;
  }

  #slot(queue: QueueName, key: string, slot: Slot): string {
    return `${this.#prefix}q:${queue}:${key}:${slot}`;
  }

  #queue(name: QueueName): Queue {
    const queue = this.#queues.get(name);
    if (!queue) throw new Error(`the queue ${name} is not started`);
    return queue;
  }

  #jobOptions(name: QueueName): JobsOptions {
    const spec = QUEUES[name];
    const delay = (this.#retryDelay ?? spec.retryDelay ?? 0) * 1000;
    return {
      // BullMQ's count is a ceiling only: the last attempt is decided in #process, stalls included
      attempts: (spec.retryLimit ?? 0) + 1,
      ...(delay > 0 && { backoff: { type: 'fixed', delay } }),
      // pg-boss keeps an ended job a week; the `jobs` rows keep what the app shows for longer
      removeOnComplete: { age: WEEK_SECONDS },
      removeOnFail: { age: WEEK_SECONDS },
    };
  }

  /** Opens a BullMQ queue per QUEUES entry and brings the `jobs` rows in line with what Redis holds */
  start(): Promise<void> {
    this.#started ??= (async () => {
      for (const name of QUEUE_NAMES) {
        const queue = new Queue(name, { connection: this.#connect(`queue-${name}`), prefix: `${this.#prefix}bull`, defaultJobOptions: this.#jobOptions(name) });
        queue.on('error', (error) => this.#onError(error));
        this.#queues.set(name, queue);
      }
      await reconcileRows(this.#registry, (record) => this.#held(record.queue as QueueName, record.id));
    })();
    return this.#started;
  }

  async #held(name: QueueName, id: string): Promise<HeldJob | undefined> {
    const queue = this.#queue(name);
    const [state, job] = await Promise.all([queue.getJobState(id), queue.getJob(id)]);
    return heldOf(state, job);
  }

  /**
   * The job a waiting slot names, if it still waits; a slot whose job started or vanished is stale.
   * A job BullMQ shows active that does not hold its key's `active` slot still counts as waiting: it
   * was just picked up and is about to take the slot or to be put back because its key is running,
   * and pg-boss would not have fetched it at all.
   */
  async #waiting(name: QueueName, key: string, slot: 'created' | 'retry'): Promise<string | undefined> {
    const id = await this.#redis.get(this.#slot(name, key, slot));
    if (!id) return undefined;
    const state = await this.#queue(name).getJobState(id);
    if (WAITING.has(state)) return id;
    if (state === 'active' && (await this.#redis.get(this.#slot(name, key, 'active'))) !== id) return id;
    return undefined;
  }

  /** Under the key's lock: sends and upserts of one key never interleave, in any process */
  async #underKey<T>(name: QueueName, key: string, fn: () => Promise<T>): Promise<T> {
    const result = await this.#lock.withLock(`q:${name}:${key}`, fn, { ttlMs: 10_000, waitMs: 15_000, retryMs: 20 });
    if (!result.acquired) throw new Error(`the queue ${name} is busy for the key "${key}"`);
    return result.value;
  }

  async #add<Q extends QueueName>(name: Q, key: string, id: string, data: JobData[Q], at: number): Promise<void> {
    const envelope: Envelope<Q> = { data, at };
    await this.#queue(name).add(key, envelope, { jobId: id, delay: Math.max(0, at - Date.now()) });
  }

  /** The row first, then the job: a worker may take a BullMQ job the moment it is added */
  async #record(name: QueueName, id: string, options: SendOptions): Promise<JobRecord> {
    return this.#registry.recordJob({ id, queue: name, title: options.title ?? QUEUES[name].title, launchId: options.launchId ?? null });
  }

  async send<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions = {}): Promise<string | null> {
    await this.start();
    const at = atOf(options.startAfter);
    const id = randomUUID();
    if (QUEUES[name].policy !== 'stately') {
      await this.#record(name, id, options);
      await this.#add(name, options.singletonKey ?? '', id, data, at);
      return id;
    }
    const key = options.singletonKey ?? '';
    return this.#underKey(name, key, async () => {
      if (await this.#waiting(name, key, 'created')) return null;
      await this.#record(name, id, options);
      await this.#add(name, key, id, data, at);
      await this.#redis.set(this.#slot(name, key, 'created'), id);
      return id;
    });
  }

  async upsert<Q extends QueueName>(name: Q, data: JobData[Q], options: SendOptions & { singletonKey: string }): Promise<string | null> {
    await this.start();
    const at = atOf(options.startAfter ?? new Date());
    const key = options.singletonKey;
    const id = await this.#underKey(name, key, async () => {
      const queued = await this.#waiting(name, key, 'created');
      if (queued && (await this.#move(name, key, queued, data, at))) return queued;
      const fresh = randomUUID();
      await this.#record(name, fresh, options);
      await this.#add(name, key, fresh, data, at);
      await this.#redis.set(this.#slot(name, key, 'created'), fresh);
      return fresh;
    });
    const record = await this.#record(name, id, options);
    if (options.title && record.title !== options.title) await this.#registry.updateJob(id, { title: options.title });
    return id;
  }

  /** Moves a waiting job to a new time and data; false when it started meanwhile (a new one is sent instead) */
  async #move<Q extends QueueName>(name: Q, key: string, id: string, data: JobData[Q], at: number): Promise<boolean> {
    const job = await this.#queue(name).getJob(id);
    if (!job) return false;
    const delay = at - Date.now();
    try {
      const state = await job.getState();
      if (state === 'delayed') {
        await job.updateData({ data, at } satisfies Envelope<Q>);
        if (delay > 0) await job.changeDelay(delay);
        else await job.promote();
        return true;
      }
      if (!WAITING.has(state)) return false;
      if (delay <= 0) {
        await job.updateData({ data, at } satisfies Envelope<Q>);
        return true;
      }
      // A waiting job cannot be delayed in place: it is removed (which fails if a worker took it) and
      // added again under the same id, so its row stays the same
      await job.remove();
      await this.#add(name, key, id, data, at);
      return true;
    } catch {
      return false;
    }
  }

  async schedule<Q extends QueueName>(name: Q, cron: string, data: JobData[Q], options: { singletonKey?: string } = {}): Promise<void> {
    await this.start();
    const envelope: Envelope<Q> = { data, at: 0 };
    await this.#queue(name).upsertJobScheduler(name, { pattern: cron, tz: 'UTC' }, { name: options.singletonKey ?? '', data: envelope, opts: this.#jobOptions(name) });
  }

  async queued(name: QueueName, singletonKey?: string): Promise<string[]> {
    await this.start();
    if (singletonKey !== undefined && QUEUES[name].policy === 'stately') {
      const ids = await Promise.all([this.#waiting(name, singletonKey, 'retry'), this.#waiting(name, singletonKey, 'created')]);
      return ids.filter((id): id is string => id !== undefined);
    }
    const jobs = await this.#queue(name).getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs
      .filter((j) => !(j.repeatJobKey && j.delay > 0 && j.timestamp + j.delay > Date.now()))
      .filter((j) => singletonKey === undefined || j.name === singletonKey)
      .map((j) => j.id)
      .filter((id): id is string => id !== undefined);
  }

  async work(handlers: Handlers): Promise<void> {
    await this.start();
    const register = <Q extends QueueName>(name: Q) => {
      const handler: Handlers[Q] = handlers[name];
      if (handler) this.#work<Q>(name, handler as Handler<Q>);
    };
    for (const name of QUEUE_NAMES) register(name);
  }

  #work<Q extends QueueName>(name: Q, handler: Handler<Q>): void {
    const worker = new Worker<Envelope<Q>>(name, (job, token, signal) => this.#process(name, handler, job, token, signal), {
      connection: this.#connect(`worker-${name}`),
      prefix: `${this.#prefix}bull`,
      concurrency: QUEUES[name].concurrency,
      lockDuration: this.#lockMs,
      stalledInterval: this.#lockMs,
      // Stalls are counted as attempts in #process, which fails a job past its retries itself
      maxStalledCount: 1000,
    });
    worker.on('error', (error) => this.#onError(error));
    this.#workers.push(worker);
  }

  async #process<Q extends QueueName>(name: Q, handler: Handler<Q>, job: Job<Envelope<Q>>, token: string | undefined, bullSignal: AbortSignal | undefined): Promise<void> {
    const spec = QUEUES[name];
    const id = job.id;
    if (!id) return;
    const key = job.name;
    const stately = spec.policy === 'stately';
    const activeSlot = this.#slot(name, key, 'active');
    if (stately) {
      if (job.repeatJobKey && !(await this.#adopt(name, key, id))) return;
      if ((await TAKE_ACTIVE.run(this.#redis, [activeSlot], [id, this.#lockMs])) !== 1) {
        await job.moveToDelayed(Date.now() + this.#deferMs, token);
        throw new DelayedError();
      }
      await Promise.all([RELEASE_SLOT.run(this.#redis, [this.#slot(name, key, 'created')], [id]), RELEASE_SLOT.run(this.#redis, [this.#slot(name, key, 'retry')], [id])]);
    }
    const renewal = stately ? setInterval(() => void RENEW_SLOT.run(this.#redis, [activeSlot], [id, this.#lockMs]).catch(() => undefined), Math.max(50, this.#lockMs / 3)) : undefined;
    if (renewal) this.#renewals.add(renewal);
    const retryLimit = spec.retryLimit ?? 0;
    const attempt = job.attemptsMade + job.stalledCounter + 1;
    try {
      if (attempt - 1 > retryLimit) {
        // It stalled (its process died) on its last attempt: as a pg-boss expiry, that was the attempt
        await this.#registry.recordJob({ id, queue: name, title: spec.title });
        await this.#registry.logJob(id, 'The process running it stopped, and it has no attempts left');
        await this.#registry.updateJob(id, { state: 'failed', ended: true });
        throw new UnrecoverableError('stalled with no attempts left');
      }
      if (job.stalledCounter > 0) await this.#registry.logJob(id, 'Tried again: the process running it stopped');
      const lastAttempt = attempt - 1 >= retryLimit;
      // A timer of our own, cleared when the handler settles: a job leaves nothing behind for its expiry
      const expiry = new AbortController();
      const signal = AbortSignal.any([expiry.signal, this.#stopping.signal, ...(bullSignal ? [bullSignal] : [])]);
      const expiring: Handler<Q> = (data, context) =>
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            const error = new Error(`It ran past its ${spec.expireInSeconds} seconds and was stopped`);
            expiry.abort(error);
            reject(error);
          }, (spec.expireInSeconds ?? 15 * 60) * 1000);
          timer.unref();
          handler(data, { ...context, signal }).then(resolve, reject).finally(() => clearTimeout(timer));
        });
      const readyAt = Math.max(job.data.at, job.timestamp + (job.delay || 0));
      try {
        await runJob(this.#registry, this.#telemetry, { id, queue: name, data: job.data.data, attempt, lastAttempt, readyAt, signal }, expiring);
      } catch (error) {
        if (lastAttempt) throw new UnrecoverableError(message(error));
        if (stately && !(await this.#takeRetry(name, key, id))) {
          await this.#registry.updateJob(id, { state: 'failed', ended: true });
          throw new UnrecoverableError(`${message(error)} (another job of its key is already waiting to retry)`);
        }
        const backoff = (this.#retryDelay ?? spec.retryDelay ?? 0) * 1000;
        await job.updateData({ data: job.data.data, at: Date.now() + backoff }).catch(() => undefined);
        throw error;
      }
    } finally {
      if (renewal) {
        clearInterval(renewal);
        this.#renewals.delete(renewal);
      }
      if (stately) await RELEASE_SLOT.run(this.#redis, [activeSlot], [id]).catch(() => undefined);
    }
  }

  /** A job a scheduler made takes the `created` slot, unless another job of its key is waiting there */
  #adopt(name: QueueName, key: string, id: string): Promise<boolean> {
    return this.#underKey(name, key, async () => {
      const queued = await this.#waiting(name, key, 'created');
      if (queued && queued !== id) return false;
      await this.#redis.set(this.#slot(name, key, 'created'), id);
      return true;
    });
  }

  /** The `retry` slot for a job about to be backed off; false when another job of the key holds it */
  #takeRetry(name: QueueName, key: string, id: string): Promise<boolean> {
    return this.#underKey(name, key, async () => {
      const retrying = await this.#waiting(name, key, 'retry');
      if (retrying && retrying !== id) return false;
      await this.#redis.set(this.#slot(name, key, 'retry'), id);
      return true;
    });
  }

  wait(id: string, timeoutMs: number, everyMs = 1000): Promise<JobRecord | undefined> {
    return waitForJob(this.#registry, id, timeoutMs, everyMs);
  }

  /**
   * Closes the workers, giving the running jobs `timeoutMs` to finish; then their signals abort and
   * the workers close by force: a job still running keeps its BullMQ lock until it lapses, and then
   * stalls to another process, which counts the attempt (and fails it if none are left).
   */
  async stop(timeoutMs = 20_000): Promise<void> {
    if (this.#stopped || !this.#started) return;
    this.#stopped = true;
    await this.#started.catch(() => undefined);
    const workers = this.#workers.splice(0);
    const closed = Promise.all(workers.map((w) => w.close())).then(() => true);
    if (!(await Promise.race([closed, sleep(timeoutMs).then(() => false)]))) {
      this.#stopping.abort(new Error('the queue is stopping'));
      for (const renewal of this.#renewals) clearInterval(renewal);
      await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
    }
    await Promise.all([...this.#queues.values()].map((q) => q.close().catch(() => undefined)));
  }

  /**
   * Rebuilds the wake-up of every scheduled post from posts.scheduled_at: what Redis lost (a flush, a
   * new instance) comes back, and what it kept is moved to the time Postgres says, never doubled
   * (armScheduled upserts by `post:<id>`). Under a lock, so one process does it at a time; meant for
   * the start and every ten minutes. The number armed, or undefined when another process was at it.
   */
  async reconcileScheduled(): Promise<number | undefined> {
    await this.start();
    const result = await this.#lock.withLock(
      'reconcile:scheduled',
      async () => {
        let armed = 0;
        for (const post of await this.#registry.scheduledPosts()) if (await armScheduled(this, post)) armed++;
        return armed;
      },
      { ttlMs: 60_000 },
    );
    return result.acquired ? result.value : undefined;
  }
}

/** Milliseconds since the epoch of a SendOptions start: seconds from now, or a moment */
function atOf(startAfter: SendOptions['startAfter']): number {
  if (startAfter === undefined) return Date.now();
  return typeof startAfter === 'number' ? Date.now() + startAfter * 1000 : startAfter.getTime();
}

/** The queues whose waiting jobs a BullMQ start rebuilds from Postgres: they need not drain */
export const REBUILT_FROM_POSTGRES: readonly QueueName[] = ['scheduled', 'round'];

export interface DrainReport {
  held: HeldCounts;
  /** Queues with work running, or waiting that nothing rebuilds: the switch waits for these */
  blocking: QueueName[];
  /** Whether nothing blocks: BullMQ can start */
  drained: boolean;
}

/**
 * The cutover's wait: what pg-boss still holds, polled until nothing blocks or the time is up. Nothing
 * is copied: the truth is Postgres (posts, launches), so the scheduled posts are re-armed by
 * reconcileScheduled and the round by startWorking, and what pg-boss still holds of those two is
 * left to it (its rows are failed as "never ran" by BullQueue's start). Every running job, and a
 * waiting job of any other queue (a publish backing off, a hand-sent sync), has to finish on pg-boss.
 */
export async function drainPgBoss(queue: WorkQueue, options: { timeoutMs?: number; everyMs?: number } = {}): Promise<DrainReport> {
  const deadline = Date.now() + (options.timeoutMs ?? 0);
  for (;;) {
    const held = await queue.held();
    const blocking = QUEUE_NAMES.filter((q) => held[q].active > 0 || (held[q].queued > 0 && !REBUILT_FROM_POSTGRES.includes(q)));
    const report = { held, blocking, drained: blocking.length === 0 };
    if (report.drained || Date.now() >= deadline) return report;
    await sleep(Math.min(options.everyMs ?? 5000, Math.max(1, deadline - Date.now())));
  }
}
