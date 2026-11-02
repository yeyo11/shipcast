import { z } from 'zod';
import { HINTS, tool, type ShipcastTool } from './shared.ts';

/* The bell: what needs the owner's attention (failures, accounts to reconnect, comments waiting), and its dismissals */

export const guide =
  'Attention: list_attention is where to start when asked what needs doing; each line\'s kind says which tool acts on it. dismiss_attention hides lines the user has dealt with or chose to ignore, until their condition changes.';

// The bell's limit and the shape of its keys (apps/web's MAX_ATTENTION_KEYS and ATTENTION_KEY), which this browser-safe package cannot import
const MAX_KEYS = 100;
const KEY = /^(launch|comments|account|metrics):[\w.:-]{1,120}$/;

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_attention',
    title: 'List what needs attention',
    description:
      'What needs the user in Shipcast now, as the app\'s bell lists it, less the lines dismissed: `count` is how many need them, `items` the lines, each with its `key`, `kind`, `text`, the `launchId` or `accountId` it is about and the app\'s `url`. By kind: ' +
      '`approve`, a launch\'s drafts wait for review: get_launch reads them, approve_drafts publishes (ask the user first). ' +
      '`retry`, a launch failed: get_launch lists the failed channels and why, retry_channel publishes one again; with `nothingOut: true` it failed before anything went out, and get_launch says why. ' +
      '`reply`, comments wait: list_comments, then edit_reply, approve_reply or dismiss_comment. ' +
      '`reconnect`, an account\'s credential stopped working: only the user can connect it again, in the app (the line\'s url), since credentials never go through the API; check_account confirms it works afterwards. ' +
      '`permission`, a source of numbers is refused, such as the GitHub App lacking Administration: read on a repo: the user grants it, outside Shipcast. ' +
      '`scheduled`, posts go out within a day: it only informs and is not counted; reschedule_post or cancel_scheduled_post change it. ' +
      '`canonical`, Google files an article page under another URL, so its search numbers go there: the site needs fixing, outside Shipcast. ' +
      '`drift`, Shipcast\'s copy of a launch differs from its drafts pull request: get_launch reads it.',
    operations: ['listAttention'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/attention'),
  }),
  tool({
    name: 'dismiss_attention',
    title: 'Dismiss attention lines',
    description:
      'Hide lines of list_attention, for the app\'s bell too, until their condition changes: a new failure, another problem with the account or a new comment comes back as a new line. It only changes Shipcast\'s list: nothing is approved, retried, answered or fixed. To clear the whole list, pass every key list_attention just gave, so a line that arrived since is not hidden unread.',
    operations: ['dismissAttention'],
    input: z.object({
      keys: z
        .array(z.string().regex(KEY, 'a line\'s `key`, as list_attention gives it'))
        .min(1)
        .max(MAX_KEYS)
        .describe(`The \`key\` of each line to hide, as list_attention gives it; 1 to ${MAX_KEYS}`),
    }),
    hints: HINTS.setting,
    run: (api, args) => api.call('POST', '/attention/dismiss', { body: { keys: args.keys } }),
  }),
];
