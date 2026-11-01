import { z } from 'zod';
import { HINTS, tool, type ShipcastTool } from './shared.ts';

/* The connected accounts Shipcast publishes with; their profiles are in profiles.ts, their growth in stats.ts */

export const guide = 'Accounts: list_accounts gives the connected accounts, their ids and their last check.';

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
];
