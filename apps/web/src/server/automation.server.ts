import {
  BY_HAND,
  lastHappened,
  LAST_DELIVERY_KEY,
  LAST_ROUND_KEY,
  readAutomation,
  roundRunning,
  scheduleRound,
  WEBHOOK_SECRET_KEY,
  writeAutomation,
  type Automation,
} from '@shipcast/runtime';
import type { TriggerRule } from '@shipcast/schema';
import type { AutomationApi, AutomationChange, AutomationState } from './automation-api.ts';
import type { AppContext } from './context.server';

/** What the automation services read and write; the whole context in the app, a few fakes in the tests */
export type AutomationContext = Pick<AppContext, 'registry' | 'queue' | 'secrets' | 'triggers'> & {
  app: Pick<AppContext['app'], 'publicUrl'>;
  config: Pick<AppContext['config'], 'githubApp'>;
};

/**
 * Runs a round now, unless one is running already in this process or another: the round already
 * queued is moved to now, so it never makes a second one. What it did is kept for the Automation page.
 */
export async function roundNow(ctx: Pick<AppContext, 'registry' | 'queue'>): Promise<{ ok: true; job: string | null } | { ok: false; problem: string }> {
  if (await roundRunning(ctx.registry)) return { ok: false, problem: 'a round is running already; its result is on the Automation page once it ends' };
  return { ok: true, job: await scheduleRound(ctx.queue, BY_HAND) };
}

/** After the settings change: the next round soon, at the new cadence from then on; none while off */
export async function automationChanged(ctx: Pick<AppContext, 'registry' | 'queue'>): Promise<void> {
  if ((await readAutomation(ctx.registry)).mode !== 'off') await scheduleRound(ctx.queue, 'settings changed', 15);
}

/** The mode and the interval saved (what is left out kept as it is), and the next round set to them */
export async function changeAutomation(ctx: Pick<AppContext, 'registry' | 'queue'>, change: AutomationChange): Promise<Automation> {
  const saved = await writeAutomation(ctx.registry, { ...(await readAutomation(ctx.registry)), ...change });
  await automationChanged(ctx);
  return saved;
}

/** The trigger rules replaced as a whole; each is checked by the engine, which says what is wrong */
export async function saveTriggerRules(ctx: Pick<AppContext, 'triggers'>, rules: unknown[]): Promise<TriggerRule[]> {
  return ctx.triggers.save(rules);
}

export async function automationView(ctx: Pick<AppContext, 'registry'>) {
  return {
    ...(await readAutomation(ctx.registry)),
    running: await roundRunning(ctx.registry),
    lastRound: await lastHappened(ctx.registry, LAST_ROUND_KEY),
    lastDelivery: await lastHappened(ctx.registry, LAST_DELIVERY_KEY),
  };
}

/** The settings and their state, the webhook's without its secret, and the rules: the page's and the API's */
export async function automationState(ctx: AutomationContext): Promise<AutomationState> {
  return {
    ...(await automationView(ctx)),
    webhookUrl: `${ctx.app.publicUrl}/api/github/webhook`,
    hasSecret: Boolean(await ctx.secrets.get(WEBHOOK_SECRET_KEY)),
    appWebhooks: Boolean(ctx.config.githubApp?.webhookSecret),
    triggers: await ctx.triggers.rules(),
  };
}

/** What the automation routes (automation-api.ts) run in the app's process, built per request by api-deps.server.ts */
export function automationApi(ctx: AutomationContext): AutomationApi {
  return {
    state: () => automationState(ctx),
    change: (change) => changeAutomation(ctx, change),
    saveTriggers: (rules) => saveTriggerRules(ctx, rules),
    roundNow: () => roundNow(ctx),
  };
}
