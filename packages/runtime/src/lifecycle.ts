/*
 * A process's start and stop, shared by the web app's launcher (main.ts, which owns the HTTP server)
 * and the bundled app (which owns the queue, the telemetry, Redis and the registry). They are one
 * process but load this module separately, so the state lives on globalThis.
 *
 * A stop, on SIGTERM or SIGINT, goes in this order: the process says it is draining (/readyz answers
 * 503, so the proxy sends no new requests), waits SHIPCAST_DRAIN_SECONDS for the proxy to notice (0
 * by default), stops taking HTTP and lets the requests in flight finish, stops the queue (the
 * running jobs get a while, then are handed back: pg-boss expires them, BullMQ's lock lapses and
 * another worker takes them), flushes the telemetry, closes Redis and the registry, and exits.
 */

export type StopPhase = 'http' | 'queue' | 'telemetry' | 'redis' | 'db';
const ORDER: readonly StopPhase[] = ['http', 'queue', 'telemetry', 'redis', 'db'];

interface State {
  draining: boolean;
  steps: Array<{ phase: StopPhase; name: string; run: () => Promise<void> }>;
  stopping: Promise<void> | undefined;
  signals: boolean;
}

const holder = globalThis as { __shipcastLifecycle?: State };
const state = (): State => (holder.__shipcastLifecycle ??= { draining: false, steps: [], stopping: undefined, signals: false });

/** Whether the process is on its way out: /readyz answers 503 from the first moment */
export const draining = (): boolean => state().draining;

/** A step of the stop, run in its phase's turn; steps of one phase run together */
export function onStop(phase: StopPhase, name: string, run: () => Promise<void>): void {
  state().steps.push({ phase, name, run });
}

/** Runs the stop once, whoever asks; errors of a step are logged and the next phases still run */
export function stopProcess(options: { drainMs?: number; log?: (line: string) => void } = {}): Promise<void> {
  const s = state();
  const log = options.log ?? ((line: string) => console.error(line));
  s.stopping ??= (async () => {
    s.draining = true;
    if (options.drainMs) await new Promise((r) => setTimeout(r, options.drainMs));
    for (const phase of ORDER) {
      await Promise.all(
        s.steps
          .filter((step) => step.phase === phase)
          .map((step) => step.run().catch((error: unknown) => log(`stopping ${step.name}: ${error instanceof Error ? error.message : String(error)}`))),
      );
    }
  })();
  return s.stopping;
}

/** Installs the signal handlers, once per process: the stop, then exit */
export function stopOnSignals(env: NodeJS.ProcessEnv = process.env): void {
  const s = state();
  if (s.signals) return;
  s.signals = true;
  const drainMs = Math.max(0, Number(env.SHIPCAST_DRAIN_SECONDS ?? 0) || 0) * 1000;
  const stop = (signal: NodeJS.Signals) => {
    console.log(`${signal}: draining, then stopping`);
    void stopProcess({ drainMs }).finally(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

/** For tests: forget every step and the draining state */
export function resetLifecycle(): void {
  holder.__shipcastLifecycle = undefined;
}
