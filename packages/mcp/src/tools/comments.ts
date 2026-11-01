import { COMMENT_CHANNELS, REPLY_CAPABILITIES, REPLY_LIMITS } from '@shipcast/schema';
import { z } from 'zod';
import { accepted, confirm, HINTS, launchId, requireConfirm, tool, ToolRefused, type ShipcastTool } from './shared.ts';

/* Comments under the launches' posts: reading and checking them, the assistant's drafted replies, and each channel's reply mode */

export const guide =
  'Comments under the posts: list_comments reads them with their drafted replies; check_comments and redraft_reply start background jobs to follow with list_jobs. edit_reply rewrites a draft and dismiss_comment drops a comment, both inside Shipcast; approve_reply sends a reply publicly and needs confirm: true after the user agrees. get_comment_settings and set_comment_settings read and set each channel\'s reply mode; setting one to auto needs confirm: true.';

// The engine's COMMENT_STATUSES and REPLY_MODES, which this browser-safe package cannot import
const STATUSES = ['new', 'draft-ready', 'approved', 'sent', 'dismissed', 'failed'] as const;
const MODES = ['off', 'approval', 'auto'] as const;

const commentId = z.number().int().positive().describe('The comment id, as list_comments gives it');
const commentChannel = z.enum(COMMENT_CHANNELS);

// Named in edit_reply's description so the model writes within the limit instead of learning it from a refusal
const LIMITS = Object.entries(REPLY_LIMITS)
  .map(([name, max]) => `${name} ${max}`)
  .join(', ');

/** The channels that can send a reply from Shipcast; on the others auto is stored as approval */
const sends = (name: string) => REPLY_CAPABILITIES[name]?.reply === true;

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_comments',
    title: 'List comments',
    description:
      'The comments people left under Shipcast\'s published posts (the owner\'s own left out), newest first, each with its status and the reply the assistant drafted: new (not drafted yet), draft-ready (a reply waits for approval; a null draft means the assistant suggests dismissing it), approved (being sent), sent, dismissed or failed (with its problem). Also answers what each channel can do: `canReply` false (dev.to) means the reply is posted by hand on the network. Filter by status, channel or launch.',
    operations: ['listComments'],
    input: z.object({
      status: z.enum(STATUSES).optional().describe('Only comments in this state; draft-ready lists the replies waiting for approval'),
      channel: commentChannel.optional().describe('Only this channel\'s comments'),
      launch_id: launchId.optional().describe('Only the comments on this launch\'s posts, as list_launches gives its id'),
    }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/comments', { query: { status: args.status, channel: args.channel, launch: args.launch_id } }),
  }),
  tool({
    name: 'check_comments',
    title: 'Check comments now',
    description:
      'Read every live post\'s comments on the networks now, instead of waiting for the next scheduled run, and draft a reply to each new one with the AI. On a channel whose reply mode is auto (get_comment_settings), the new drafts are sent publicly at once; elsewhere they wait for approve_reply. Starting it twice while it waits is the same job.',
    operations: ['checkComments'],
    input: z.object({}),
    hints: HINTS.work,
    run: async (api) => accepted(await api.call('POST', '/comments/check'), 'Checking the comments (the new drafts then show in list_comments)'),
  }),
  tool({
    name: 'redraft_reply',
    title: 'Draft a reply again',
    description:
      'Ask the AI for a fresh draft of one comment\'s reply, replacing the current draft (an edit by hand included). It never sends: the new draft waits for approval, and list_comments shows it once the job is done.',
    operations: ['redraftComment'],
    input: z.object({ comment_id: commentId }),
    hints: HINTS.work,
    run: async (api, args) => accepted(await api.call('POST', `/comments/${args.comment_id}/draft`), `Drafting the reply to comment ${args.comment_id} again`),
  }),
  tool({
    name: 'edit_reply',
    title: 'Edit a reply',
    description: `Write or rewrite one comment's reply by hand. It is only saved: nothing is sent, and the reply waits for approve_reply. A reply longer than its channel allows is refused (${LIMITS} characters; graphemes on Bluesky). A dismissed comment can be given a reply this way too.`,
    operations: ['editReply'],
    input: z.object({
      comment_id: commentId,
      draft: z.string().min(1).max(5000).describe('The reply\'s text, within the channel\'s limit'),
    }),
    hints: HINTS.setting,
    run: (api, args) => api.call('PATCH', `/comments/${args.comment_id}`, { body: { draft: args.draft } }),
  }),
  tool({
    name: 'approve_reply',
    title: 'Approve and send a reply',
    description:
      'Send one comment\'s drafted reply now, publicly, in the owner\'s name, with the account the post went out with; it goes out once and cannot be taken back from here. Read the draft with list_comments and show it to the user first, then call with `confirm: true`; without it nothing is sent. dev.to cannot send a reply through its API: there the user posts it by hand.',
    operations: ['approveReply'],
    input: z.object({ comment_id: commentId, confirm }),
    hints: HINTS.work,
    run: (api, args) => {
      requireConfirm(args.confirm, 'approve_reply', `Sending the reply to comment ${args.comment_id}`);
      return api.call('POST', `/comments/${args.comment_id}/approve`);
    },
  }),
  tool({
    name: 'dismiss_comment',
    title: 'Dismiss a comment',
    description:
      'Leave one comment without a reply: it is marked dismissed and nothing is sent. Use it for spam, abuse or what needs no answer (a null draft in list_comments is the assistant suggesting it). edit_reply can still give it a reply later.',
    operations: ['dismissComment'],
    input: z.object({ comment_id: commentId }),
    hints: HINTS.setting,
    run: (api, args) => api.call('POST', `/comments/${args.comment_id}/dismiss`),
  }),
  tool({
    name: 'get_comment_settings',
    title: 'Get the reply modes',
    description:
      'Each comment channel\'s reply mode: off (its comments are not read), approval (drafts wait for approve_reply, the default) or auto (Shipcast sends each draft publicly as soon as it is written).',
    operations: ['getCommentSettings'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/comment-settings'),
  }),
  tool({
    name: 'set_comment_settings',
    title: 'Set the reply modes',
    description:
      'Set the reply mode of the channels given; a channel left out keeps its mode. off stops reading its comments, approval makes every draft wait for approve_reply, and auto makes Shipcast reply publicly in the owner\'s name without asking anyone. Setting a channel to auto needs the user\'s agreement and `confirm: true`. dev.to cannot send, so its auto is stored as approval.',
    operations: ['setCommentSettings'],
    input: z.object({
      replies: z.partialRecord(commentChannel, z.enum(MODES)).describe('The new mode of each channel to change, like { "bluesky": "approval" }'),
      confirm: z.boolean().optional().describe('Must be true when a channel is set to auto: the user agreed to Shipcast replying there without asking'),
    }),
    hints: HINTS.setting,
    run: (api, args) => {
      const changes = Object.entries(args.replies).filter(([, mode]) => mode !== undefined);
      if (changes.length === 0) throw new ToolRefused(`set_comment_settings needs at least one channel in replies: ${COMMENT_CHANNELS.join(', ')}`);
      const auto = changes.filter(([name, mode]) => mode === 'auto' && sends(name)).map(([name]) => name);
      if (auto.length > 0 && args.confirm !== true) {
        throw new ToolRefused(
          `Nothing was changed. On auto, Shipcast sends its drafted replies on ${auto.join(', ')} publicly, in the owner's name, without asking: ask the user, then call set_comment_settings again with confirm: true.`,
        );
      }
      return api.call('PUT', '/comment-settings', { body: { replies: Object.fromEntries(changes) } });
    },
  }),
];
