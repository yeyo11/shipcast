import { hourOf, observe, type CallCount, type Histogram, type TelemetryStore, type TimingCount, type TimingKind, type TimingOutcome } from '@shipcast/engine';

export interface CallSample {
  origin: string;
  provider: string;
  method: string;
  endpoint: string;
  status: number;
  ms: number;
  bytes: number;
  quota?: { used: number; limit?: number };
}

export interface TimingSample {
  kind: TimingKind;
  name: string;
  outcome: TimingOutcome;
  ms: number;
}

const FLUSH_MS = 60_000;
// The counters are kept for the next flush when a write fails; past this many keys they are dropped
// rather than growing without end while the database is away
const MAX_KEYS = 5_000;

/**
 * The process's counters between two flushes: each sample is added to its hour's row in memory and
 * written once a minute (and at stop), so measuring costs one small upsert a minute, not a write
 * per call. A sample is counted in the hour it was taken. Measuring never fails the work measured: a
 * failed write keeps the counts for the next try and says so once.
 */
export class TelemetryRecorder {
  readonly #process: string;
  readonly #store: () => TelemetryStore | undefined;
  readonly #now: () => Date;
  #calls = new Map<string, CallCount>();
  #timings = new Map<string, TimingCount>();
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> = Promise.resolve();
  #warned = false;

  /** `store` is read at each flush, so samples taken before the registry is open are kept for it */
  constructor(options: { process: string; store: () => TelemetryStore | undefined; now?: () => Date }) {
    this.#process = options.process;
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
  }

  get process(): string {
    return this.#process;
  }

  call(sample: CallSample): void {
    const hour = hourOf(this.#now());
    const key = [hour, sample.origin, sample.provider, sample.method, sample.endpoint, sample.status].join('\u0000');
    let row = this.#calls.get(key);
    if (!row) {
      if (this.#calls.size >= MAX_KEYS) return;
      row = { hour, process: this.#process, origin: sample.origin, provider: sample.provider, method: sample.method, endpoint: sample.endpoint, status: sample.status, calls: 0, totalMs: 0, bytes: 0, latency: {} };
      this.#calls.set(key, row);
    }
    row.calls += 1;
    row.totalMs += sample.ms;
    row.bytes += sample.bytes;
    observe(row.latency, sample.ms);
    if (sample.quota) {
      row.quotaPeak = Math.max(row.quotaPeak ?? 0, sample.quota.used);
      if (sample.quota.limit !== undefined) row.quotaLimit = sample.quota.limit;
    }
  }

  timing(sample: TimingSample): void {
    const hour = hourOf(this.#now());
    const key = [hour, sample.kind, sample.name, sample.outcome].join('\u0000');
    let row = this.#timings.get(key);
    if (!row) {
      if (this.#timings.size >= MAX_KEYS) return;
      row = { hour, process: this.#process, kind: sample.kind, name: sample.name, outcome: sample.outcome, count: 0, totalMs: 0, maxMs: 0, latency: {} };
      this.#timings.set(key, row);
    }
    row.count += 1;
    row.totalMs += sample.ms;
    row.maxMs = Math.max(row.maxMs, sample.ms);
    observe(row.latency, sample.ms);
  }

  /** Times `work` and records it under `kind` and `name`, whatever its outcome */
  async time<T>(kind: TimingKind, name: string, work: () => Promise<T>, outcomeOf: (error: unknown) => TimingOutcome = () => 'error'): Promise<T> {
    const started = performance.now();
    try {
      const result = await work();
      this.timing({ kind, name, outcome: 'ok', ms: performance.now() - started });
      return result;
    } catch (error) {
      this.timing({ kind, name, outcome: outcomeOf(error), ms: performance.now() - started });
      throw error;
    }
  }

  /** Flushes once a minute until stop(); the timer never keeps the process alive */
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
  }

  /** Writes what was counted since the last flush; one flush at a time */
  flush(): Promise<void> {
    this.#flushing = this.#flushing.then(() => this.#write());
    return this.#flushing;
  }

  async #write(): Promise<void> {
    const store = this.#store();
    if (!store || (this.#calls.size === 0 && this.#timings.size === 0)) return;
    const calls = this.#calls;
    const timings = this.#timings;
    this.#calls = new Map();
    this.#timings = new Map();
    try {
      await store.addCalls([...calls.values()]);
    } catch (error) {
      this.#keep(this.#calls, calls, (into, row) => addCall(into, row));
      this.#warn(error);
    }
    try {
      await store.addTimings([...timings.values()]);
    } catch (error) {
      this.#keep(this.#timings, timings, (into, row) => addTiming(into, row));
      this.#warn(error);
    }
  }

  /** Puts back what could not be written, adding to what was counted meanwhile */
  #keep<R>(into: Map<string, R>, from: Map<string, R>, add: (into: R, row: R) => void): void {
    for (const [key, row] of from) {
      const there = into.get(key);
      if (there) add(there, row);
      else if (into.size < MAX_KEYS) into.set(key, row);
    }
  }

  #warn(error: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    console.error(`telemetry: could not write the counters, kept for the next try (${error instanceof Error ? error.message : String(error)})`);
  }
}

function addLatency(into: Histogram, from: Histogram): void {
  for (const [bucket, count] of Object.entries(from)) into[bucket] = (into[bucket] ?? 0) + count;
}

function addCall(into: CallCount, row: CallCount): void {
  into.calls += row.calls;
  into.totalMs += row.totalMs;
  into.bytes += row.bytes;
  addLatency(into.latency, row.latency);
  if (row.quotaPeak !== undefined) into.quotaPeak = Math.max(into.quotaPeak ?? 0, row.quotaPeak);
  if (row.quotaLimit !== undefined) into.quotaLimit = row.quotaLimit;
}

function addTiming(into: TimingCount, row: TimingCount): void {
  into.count += row.count;
  into.totalMs += row.totalMs;
  into.maxMs = Math.max(into.maxMs, row.maxMs);
  addLatency(into.latency, row.latency);
}
