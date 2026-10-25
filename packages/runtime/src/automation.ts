import type { Registry } from '@shipcast/engine';

/**
 * How the work nobody starts by hand gets done: `poll` runs full rounds on a timer, `webhook` lets
 * GitHub's deliveries claim releases and merges as they happen (the timer still publishes what is
 * ready, refreshes tokens and reads metrics), and `off` leaves everything to the owner's actions.
 */
export type AutomationMode = 'poll' | 'webhook' | 'off';

export interface Automation {
  mode: AutomationMode;
  /** Seconds between rounds; GitHub asks pollers of its events for 60 at least */
  intervalSeconds: number;
}

export const MIN_INTERVAL_SECONDS = 60;
const MODE_KEY = 'automation:mode';
const INTERVAL_KEY = 'automation:interval';
export const LAST_ROUND_KEY = 'automation:last-round';
export const LAST_DELIVERY_KEY = 'automation:last-delivery';

export function readAutomation(registry: Registry): Automation {
  const mode = registry.cursor(MODE_KEY);
  const interval = Number(registry.cursor(INTERVAL_KEY));
  return {
    mode: mode === 'webhook' || mode === 'off' ? mode : 'poll',
    intervalSeconds: Number.isFinite(interval) && interval >= MIN_INTERVAL_SECONDS ? interval : 300,
  };
}

export function writeAutomation(registry: Registry, automation: Automation): Automation {
  registry.setCursor(MODE_KEY, automation.mode);
  registry.setCursor(INTERVAL_KEY, String(Math.max(MIN_INTERVAL_SECONDS, Math.round(automation.intervalSeconds))));
  return readAutomation(registry);
}

/** A short record of the last round or delivery, for the Automation page */
export interface Happened {
  at: string;
  summary: string;
  lines: string[];
}

export function record(registry: Registry, key: string, happened: Happened): void {
  registry.setCursor(key, JSON.stringify({ ...happened, lines: happened.lines.slice(-20) }));
}

export function lastHappened(registry: Registry, key: string): Happened | null {
  try {
    return JSON.parse(registry.cursor(key) ?? 'null') as Happened | null;
  } catch {
    return null;
  }
}
