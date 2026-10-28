import type { ArticleInput, JobRecord, Registry } from '@shipcast/engine';
import { ShipcastError, type Channel } from '@shipcast/schema';
import { fromPglite, PgBoss, type ConstructorOptions, type PGliteLike, type Queue } from 'pg-boss';
import { withOrigin } from './telemetry/origin.ts';
import type { TelemetryRecorder } from './telemetry/recorder.ts';
import type { WebhookAction } from './webhooks.ts';

/*
 * The durable work: every job is a pg-boss job in the registry's Postgres, in pg-boss's own schema,
 * so a job sent before a restart runs after it, a job a crash interrupted is tried again once it
 * expires, and two processes (the app and `shipcast watch`) share one queue instead of each running
 * its own. What the app shows of a job is a row of the registry's `jobs` table, kept by the wrapper
 * around each handler. See docs/decisions/job-queue.md
 */

/** What each queue's jobs carry */
export interface JobData {
  draft: { launchId: number; direct?: boolean };
  article: { launchId: number; input: ArticleInput; direct?: boolean };
  publish: { launchId: number; retryChannel?: Channel };
  delivery: { action: Extract<WebhookAction, { kind: 'claim' | 'publish' }>; delivery: string };
  round: { reason: string };
  metrics: { reason: string };
  'instagram-tokens': { reason: string };
  /** Every account's numbers, or one account's when it is synced by hand */
  snapshots: { reason: string; accountId?: number };
  /** Wakes the publishing of a launch when one of its scheduled pieces is due */
  scheduled: { postId: number; launchId: number };
  /** Every live post's comments read and drafted, or one comment's reply drafted again */
  comments: { reason: string; commentId?: number };
  /** One account's profile reviewed by the AI, with what the owner pasted where the network cannot read it */
  'profile-review': { accountId: number; pasted?: { displayName?: string; bio?: string; links?: string }; language?: string };
  /** The measurement's freshness and correctness checks, from the registry only */
  checks: { reason: string };
  /** The measurement's browser page loads of fixed pages; worked by the web app only */
  probe: { reason: string };
}

export type QueueName = keyof JobData;

/** The schema pg-boss creates its tables in, beside the registry's */
export const QUEUE_SCHEMA = 'pgboss';

/** Seconds between a publish job's attempts while it waits for the site to deploy */
export const PUBLISH_RETRY_SECONDS = 30;
/** Attempts after the first: 40 of 30 seconds wait the 20 minutes the old loop did */
export const PUBLISH_RETRIES = 40;

export interface QueueSpec extends Omit<Queue, 'name'> {
  /** The title of a job nobody named, such as one a schedule sent */
  title: string;
  /** How many of its jobs one process runs at once */
  concurrency: number;
}

/*
 * Retries are for waiting, not for repeating work: a draft costs an AI run and fails into the
 * launch's own `failed` status, so it is never tried again on its own; a publish job's retries are
 * how it waits for a deploy. The round, the metrics, the token refresh and the snapshots are
 * `stately`: one queued and one running at most, whichever process sent them (per account, for a
 * Sync now, which has its own key).
 */
export const QUEUES: Record<QueueName, QueueSpec> = {
  draft: { title: 'Drafting a launch', policy: 'standard', retryLimit: 0, expireInSeconds: 2 * 3600, concurrency: 2 },
  article: { title: 'Writing an article’s pieces', policy: 'standard', retryLimit: 0, expireInSeconds: 2 * 3600, concurrency: 2 },
  publish: { title: 'Publishing a launch', policy: 'stately', retryLimit: PUBLISH_RETRIES, retryDelay: PUBLISH_RETRY_SECONDS, expireInSeconds: 30 * 60, concurrency: 2 },
  delivery: { title: 'A GitHub delivery', policy: 'standard', retryLimit: 2, retryDelay: 30, expireInSeconds: 10 * 60, concurrency: 2 },
  round: { title: 'Automation round', policy: 'stately', retryLimit: 0, expireInSeconds: 3600, concurrency: 1 },
  metrics: { title: 'Reading the numbers', policy: 'stately', retryLimit: 1, retryDelay: 15 * 60, expireInSeconds: 3600, concurrency: 1 },
  'instagram-tokens': { title: 'Refreshing Instagram tokens', policy: 'stately', retryLimit: 2, retryDelay: 3600, expireInSeconds: 15 * 60, concurrency: 1 },
  snapshots: { title: 'Syncing the accounts', policy: 'stately', retryLimit: 1, retryDelay: 30 * 60, expireInSeconds: 30 * 60, concurrency: 1 },
  // One per scheduled piece (its key), moved when the piece is: the post row holds the time, the job only wakes the publishing
  scheduled: { title: 'A scheduled post', policy: 'stately', retryLimit: 2, retryDelay: 60, expireInSeconds: 10 * 60, concurrency: 1 },
  // No retries: a run drafts with the AI, and the next run, half an hour later, is the retry
  comments: { title: 'Reading the comments', policy: 'stately', retryLimit: 0, expireInSeconds: 2 * 3600, concurrency: 2 },
  // One per account (its key); no retries: a review costs an AI run, and the owner asks again
  'profile-review': { title: 'Reviewing a profile', policy: 'stately', retryLimit: 0, expireInSeconds: 30 * 60, concurrency: 1 },
  // The measurement (docs/plans/performance-refactor.md, phase 0): no retries, the next hour's run is the retry
  checks: { title: 'Checking freshness and correctness', policy: 'stately', retryLimit: 0, expireInSeconds: 10 * 60, concurrency: 1 },
  probe: { title: 'Timing the pages', policy: 'stately', retryLimit: 0, expireInSeconds: 10 * 60, concurrency: 1 },
};

export const QUEUE_NAMES = Object.keys(QUEUES) as QueueName[];

/** Thrown by a handler that cannot finish yet: its job is tried again after the queue's delay */
export class RetryLater extends ShipcastError {
  override name = 'RetryLater';

  constructor(message: string) {
    super(message, { code: 'retry_later', retryable: true, httpStatus: 503 });
  }
}

/** What a handler gets besides its job's data */
export interface JobContext {
  /** pg-boss's id of the job, which is also its row in the registry */
  id: string;
  /** 1 for the first attempt */
  attempt: number;
  /** Whether a RetryLater from this attempt would still be tried again */
  lastAttempt: boolean;
  log(line: string): void;
  /** Where the app sends the owner once the job is done */
  link(url: string): void;
  /** Aborted when the job expires or the queue stops */
  signal: AbortSignal;
}

export type Handler<Q extends QueueName> = (data: JobData[Q], job: JobContext) => Promise<void>;
export type Handlers = { [Q in QueueName]?: Handler<Q> };

export interface SendOptions {
  /** What the app shows; the queue's own title when not given */
  title?: string;
  launchId?: number | null;
  /** Seconds from now, or a moment */
  startAfter?: number | Date;
  /** On a stately queue, the jobs that share a key are the ones that exclude each other */
  singletonKey?: string;
}

export interface QueueOptions {
  /** Runs pg-boss's cron, which turns schedules into jobs; on by default */
  schedule?: boolean;
  /** pg-boss's maintenance: expiring jobs that stopped, deleting old ones; on by default */
  supervise?: boolean;
  /** How often an idle worker looks for jobs, in seconds */
  pollingIntervalSeconds?: number;
  /** A name for this process among pg-boss's instances: `app`, `watch` */
  instanceName?: string;
  /** Where pg-boss's errors go; it never throws them at the caller */
  onError?: (error: Error) => void;
  /** Seconds between any queue's attempts instead of its own: tests make the waits short */
  retryDelaySeconds?: number;
  /** Where each job's duration and wait are counted, and whose calls are counted under `job:<queue>` */
  telemetry?: TelemetryRecorder;
}

/**
 * What the app and `shipcast watch` need of the durable work, whichever queue holds it: pg-boss
 * (`WorkQueue`) or BullMQ (`BullQueue`, behind the `bullmq` flag). Both keep the registry's `jobs`
 * rows through the same wrapper (`runJob`), and one contract suite
 * (test/queue-contract.test.ts) holds both to the same semantics.
 */
export interface JobQueue {
  readonly registry: Registry;
  start(): Promise<void>;
  send<Q extends QueueName>(queue: Q, data: JobData[Q], options?: SendOptions): Promise<string | null>;
  upsert<Q extends QueueName>(queue: Q, data: JobData[Q], options: SendOptions & { singletonKey: string }): Promise<string | null>;
  schedule<Q extends QueueName>(queue: Q, cron: string, data: JobData[Q], options?: { singletonKey?: string }): Promise<void>;
  queued(queue: QueueName, singletonKey?: string): Promise<string[]>;
  work(handlers: Handlers): Promise<void>;
  wait(id: string, timeoutMs: number, everyMs?: number): Promise<JobRecord | undefined>;
  stop(timeoutMs?: number): Promise<void>;
}

/** One attempt of a job, as either queue hands it over */
export interface RunningJob<Q extends QueueName> {
  id: string;
  queue: Q;
  data: JobData[Q];
  /** 1 for the first */
  attempt: number;
  lastAttempt: boolean;
  /** When it could first start (its time, for a delayed job), for the job-wait timing */
  readyAt: number;
  signal: AbortSignal;
}

/**
 * The wrapper around every handler, for both queues: the registry's row at each transition, the log
 * and link, the timing of the attempt and of its wait, and the `job:<queue>` origin the calls made
 * inside it are counted under. It rethrows what the handler threw: the queue decides what follows.
 */
export async function runJob<Q extends QueueName>(registry: Registry, telemetry: TelemetryRecorder | undefined, job: RunningJob<Q>, handler: Handler<Q>): Promise<void> {
  const { id, queue, attempt, lastAttempt } = job;
  // From when it could start to now: how long the queue kept it waiting
  telemetry?.timing({ kind: 'job-wait', name: queue, outcome: 'ok', ms: Math.max(0, Date.now() - job.readyAt) });
  const started = performance.now();
  // A job a schedule sent, or one sent before its row existed, is recorded when it starts
  await registry.jobs.recordJob({ id, queue, title: QUEUES[queue].title });
  await registry.jobs.updateJob(id, { state: 'active', attempts: attempt, started: true, ended: false });
  // Lines are written in order, and a failed write never fails the work
  let written: Promise<void> = Promise.resolve();
  const log = (line: string) => {
    written = written.then(() => registry.jobs.logJob(id, line)).catch(() => undefined);
  };
  let link: string | undefined;
  try {
    await withOrigin(`job:${queue}`, () => handler(job.data, { id, attempt, lastAttempt, log, link: (url) => void (link = url), signal: job.signal }));
  } catch (error) {
    telemetry?.timing({ kind: 'job', name: queue, outcome: lastAttempt ? 'error' : 'retry', ms: performance.now() - started });
    log(error instanceof RetryLater ? `Waiting: ${message(error)}` : message(error));
    await written;
    await registry.jobs.updateJob(id, { state: lastAttempt ? 'failed' : 'retry', ended: lastAttempt, ...(link !== undefined && { link }) });
    throw error;
  }
  telemetry?.timing({ kind: 'job', name: queue, outcome: 'ok', ms: performance.now() - started });
  await written;
  await registry.jobs.updateJob(id, { state: 'completed', ended: true, ...(link !== undefined && { link }) });
}

/** Polls the registry's row until the job has ended, in any process; undefined when the time is up first */
export async function waitForJob(registry: Registry, id: string, timeoutMs: number, everyMs = 1000): Promise<JobRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = await registry.jobs.job(id);
    if (record && (record.state === 'completed' || record.state === 'failed')) return record;
    if (Date.now() > deadline) return undefined;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** What a queue says of one of its jobs, for reconcileRows: its state and the retries it made */
export interface HeldJob {
  state: JobRecord['state'];
  retryCount: number;
}

/**
 * Brings the rows of jobs that were waiting or running when a process stopped in line with the
 * queue: a job it expired, failed or lost is not left showing "running". `find` answers for one row.
 */
export async function reconcileRows(registry: Registry, find: (record: JobRecord) => Promise<HeldJob | undefined>): Promise<void> {
  for (const record of await registry.jobs.jobs({ states: ['created', 'active', 'retry'], limit: 500 })) {
    if (!(QUEUE_NAMES as string[]).includes(record.queue)) continue;
    const job = await find(record);
    if (!job) {
      // pg-boss only deletes a waiting job after its retention (14 days) and an ended one a week
      // after it ended, so in practice a row lands here when pg-boss's tables were edited by hand,
      // as a preview copy that clears the queued work does, or (on BullMQ) when Redis was lost.
      // One that never started did nothing.
      await registry.jobs.updateJob(record.id, { state: 'failed', ended: true });
      await registry.jobs.logJob(record.id, record.state === 'created' ? NEVER_RAN : LOST_RUNNING);
      continue;
    }
    if (job.state === record.state) continue;
    await registry.jobs.updateJob(record.id, { state: job.state, attempts: Math.max(record.attempts, job.retryCount + (job.state === 'created' ? 0 : 1)), ended: job.state === 'completed' || job.state === 'failed' });
  }
  // A draft cut short by a stop leaves its launch "generating" for good, and a launch in that state
  // cannot be started again; failed, it can, and its page says why
  const live = await registry.jobs.jobs({ states: ['created', 'active', 'retry'], queues: ['draft', 'article'], limit: 500 });
  const drafting = new Set(live.map((j) => j.launchId));
  const { launches } = await registry.launches.launchesPage({ status: 'generating', limit: 100 });
  for (const launch of launches) {
    if (!drafting.has(launch.id)) await registry.launches.setStatus(launch.id, 'failed', 'The draft was interrupted when Shipcast stopped. Launch it again.');
  }
}

/** What a queue still holds per queue: what a cutover waits on */
export type HeldCounts = Record<QueueName, { queued: number; active: number }>;

/** The last line of a row whose pg-boss job is gone: waiting, it never ran, so nothing was done */
export const NEVER_RAN = 'The queue no longer has this job: it was removed before it ran, so nothing was done';
/** …and one that had started, whose end nobody recorded */
export const LOST_RUNNING = 'The queue no longer has this job: it stopped without its end being recorded';

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The registry's state of a job pg-boss reports, the cancelled ones among the failed */
function stateOf(state: string): JobRecord['state'] {
  if (state === 'created' || state === 'active' || state === 'retry' || state === 'completed') return state;
  return 'failed';
}

export class WorkQueue implements JobQueue {
  readonly #boss: PgBoss;
  readonly #registry: Registry;
  readonly #polling: number;
  readonly #retryDelay: number | undefined;
  readonly #telemetry: TelemetryRecorder | undefined;
  #started: Promise<void> | undefined;
  #stopped = false;

  constructor(boss: PgBoss, registry: Registry, options: QueueOptions = {}) {
    this.#boss = boss;
    this.#registry = registry;
    this.#polling = options.pollingIntervalSeconds ?? 2;
    this.#retryDelay = options.retryDelaySeconds;
    this.#telemetry = options.telemetry;
    boss.on('error', options.onError ?? ((error) => console.error(`job queue: ${error.message}`)));
  }

  static #options(options: QueueOptions): ConstructorOptions {
    return { schema: QUEUE_SCHEMA, schedule: options.schedule ?? true, supervise: options.supervise ?? true, instanceName: options.instanceName };
  }

  /** The queue on a Postgres server: the registry's, pg-boss in its own schema and pool */
  static postgres(url: string, registry: Registry, options: QueueOptions = {}): WorkQueue {
    // A small pool: the work is a handful of jobs at a time, and the registry has a pool of its own
    return new WorkQueue(new PgBoss({ ...WorkQueue.#options(options), connectionString: url, max: 4, application_name: `shipcast-${options.instanceName ?? 'queue'}` }), registry, options);
  }

  /** The queue on a PGlite instance, for tests: the same pg-boss and the same SQL, in this process */
  static pglite(client: PGliteLike, registry: Registry, options: QueueOptions = {}): WorkQueue {
    return new WorkQueue(new PgBoss({ ...WorkQueue.#options(options), db: fromPglite(client), backend: 'pglite', registerInstance: false }), registry, options);
  }

  get registry(): Registry {
    return this.#registry;
  }

  /**
   * Starts pg-boss, which creates or migrates its schema, and makes sure every queue exists with
   * the settings written here. Once per instance; every caller waits for the same start.
   */
  start(): Promise<void> {
    this.#started ??= (async () => {
      await this.#boss.start();
      for (const name of QUEUE_NAMES) {
        const { title: _title, concurrency: _concurrency, policy, ...spec } = QUEUES[name];
        const settings = this.#retryDelay === undefined ? spec : { ...spec, retryDelay: this.#retryDelay };
        await this.#boss.createQueue(name, { policy, ...settings });
        // createQueue leaves an existing queue as it was; a setting changed here reaches it this way
        await this.#boss.updateQueue(name, settings);
      }
      await this.#reconcile();
    })();
    return this.#started;
  }

  /**
   * Brings the rows of jobs that were waiting or running when a process stopped in line with
   * pg-boss: a job it expired, failed or deleted (by retention) is not left showing "running".
   */
  async #reconcile(): Promise<void> {
    await reconcileRows(this.#registry, async (record) => {
      const [job] = await this.#boss.findJobs(record.queue, { id: record.id });
      return job && { state: stateOf(job.state), retryCount: job.retryCount };
    });
  }

  /** How many jobs pg-boss holds queued and running per queue, from its own table: what drainPgBoss reads */
  async held(): Promise<HeldCounts> {
    await this.start();
    const { rows } = await this.#boss.getDb().executeSql(`SELECT name, state, count(*)::int AS n FROM ${QUEUE_SCHEMA}.job WHERE state IN ('created', 'retry', 'active') GROUP BY name, state`);
    const counts = Object.fromEntries(QUEUE_NAMES.map((q) => [q, { queued: 0, active: 0 }])) as HeldCounts;
    for (const row of rows as Array<{ name: string; state: string; n: number }>) {
      const entry = counts[row.name as QueueName];
      if (!entry) continue;
      if (row.state === 'active') entry.active += row.n;
      else entry.queued += row.n;
    }
    return counts;
  }

  /**
   * Sends a job and records it, so the app shows it from the moment it is queued. Null when a
   * stately queue already holds a job of that key in that state: the caller's work is queued already.
   */
  async send<Q extends QueueName>(queue: Q, data: JobData[Q], options: SendOptions = {}): Promise<string | null> {
    await this.start();
    const id = await this.#boss.send(queue, data, {
      ...(options.singletonKey !== undefined && { singletonKey: options.singletonKey }),
      ...(options.startAfter !== undefined && { startAfter: options.startAfter }),
    });
    if (id) await this.#registry.jobs.recordJob({ id, queue, title: options.title ?? QUEUES[queue].title, launchId: options.launchId ?? null });
    return id;
  }

  /**
   * Moves the queued job of a key to a new start and data, or sends one if none is queued; on a
   * stately queue, what makes "run it now" mean the round already waiting rather than a second one.
   */
  async upsert<Q extends QueueName>(queue: Q, data: JobData[Q], options: SendOptions & { singletonKey: string }): Promise<string | null> {
    await this.start();
    const startAfter = options.startAfter === undefined ? new Date() : typeof options.startAfter === 'number' ? new Date(Date.now() + options.startAfter * 1000) : options.startAfter;
    const result = await this.#boss.upsert(queue, data, { singletonKey: options.singletonKey, startAfter });
    const id = result.jobs[0] ?? null;
    if (id) {
      const record = await this.#registry.jobs.recordJob({ id, queue, title: options.title ?? QUEUES[queue].title, launchId: options.launchId ?? null });
      if (options.title && record.title !== options.title) await this.#registry.jobs.updateJob(id, { title: options.title });
    }
    return id;
  }

  /**
   * A job sent on a recurring cron expression, in UTC; scheduling a queue again replaces its
   * schedule. pg-boss sends each occurrence once, whichever of the processes running its cron sees it.
   */
  async schedule<Q extends QueueName>(queue: Q, cron: string, data: JobData[Q], options: { singletonKey?: string } = {}): Promise<void> {
    await this.start();
    await this.#boss.schedule(queue, cron, data, { tz: 'UTC', ...(options.singletonKey !== undefined && { singletonKey: options.singletonKey }) });
  }

  /** The jobs of a stately queue's key that are queued but not yet running */
  async queued(queue: QueueName, singletonKey?: string): Promise<string[]> {
    await this.start();
    const jobs = await this.#boss.findJobs(queue, { queued: true, ...(singletonKey !== undefined && { key: singletonKey }) });
    return jobs.map((j) => j.id);
  }

  /** Works the queues there is a handler for, in this process, until stop() */
  async work(handlers: Handlers): Promise<void> {
    await this.start();
    // Generic per queue, so each handler stays tied to its own queue's data
    const register = async <Q extends QueueName>(name: Q) => {
      const handler: Handlers[Q] = handlers[name];
      if (handler) await this.#work<Q>(name, handler as Handler<Q>);
    };
    for (const name of QUEUE_NAMES) await register(name);
  }

  async #work<Q extends QueueName>(queue: Q, handler: Handler<Q>): Promise<void> {
    const spec = QUEUES[queue];
    const registry = this.#registry;
    const telemetry = this.#telemetry;
    const options = { pollingIntervalSeconds: this.#polling, localConcurrency: spec.concurrency, includeMetadata: true } as const;
    await this.#boss.work<JobData[Q], void, typeof options>(queue, options, async ([job]) => {
      if (!job) return;
      // pg-boss decides what follows a throw: another attempt after the queue's delay, or failed for good
      await runJob(registry, telemetry, { id: job.id, queue, data: job.data, attempt: job.retryCount + 1, lastAttempt: job.retryCount >= (spec.retryLimit ?? 0), readyAt: Math.max(job.startAfter.getTime(), job.createdOn.getTime()), signal: job.signal }, handler);
    });
  }

  /**
   * Waits until a job has ended, in this process or any other that works its queue; undefined when
   * the time is up first.
   */
  wait(id: string, timeoutMs: number, everyMs = 1000): Promise<JobRecord | undefined> {
    return waitForJob(this.#registry, id, timeoutMs, everyMs);
  }

  /**
   * Stops the workers, giving the running jobs a while to finish; one still running after it keeps
   * its `active` state in pg-boss, which expires and retries it (or fails it, for a queue without
   * retries) once its time is up.
   */
  async stop(timeoutMs = 20_000): Promise<void> {
    if (this.#stopped || !this.#started) return;
    this.#stopped = true;
    await this.#started.catch(() => undefined);
    await this.#boss.stop({ graceful: true, timeout: timeoutMs });
  }
}
