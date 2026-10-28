import type { TelemetryStore } from '@shipcast/engine';
import { classify } from './classify.ts';
import { currentOrigin } from './origin.ts';
import { quotaOf } from './quota.ts';
import { TelemetryRecorder } from './recorder.ts';

/** The origin label of a call made for the measurement's own page loads */
export const PROBE_ORIGIN = 'probe';

const urlOf = (input: Parameters<typeof fetch>[0]): string => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const methodOf = (input: Parameters<typeof fetch>[0], init?: RequestInit): string => (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

/**
 * A fetch that counts every call it makes (provider, endpoint, status, time to the answer's
 * headers, Content-Length, rate-limit headers) under the origin running it, and changes nothing
 * else: same arguments, same answer, same error.
 */
export function instrumentFetch(inner: typeof fetch, recorder: TelemetryRecorder): typeof fetch {
  const counted = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const started = performance.now();
    const origin = currentOrigin();
    const target = classify(urlOf(input));
    const base = { origin: origin.probe ? PROBE_ORIGIN : origin.name, provider: target.provider, method: methodOf(input, init), endpoint: target.endpoint };
    let response: Response;
    try {
      response = await inner(input, init);
    } catch (error) {
      recorder.call({ ...base, status: 0, ms: performance.now() - started, bytes: 0 });
      throw error;
    }
    const length = Number(response.headers.get('content-length'));
    const quota = quotaOf(response.headers);
    recorder.call({ ...base, status: response.status, ms: performance.now() - started, bytes: Number.isFinite(length) ? length : 0, ...(quota && { quota }) });
    return response;
  };
  return counted as typeof fetch;
}

const INSTALLED = Symbol.for('shipcast.telemetry');
type Installed = { recorder: TelemetryRecorder; store: TelemetryStore | undefined };
const global = globalThis as typeof globalThis & { [INSTALLED]?: Installed };

/**
 * Makes this process count its outbound calls: `globalThis.fetch` is wrapped once, so every
 * connector, the GitHub client and the AI SDKs (which all fall back to it) are counted with no change
 * to them. Kept on `globalThis`, since the app's server bundle and its launcher are separate module
 * graphs in one process. A second call returns the recorder already installed.
 */
export function installTelemetry(processName: string): TelemetryRecorder {
  const there = global[INSTALLED];
  if (there) return there.recorder;
  const installed: Installed = { store: undefined, recorder: undefined as unknown as TelemetryRecorder };
  installed.recorder = new TelemetryRecorder({ process: processName, store: () => installed.store });
  global[INSTALLED] = installed;
  globalThis.fetch = instrumentFetch(globalThis.fetch.bind(globalThis), installed.recorder);
  installed.recorder.start();
  return installed.recorder;
}

/** Where the installed recorder writes, once the registry is open */
export function attachTelemetryStore(store: TelemetryStore): void {
  const there = global[INSTALLED];
  if (there) there.store = store;
}

/** The recorder this process installed, if any: what middleware and the queue time their work with */
export function telemetry(): TelemetryRecorder | undefined {
  return global[INSTALLED]?.recorder;
}
