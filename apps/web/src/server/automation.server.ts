import { lastHappened, LAST_DELIVERY_KEY, LAST_ROUND_KEY, readAutomation, record, runRound, type RoundDeps } from '@shipcast/runtime';
import type { AppContext } from './context.server';

let running = false;
let started = false;

/** The deps of a round, from the app's context */
export async function roundDeps(ctx: AppContext, log: (line: string) => void): Promise<RoundDeps> {
  return { env: process.env, registry: ctx.registry, github: ctx.github, secrets: ctx.secrets, brand: await ctx.brand(), pipeline: ctx.deps, log };
}

/** Runs one round now, unless one is already running; what it did is kept for the Automation page */
export async function roundNow(ctx: AppContext, reason: string): Promise<boolean> {
  if (running) return false;
  running = true;
  const lines: string[] = [];
  try {
    const mode = (await readAutomation(ctx.registry)).mode;
    await runRound(await roundDeps(ctx, (line) => lines.push(line)), { detect: mode === 'poll' || reason === 'by hand' });
  } catch (error) {
    lines.push(`the round failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    running = false;
    await record(ctx.registry, LAST_ROUND_KEY, { at: new Date().toISOString(), summary: lines.length ? `${reason}: ${lines.length} things happened` : `${reason}: nothing to do`, lines });
  }
  return true;
}

/**
 * The app's own timer: a round every interval, read again before each one so a change in the
 * Automation page takes effect at the next round. Started once, with the app's context.
 */
export function startAutomation(ctx: AppContext): void {
  if (started) return;
  started = true;
  const tick = async () => {
    // The next tick is set whatever happens to this one: a database that is down for a moment must
    // not stop the rounds for good
    let interval = 300;
    try {
      const automation = await readAutomation(ctx.registry);
      if (automation.mode !== 'off') await roundNow(ctx, automation.mode === 'poll' ? 'polling' : 'maintenance');
      interval = (await readAutomation(ctx.registry)).intervalSeconds;
    } catch (error) {
      console.error(`automation round failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    setTimeout(() => void tick(), interval * 1000).unref();
  };
  // A first round shortly after start, so a restart never waits a whole interval
  setTimeout(() => void tick(), 15_000).unref();
}

export async function automationView(ctx: AppContext) {
  return {
    ...(await readAutomation(ctx.registry)),
    running,
    lastRound: await lastHappened(ctx.registry, LAST_ROUND_KEY),
    lastDelivery: await lastHappened(ctx.registry, LAST_DELIVERY_KEY),
  };
}
