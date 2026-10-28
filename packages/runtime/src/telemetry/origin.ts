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
}

const storage = new AsyncLocalStorage<WorkOrigin>();

/** The origin of the work running now; `other` outside any (a start-up read, a timer) */
export function currentOrigin(): WorkOrigin {
  return storage.getStore() ?? { name: 'other', probe: false };
}

/** Runs `work` under an origin; a probe stays a probe in whatever it calls */
export function withOrigin<T>(name: string, work: () => T, options: { probe?: boolean } = {}): T {
  const probe = options.probe === true || storage.getStore()?.probe === true;
  return storage.run({ name, probe }, work);
}
