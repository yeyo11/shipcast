import type { OpenRepositories } from '@shipcast/engine';
import { parseFailureKey } from '@shipcast/schema/failures';
import type { EventBus, EventName, ShipcastEvents } from '../redis/ports.ts';

/*
 * Phase 9's publishers (docs/plans/performance-refactor.md, "6. A live UI"): every write a page shows
 * is announced on the event bus, naming what changed and nothing more (ids, never the data), so an
 * open page re-reads the registry only when something it shows moved.
 *
 * The one place per kind is the repository the change goes through: the registry a composition root
 * builds is wrapped here, so every caller (the pipeline, PublishingService, the comment and metric
 * runs, the queue's shared job wrapper in whichever process runs the job, the pages' actions) emits
 * without knowing it, and a new caller cannot forget to. A write that changed nothing a page shows
 * (a comment read again, a dismissal sweep that removed none) emits nothing.
 *
 * Two kinds come in bursts and are coalesced per key, the event sent once the burst settles with the
 * row as it is then: a job's log lines (and its state changes in quick succession), and a launch's
 * metric readings, of which one run writes one per source and post.
 */

type Publish = <E extends EventName>(event: E, payload: ShipcastEvents[E]) => void;

/** How long a job's events wait for the next one: a running job's log streams, its page follows in steps */
export const JOB_COALESCE_MS = 500;
/** A metrics run writes a launch's readings back to back: one event once they stop coming */
export const METRICS_COALESCE_MS = 3000;
/** ...and never later than this after the first, however long the run */
export const METRICS_MAX_WAIT_MS = 15_000;

/** One pending send per key, fired `waitMs` after the last touch, at most `maxWaitMs` after the first */
export class Coalescer {
  readonly #pending = new Map<string, { timer: NodeJS.Timeout; first: number; fire: () => Promise<void> }>();
  readonly #waitMs: number;
  readonly #maxWaitMs: number;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(waitMs: number, maxWaitMs = waitMs * 4) {
    this.#waitMs = waitMs;
    this.#maxWaitMs = maxWaitMs;
  }

  touch(key: string, fire: () => Promise<void>): void {
    const now = Date.now();
    const pending = this.#pending.get(key);
    if (pending) clearTimeout(pending.timer);
    const first = pending?.first ?? now;
    const delay = Math.max(0, Math.min(this.#waitMs, first + this.#maxWaitMs - now));
    const timer = setTimeout(() => this.#run(key), delay);
    timer.unref();
    this.#pending.set(key, { timer, first, fire });
  }

  #run(key: string): void {
    const pending = this.#pending.get(key);
    if (!pending) return;
    this.#pending.delete(key);
    const running = pending.fire().catch(() => undefined);
    this.#inFlight.add(running);
    void running.finally(() => this.#inFlight.delete(running));
  }

  /** Sends what waits now: a stop must not lose the last state of a job */
  async flush(): Promise<void> {
    for (const [key, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#run(key);
    }
    await Promise.all([...this.#inFlight]);
  }
}

type AsyncFn = (...args: never[]) => Promise<unknown>;
type Taps<T> = { [K in keyof T]?: T[K] extends (...args: infer A) => Promise<infer R> ? (args: A, result: R) => void : never };

/**
 * The repository with a tap after each named method's success. A Proxy rather than a copy: the
 * repositories are classes with private fields, so every method runs bound to the real one.
 */
function tapped<T extends object>(target: T, taps: Taps<T>): T {
  const table = taps as Record<PropertyKey, ((args: unknown[], result: unknown) => void) | undefined>;
  return new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== 'function') return value;
      const bound = (value as AsyncFn).bind(t) as (...args: unknown[]) => unknown;
      const tap = table[prop];
      if (!tap) return bound;
      return async (...args: unknown[]) => {
        const result = await bound(...args);
        try {
          tap(args, result);
        } catch {
          // An announcement never fails the write it follows
        }
        return result;
      };
    },
  });
}

export interface RegistryEvents<R> {
  /** The registry whose writes announce themselves */
  registry: R;
  /** Sends the coalesced events still waiting: part of a stop, before the bus closes */
  flush(): Promise<void>;
}

/**
 * Wraps a registry so its writes publish on `bus`. Publishing never waits on the write's caller and
 * never fails it: a lost event costs a page one stale view until the next, and the pages resync on
 * every reconnect anyway.
 */
export function withEvents<R extends Pick<OpenRepositories, 'launches' | 'posts' | 'comments' | 'metrics' | 'accounts' | 'jobs' | 'attention' | 'cursors' | 'drafts'>>(
  registry: R,
  bus: Pick<EventBus, 'publish'>,
  log: (line: string) => void = (line) => console.error(line),
): RegistryEvents<R> {
  const publish: Publish = (event, payload) => {
    bus.publish(event, payload).catch((error: unknown) => log(`event ${event}: ${error instanceof Error ? error.message : String(error)}`));
  };
  const jobs = new Coalescer(JOB_COALESCE_MS, JOB_COALESCE_MS * 4);
  const metrics = new Coalescer(METRICS_COALESCE_MS, METRICS_MAX_WAIT_MS);
  const { jobs: jobRows } = registry;
  // The row as it is when the burst settles: the state the page will read
  const job = (id: string) =>
    jobs.touch(id, async () => {
      const row = await jobRows.job(id);
      if (row) publish('job.changed', { id: row.id, queue: row.queue, state: row.state, launchId: row.launchId });
    });
  const launch = (launchId: number) => publish('launch.changed', { launchId });
  const post = (p: { id: number; launchId: number } | undefined) => {
    if (p) publish('post.changed', { postId: p.id, launchId: p.launchId });
  };
  const account = (accountId: number) => publish('account.changed', { accountId });
  const failure = (key: string) => {
    const parsed = parseFailureKey(key);
    if (parsed) launch(parsed.launchId);
  };

  const wrapped = {
    ...registry,
    launches: tapped(registry.launches, {
      claim: (_args, result) => {
        if (result.claimed) launch(result.launch.id);
      },
      setStatus: ([id]) => launch(id),
    }),
    drafts: tapped(registry.drafts, {
      saveSnapshot: (_args, result) => launch(result.launchId),
      patchSnapshotFile: ([launchId], changed) => {
        if (changed) launch(launchId);
      },
    }),
    // A channel's failure is a cursor: the launch page and the bell show it
    cursors: tapped(registry.cursors, {
      setCursor: ([key]) => failure(key),
      deleteCursor: ([key]) => failure(key),
    }),
    posts: tapped(registry.posts, {
      recordPost: (_args, result) => post(result.post),
      updatePost: (_args, result) => post(result),
      schedulePost: (_args, result) => post(result),
      reschedulePost: (_args, result) => post(result),
      unschedulePost: (_args, result) => post(result),
      clearSchedule: ([launchId]) => publish('post.changed', { postId: null, launchId }),
    }),
    comments: tapped(registry.comments, {
      // A comment read again on the next run is no change
      recordComment: (_args, result) => {
        if (result.recorded) publish('comment.changed', { commentId: result.comment.id, launchId: result.comment.launchId });
      },
      updateComment: (_args, result) => {
        if (result) publish('comment.changed', { commentId: result.id, launchId: result.launchId });
      },
    }),
    metrics: tapped(registry.metrics, {
      recordMetrics: ([launchId]) => metrics.touch(String(launchId), async () => publish('metrics.changed', { launchId })),
    }),
    accounts: tapped(registry.accounts, {
      addAccount: (_args, result) => account(result.id),
      updateAccount: ([id]) => account(id),
      recordCheck: ([id]) => account(id),
      makePrimary: ([id]) => account(id),
      deleteAccount: ([id]) => account(id),
      recordSnapshot: ([id]) => account(id),
    }),
    jobs: tapped(registry.jobs, {
      recordJob: (_args, result) => job(result.id),
      updateJob: ([id]) => job(id),
      logJob: ([id]) => job(id),
    }),
    attention: tapped(registry.attention, {
      dismissAttention: ([keys]) => publish('attention.changed', { dismissed: keys.length }),
      // The bell's own read sweeps the dismissals of lines that are gone: only a sweep that removed one is news
      clearAttentionDismissals: (_args, removed) => {
        if (removed > 0) publish('attention.changed', { dismissed: removed });
      },
    }),
  };
  return {
    registry: wrapped,
    flush: async () => {
      await jobs.flush();
      await metrics.flush();
    },
  };
}
