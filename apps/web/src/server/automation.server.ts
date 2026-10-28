import { BY_HAND, lastHappened, LAST_DELIVERY_KEY, LAST_ROUND_KEY, readAutomation, roundRunning, scheduleRound } from '@shipcast/runtime';
import type { AppContext } from './context.server';

/**
 * Runs a round now, unless one is running already in this process or another: the round already
 * queued is moved to now, so it never makes a second one. What it did is kept for the Automation page.
 */
export async function roundNow(ctx: AppContext): Promise<boolean> {
  if (await roundRunning(ctx.registry)) return false;
  await scheduleRound(ctx.queue, BY_HAND);
  return true;
}

/** After the settings change: the next round soon, at the new cadence from then on; none while off */
export async function automationChanged(ctx: AppContext): Promise<void> {
  if ((await readAutomation(ctx.registry)).mode !== 'off') await scheduleRound(ctx.queue, 'settings changed', 15);
}

export async function automationView(ctx: Pick<AppContext, 'registry'>) {
  return {
    ...(await readAutomation(ctx.registry)),
    running: await roundRunning(ctx.registry),
    lastRound: await lastHappened(ctx.registry, LAST_ROUND_KEY),
    lastDelivery: await lastHappened(ctx.registry, LAST_DELIVERY_KEY),
  };
}
