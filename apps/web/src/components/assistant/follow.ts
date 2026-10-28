import type { Interest, LiveEvent } from '../live/client';

/*
 * Following a job a request started, until its result: the job's own live events say when to read
 * it (`realtime-ui`), and without a live client it is read every few seconds, as the profile review
 * does. No React here: the reader, the client and the clock are given, so a test drives it with fakes.
 */

export interface FollowOptions<R> {
  /** The job's result, or undefined while it runs; a failure to read is tried again on the next event or tick */
  read(): Promise<R | undefined>;
  /** The tab's live client; none when the pages poll */
  live?: { register(interest: Interest): () => void };
  signal?: AbortSignal;
  /** Between two reads without a live client */
  everyMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** Resolves with the job's result once it has one; rejects when `signal` aborts */
export function followJob<R>(jobId: string, options: FollowOptions<R>): Promise<R> {
  const every = options.everyMs ?? 3000;
  const start = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stop = options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  return new Promise<R>((resolve, reject) => {
    let done = false;
    let reading = false;
    let unregister: (() => void) | undefined;
    let timer: unknown;
    const finish = () => {
      done = true;
      unregister?.();
      if (timer !== undefined) stop(timer);
      options.signal?.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      if (done) return;
      finish();
      reject(options.signal?.reason ?? new Error('aborted'));
    };
    const check = async () => {
      if (done || reading) return;
      reading = true;
      try {
        const result = await options.read().catch(() => undefined);
        if (result !== undefined && !done) {
          finish();
          resolve(result);
        }
      } finally {
        reading = false;
      }
    };
    if (options.signal?.aborted) return aborted();
    options.signal?.addEventListener('abort', aborted);
    if (options.live) {
      // Its end, or a resync (no event: whatever happened while the stream was down)
      unregister = options.live.register({
        topics: ['job'],
        accepts: (e: LiveEvent) => e.data.id === jobId && (e.data.state === 'completed' || e.data.state === 'failed'),
        reload: () => void check(),
        debounceMs: 0,
      });
    } else timer = start(() => void check(), every);
    // It may have ended before anything was registered
    void check();
  });
}
