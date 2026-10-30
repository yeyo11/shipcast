import { newWebhookSecret, WEBHOOK_SECRET_KEY, writeAutomation, type AutomationMode } from '@shipcast/runtime';
import { CHANNELS } from '@shipcast/schema';
import { createServerFn } from '@tanstack/react-start';
import { automationChanged, automationView, roundNow } from './automation.server';
import { appContext } from './context.server';
import { jobsPage, type JobStateFilter } from './jobs.server';
import { InvalidInput, object } from './input';

export const getAutomation = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  return {
    ...(await automationView(ctx)),
    webhookUrl: `${ctx.app.publicUrl}/api/github/webhook`,
    hasSecret: Boolean(await ctx.secrets.get(WEBHOOK_SECRET_KEY)),
    // The App delivers for every repo it is installed on, signed with its own secret
    appWebhooks: Boolean(ctx.config.githubApp?.webhookSecret),
    launchesRepo: ctx.settings.launchesRepo(),
    owner: (await ctx.brand()).github,
    /** The queue's work of the last day: drafting, publishing, GitHub's deliveries (moved here from the launches list) */
    jobs: await jobsPage(ctx.registry, { page: 1, state: 'all' }),
    /** With `launch-triggers`: the rules that decide which GitHub events create a launch (docs/launch-triggers.md); null without */
    triggers: ctx.triggers ? await ctx.triggers.rules() : null,
    channels: [...CHANNELS],
  };
});

/** The trigger rules, replaced as a whole; each is checked by the engine, which says what is wrong */
export const saveTriggers = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (!Array.isArray(input)) throw new InvalidInput('the rules are a list');
    return input as unknown[];
  })
  .handler(async ({ data }) => {
    const ctx = await appContext();
    if (!ctx.triggers) return { ok: false as const, problem: 'trigger rules apply only with the launch-triggers flag on' };
    try {
      return { ok: true as const, rules: await ctx.triggers.save(data) };
    } catch (error) {
      return { ok: false as const, problem: error instanceof Error ? error.message : String(error) };
    }
  });

/** One page of the work list, for the filter and the pager on the Automation page */
export const getJobsPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    if (typeof o.page !== 'number' || !Number.isInteger(o.page) || o.page < 1) throw new InvalidInput('page must be a positive integer');
    if (o.state !== 'all' && o.state !== 'running' && o.state !== 'failed' && o.state !== 'done') throw new InvalidInput('state is all, running, failed or done');
    return { page: o.page, state: o.state as JobStateFilter };
  })
  .handler(async ({ data }) => jobsPage((await appContext()).registry, data));

export const saveAutomation = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    if (o.mode !== 'poll' && o.mode !== 'webhook' && o.mode !== 'off') throw new InvalidInput('mode is poll, webhook or off');
    if (typeof o.intervalSeconds !== 'number' || !Number.isFinite(o.intervalSeconds)) throw new InvalidInput('the interval is a number of seconds');
    return { mode: o.mode as AutomationMode, intervalSeconds: o.intervalSeconds };
  })
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const saved = await writeAutomation(ctx.registry, data);
    await automationChanged(ctx);
    return saved;
  });

/** A new secret replaces the old one at once: GitHub's webhooks must be given the new one */
export const rotateWebhookSecret = createServerFn({ method: 'POST' }).handler(async () => {
  const secret = newWebhookSecret();
  await (await appContext()).secrets.set(WEBHOOK_SECRET_KEY, secret, 'GitHub webhook secret');
  return { secret };
});

export const runRoundNow = createServerFn({ method: 'POST' }).handler(async () => {
  return { started: await roundNow(await appContext()) };
});
