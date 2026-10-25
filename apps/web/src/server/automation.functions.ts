import { newWebhookSecret, WEBHOOK_SECRET_KEY, writeAutomation, type AutomationMode } from '@shipcast/runtime';
import { createServerFn } from '@tanstack/react-start';
import { automationChanged, automationView, roundNow } from './automation.server';
import { appContext } from './context.server';
import { InvalidInput, object } from './input';

export const getAutomation = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  return {
    ...(await automationView(ctx)),
    webhookUrl: `${ctx.app.publicUrl}/api/github/webhook`,
    hasSecret: Boolean(await ctx.secrets.get(WEBHOOK_SECRET_KEY)),
    launchesRepo: ctx.config.launchesRepo,
    owner: (await ctx.brand()).github,
  };
});

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
