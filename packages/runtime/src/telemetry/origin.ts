import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who the work in progress is for: a server function (`fn:getLaunch`), a page (`page:/launches/:n`),
 * a job (`job:metrics`), an API route. Outbound calls are counted under it, so the numbers say which
 * page or job spends the providers' quota. `probe` marks the measurement's own page loads, which the
 * comparison leaves out of the totals.
 */
export interface WorkOrigin {
  name: string;
  probe: boolean;
  /** Ids every log line inside carries (`requestId`, `jobId`): one store serves counting and logging */
  correlation?: Correlation;
}

/** Ids that tie a request's or a job's log lines together */
export type Correlation = Readonly<Record<string, string>>;

const storage = new AsyncLocalStorage<WorkOrigin>();

/** The origin of the work running now; `other` outside any (a start-up read, a timer) */
export function currentOrigin(): WorkOrigin {
  return storage.getStore() ?? { name: 'other', probe: false };
}

/** Runs `work` under an origin; a probe stays a probe in whatever it calls */
export function withOrigin<T>(name: string, work: () => T, options: { probe?: boolean } = {}): T {
  const there = storage.getStore();
  const probe = options.probe === true || there?.probe === true;
  return storage.run({ name, probe, ...(there?.correlation && { correlation: there.correlation }) }, work);
}

/** Runs `work` with ids bound to every log line inside it, added to any already bound */
export function withCorrelation<T>(ids: Correlation, work: () => T): T {
  const there = currentOrigin();
  return storage.run({ ...there, correlation: { ...there.correlation, ...ids } }, work);
}

/** The ids bound to the work running now; empty outside any */
export function currentCorrelation(): Correlation {
  return storage.getStore()?.correlation ?? {};
}
