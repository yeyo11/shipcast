import type { Account } from '@shipcast/engine';
import { checkAccount, syncNow } from '@shipcast/runtime';
import type { AccountsApi } from './accounts-api.ts';
import type { WorkAnswer } from './api.ts';
import { accountService } from './app-services';
import { accountDepsOf } from './channels.server';
import type { AppContext } from './context.server.ts';

/*
 * What is done to a connected account, as the account routes (accounts-api.ts) and the Channels
 * page's server functions (channels.functions.ts) both need it: one implementation, two doors.
 * Connecting and disconnecting are not here: they move credentials, which only the app does
 * (channels.server.ts).
 */

/** Checks an account's credential again and records the answer; undefined when there is no such account */
export async function recheck(ctx: AppContext, accountId: number): Promise<Account | undefined> {
  const deps = await accountDepsOf(ctx);
  if (!(await deps.registry.accounts.account(accountId))) return undefined;
  return checkAccount(deps, accountId);
}

/**
 * Queues the account's sync (its check, then today's numbers) as a snapshots job; undefined when
 * there is no such account. A sync already queued for it is the job that answers.
 */
export async function startSync(ctx: Pick<AppContext, 'queue' | 'registry'>, accountId: number): Promise<WorkAnswer | undefined> {
  const account = await accountService(ctx).get(accountId);
  if (!account) return undefined;
  const job = await syncNow(ctx.queue, account);
  return job ? { ok: true, job } : { ok: false, problem: 'the sync could not be queued' };
}

/** What the account routes run in the app's process, built per request by api-deps.server.ts */
export function accountsApi(ctx: AppContext): AccountsApi {
  return {
    check: (accountId) => recheck(ctx, accountId),
    sync: (accountId) => startSync(ctx, accountId),
  };
}
