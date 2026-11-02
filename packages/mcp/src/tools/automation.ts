import { CHANNELS } from '@shipcast/schema';
import { z } from 'zod';
import { accepted, confirm, HINTS, requireConfirm, tool, ToolRefused, type ShipcastTool } from './shared.ts';

/* How Shipcast hears of releases (polling, webhooks or off), the trigger rules, and a round run now */

export const guide =
  'Automation: get_automation reads the mode, the interval, the last round and the trigger rules; set_automation and set_triggers change them, and need confirm: true to turn anything on, since Shipcast then launches without the user; run_round_now runs a round at once, which may publish, so it needs confirm: true too.';

const ROUND =
  'A round looks for new releases (and repos made public) and drafts their launches, queues the publishing of every launch that is approved or whose channels are `auto`, and reads the networks\' numbers when they are due';

const confirmOn = z.boolean().optional().describe('Must be true to turn something on: the user agreed that Shipcast acts on its own from now on');

/** Turning automation on is not irreversible, but from then on Shipcast drafts and publishes without asking, so the user agrees first */
function requireOn(confirm: boolean | undefined, toolName: string, action: string): void {
  if (confirm !== true) {
    throw new ToolRefused(
      `Nothing was changed. ${action} makes Shipcast detect releases, draft launches and publish to \`auto\` channels without the user: ask the user, then call ${toolName} again with confirm: true.`,
    );
  }
}

const rule = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/, 'lowercase letters, digits and hyphens').describe('Stable and unique in the list, such as `releases`'),
  enabled: z.boolean().optional().describe('A rule turned off matches nothing; true by default'),
  event: z.enum(['release', 'public']).describe('`release`: a release is published; `public`: a repo goes from private to public'),
  repos: z.string().max(200).optional().describe('`*` (every repo, the default), `owner/*` or `owner/name`'),
  prereleases: z.boolean().optional().describe('Whether a pre-release triggers too; false by default'),
  channels: z
    .array(z.enum(CHANNELS))
    .nullable()
    .optional()
    .describe('For a repo without a .github/launch.yml: null (the default) leaves it alone, a list launches it on those channels, each waiting for approval. A repo with launch.yml keeps its own channels'),
});

export const tools: ShipcastTool[] = [
  tool({
    name: 'get_automation',
    title: 'Get the automation settings',
    description:
      'How Shipcast hears of releases and acts on them without the user: the mode (`poll`: rounds on a timer look for releases; `webhook`: GitHub tells Shipcast at once and the timer still publishes and reads numbers; `off`: nothing runs on its own), the seconds between rounds, whether a round is running, what the last round and the last webhook delivery did, the webhook URL and whether its secret is set (the secret itself is never given), and the trigger rules. Read this before set_automation or set_triggers; the work itself is in list_jobs.',
    operations: ['getAutomation'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/automation'),
  }),
  tool({
    name: 'set_automation',
    title: 'Change the automation settings',
    description:
      'Change the mode and/or the seconds between rounds; what is left out stays as it is. `poll` or `webhook` turns automation on: Shipcast then finds releases, drafts their launches and publishes to the channels a repo marks `auto` without asking anyone, so tell the user and call with `confirm: true`. `off` stops it (no confirm needed); the user can still launch by hand. The next round comes about 15 seconds later, at the new cadence from then on.',
    operations: ['setAutomation'],
    input: z.object({
      mode: z.enum(['poll', 'webhook', 'off']).optional().describe('`poll`, `webhook` (GitHub must be sending webhooks: see get_automation) or `off`'),
      interval_seconds: z.number().int().min(60).max(604_800).optional().describe('Seconds between rounds, 60 at least'),
      confirm: confirmOn,
    }),
    hints: HINTS.setting,
    run: (api, args) => {
      const change = { ...(args.mode !== undefined && { mode: args.mode }), ...(args.interval_seconds !== undefined && { intervalSeconds: args.interval_seconds }) };
      if (Object.keys(change).length === 0) throw new ToolRefused('set_automation needs mode, interval_seconds or both');
      if (args.mode !== undefined && args.mode !== 'off') requireOn(args.confirm, 'set_automation', `Turning automation on (${args.mode})`);
      return api.call('PATCH', '/automation', { body: change });
    },
  }),
  tool({
    name: 'set_triggers',
    title: 'Replace the trigger rules',
    description:
      'Replace the trigger rules, the whole list at once, which decide which GitHub events create a launch. An event takes the first enabled rule it matches, in the list\'s order; no match creates nothing, and an empty list means no event launches anything. A repo whose launch.yml says no is never launched. Read the current rules with get_automation first and send every rule to keep. A list with an enabled rule lets Shipcast launch on its own, so tell the user and call with `confirm: true`.',
    operations: ['setTriggers'],
    input: z.object({
      rules: z.array(rule).max(20).describe('Every rule, in the order they are tried; at most 20'),
      confirm: confirmOn,
    }),
    hints: HINTS.setting,
    run: (api, args) => {
      if (args.rules.some((r) => r.enabled !== false)) requireOn(args.confirm, 'set_triggers', 'Saving enabled trigger rules');
      return api.call('PUT', '/automation/triggers', { body: { rules: args.rules } });
    },
  }),
  tool({
    name: 'run_round_now',
    title: 'Run an automation round now',
    description: `Run an automation round now as a background job, whatever the mode, even off. ${ROUND}: so it may publish, publicly, whatever is already due, even while automation is off. The round already waiting is moved to now rather than doubled, and one already running is refused. Its result is lastRound in get_automation once it ends. Ask the user first, then call with confirm: true.`,
    operations: ['runRound'],
    input: z.object({ confirm }),
    hints: HINTS.work,
    run: async (api, args) => {
      requireConfirm(args.confirm, 'run_round_now', 'Running a round, which may publish what is due,');
      return accepted(await api.call('POST', '/automation/round'), 'Running an automation round', 'get_automation');
    },
  }),
];
