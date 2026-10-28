import type { Repositories } from '@shipcast/engine';

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
// Settings: what the owner chose. The last round and delivery are state, so they stay cursors
const MODE_KEY = 'automation:mode';
const INTERVAL_KEY = 'automation:interval';
export const LAST_ROUND_KEY = 'automation:last-round';
export const LAST_DELIVERY_KEY = 'automation:last-delivery';

export async function readAutomation(registry: Pick<Repositories, 'settings'>): Promise<Automation> {
  const mode = await registry.settings.setting<AutomationMode>(MODE_KEY);
  const interval = Number(await registry.settings.setting<number>(INTERVAL_KEY));
  return {
    mode: mode === 'webhook' || mode === 'off' ? mode : 'poll',
    intervalSeconds: Number.isFinite(interval) && interval >= MIN_INTERVAL_SECONDS ? interval : 300,
  };
}

export async function writeAutomation(registry: Pick<Repositories, 'settings'>, automation: Automation): Promise<Automation> {
  await registry.settings.setSetting<AutomationMode>(MODE_KEY, automation.mode);
  await registry.settings.setSetting<number>(INTERVAL_KEY, Math.max(MIN_INTERVAL_SECONDS, Math.round(automation.intervalSeconds)));
  return readAutomation(registry);
}

/** A short record of the last round or delivery, for the Automation page */
export interface Happened {
  at: string;
  summary: string;
  lines: string[];
}

export async function record(registry: Pick<Repositories, 'cursors'>, key: string, happened: Happened): Promise<void> {
  await registry.cursors.setCursor(key, JSON.stringify({ ...happened, lines: happened.lines.slice(-20) }));
}

export async function lastHappened(registry: Pick<Repositories, 'cursors'>, key: string): Promise<Happened | null> {
  const raw = await registry.cursors.cursor(key);
  try {
    return JSON.parse(raw ?? 'null') as Happened | null;
  } catch {
    return null;
  }
}
