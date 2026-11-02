import { z } from 'zod';
import { accepted, accountId, HINTS, tool, type ShipcastTool } from './shared.ts';

/* The connected accounts Shipcast publishes with; their profiles are in profiles.ts, their growth in stats.ts */

export const guide =
  'Accounts: list_accounts gives the connected accounts, their ids and their last check; check_account checks one\'s credential again, sync_account reads its numbers now, rename_account changes its label and make_primary_account makes it the one its brand publishes with on its network. Connecting and disconnecting are done in the app.';

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_accounts',
    title: 'List connected accounts',
    description: 'The connected accounts Shipcast publishes with (one per network and brand), their public settings and the result of their last check. Secrets never leave the keychain.',
    operations: ['listAccounts'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/accounts'),
  }),
  tool({
    name: 'check_account',
    title: 'Check an account',
    description:
      'Check an account\'s credential again on its network, now, and record the answer: `status` ok with the `identity` it signs in as, or failed with the `problem` (an expired token, a revoked app). Use it when a post failed for the account or its last check is old; a failed account is fixed by connecting it again in the app, which no tool does. Nothing is posted.',
    operations: ['checkAccount'],
    input: z.object({ account_id: accountId }),
    hints: HINTS.work,
    run: (api, args) => api.call('POST', `/accounts/${args.account_id}/check`),
  }),
  tool({
    name: 'sync_account',
    title: 'Sync an account now',
    description:
      'Sync one account now instead of waiting for the daily run: a background job checks its credential again and records today\'s followers, following and posts. Calling it again while a sync of that account waits answers the same job. Nothing is posted.',
    operations: ['syncAccount'],
    input: z.object({ account_id: accountId }),
    hints: HINTS.work,
    run: async (api, args) => accepted(await api.call('POST', `/accounts/${args.account_id}/sync`), `Syncing account ${args.account_id}`, 'get_account_growth'),
  }),
  tool({
    name: 'rename_account',
    title: 'Rename an account',
    description: 'Change the label Shipcast shows for an account, to tell it apart from its network\'s other accounts. Only Shipcast\'s name for it changes; the profile on the network does not (edit_profile changes that).',
    operations: ['renameAccount'],
    input: z.object({ account_id: accountId, label: z.string().trim().min(1).max(200).describe('The new label, such as "Personal" or "@me@mastodon.social"') }),
    hints: HINTS.setting,
    run: (api, args) => api.call('PATCH', `/accounts/${args.account_id}`, { body: { label: args.label } }),
  }),
  tool({
    name: 'make_primary_account',
    title: 'Make an account primary',
    description:
      'Make an account the primary one of its network for its brand: the account every launch from now on publishes that channel with. The account that was primary stays connected and keeps its posts; posts already out are not moved. Check with the user which account should publish before calling this.',
    operations: ['makePrimaryAccount'],
    input: z.object({ account_id: accountId }),
    hints: HINTS.setting,
    run: (api, args) => api.call('POST', `/accounts/${args.account_id}/primary`),
  }),
];
