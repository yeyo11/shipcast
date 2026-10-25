import { readFileSync } from 'node:fs';
import { checkAccount, connectAccount, disconnectAccount, importFromEnv, MissingField, splitFields, syncNow } from '@shipcast/runtime';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { id, object, text, texts } from './input';
import { accountDeps, channelsView } from './channels.server';

export const getChannels = createServerFn({ method: 'GET' }).handler(() => channelsView());

export const connectWithForm = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { network: text(o.network, 'network', 40), brand: text(o.brand, 'brand', 40), label: text(o.label, 'label', 200), values: texts(o.values, 'values') };
  })
  .handler(async ({ data }) => {
    try {
      const credentials = splitFields(data.network, data.values);
      const result = await connectAccount(await accountDeps(), { network: data.network, brand: data.brand, label: data.label, credentials });
      return result.ok ? { ok: true as const, id: result.account.id, identity: result.account.identity ?? result.account.label } : { ok: false as const, problem: result.problem };
    } catch (error) {
      return { ok: false as const, problem: error instanceof MissingField ? error.message : `could not connect: ${error instanceof Error ? error.message : String(error)}` };
    }
  });

export const recheckAccount = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const account = await checkAccount(await accountDeps(), data);
    return { status: account.status, problem: account.problem, identity: account.identity };
  });

/**
 * Sync now: a snapshots job for this account, which checks it again and records today's numbers.
 * The request waits a little for it, since a sync takes a second or two; a slower one is left
 * running and the page says so.
 */
export const syncAccountNow = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const { queue, registry } = await appContext();
    const account = await registry.account(data);
    if (!account) return { state: 'failed' as const, lines: ['That account is no longer connected'] };
    const job = await syncNow(queue, account);
    if (!job) return { state: 'failed' as const, lines: ['The sync could not be queued'] };
    const done = await queue.wait(job, 20_000, 500);
    return { state: done?.state ?? ('queued' as const), lines: done?.log ?? [] };
  });

export const renameAccount =createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), label: text(o.label, 'label', 200) };
  })
  .handler(async ({ data }) => {
    const label = data.label.trim();
    if (!label) return { ok: false };
    await (await appContext()).registry.updateAccount(data.id, { label });
    return { ok: true };
  });

export const makePrimary = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    await (await appContext()).registry.makePrimary(data);
    return { ok: true };
  });

export const disconnect = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    await disconnectAccount(await accountDeps(), data);
    return { ok: true };
  });

export const importEnv = createServerFn({ method: 'POST' }).handler(async () => {
  const results = await importFromEnv(await accountDeps(), process.env, (p) => readFileSync(p, 'utf8'));
  return results.map((r) => ({ network: r.network, ok: r.result.ok, problem: r.result.ok ? null : r.result.problem }));
});
