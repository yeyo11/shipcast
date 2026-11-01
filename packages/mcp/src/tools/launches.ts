import { PackKind } from '@shipcast/schema';
import { z } from 'zod';
import { accepted, channel, confirm, confirmDirect, cursor, HINTS, launchId, limit, PUBLISHES, requireConfirm, tool, type ShipcastTool } from './shared.ts';

/* Launches: finding them, starting one from a release or an article, approving its drafts, retrying a channel */

export const guide =
  'Launches: list_launches finds them and get_launch reads one in full (posts, failures, drafts). launch_repo and write_article draft one into a pull request for review, approve_drafts publishes it, retry_channel publishes a failed channel again.';

// The API's own lists (LAUNCH_STATUSES, TRIGGERS and LAUNCH_ORDERS of the engine), which this browser-safe package cannot import
const STATUSES = ['detected', 'generating', 'drafted', 'published', 'skipped', 'failed'] as const;
const TRIGGERS = ['release', 'manual', 'public', 'enabled', 'article'] as const;
const ORDERS = ['newest', 'oldest'] as const;

const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name');

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_launches',
    title: 'List launches',
    description:
      'List Shipcast launches (a release of a GitHub repo, or an article written by hand), newest first, with each one\'s status (detected, generating, drafted, published, skipped, failed), drafts pull request, posts and headline numbers. Filter by status, trigger, kind or repo, search with `q`, and page with `cursor` (the `next` of the previous page, sent with the same filters and sort).',
    operations: ['listLaunches'],
    input: z.object({
      limit: limit(20),
      cursor,
      status: z.enum(STATUSES).optional().describe('Only launches in this state'),
      trigger: z.enum(TRIGGERS).optional().describe('Only launches started this way: release (a GitHub release), manual (by hand), public (a repo made public), enabled (when launches were turned on) or article (written by hand)'),
      kind: z.enum(PackKind.options).optional().describe('Only launches of this pack: launch (a first launch), major or minor'),
      repo: repo.optional().describe('Only this repo\'s launches, owner/name'),
      q: z.string().max(200).optional().describe('Words in the repo, the ref or an article\'s title, case-insensitive'),
      sort: z.enum(ORDERS).optional().describe('newest first (the default) or oldest first; a cursor only works with the sort it came from'),
    }),
    hints: HINTS.read,
    run: (api, args) =>
      api.call('GET', '/launches', {
        query: { limit: args.limit, cursor: args.cursor, status: args.status, trigger: args.trigger, kind: args.kind, repo: args.repo, q: args.q, sort: args.sort },
      }),
  }),
  tool({
    name: 'get_launch',
    title: 'Get a launch',
    description:
      'One launch in full: its posts with their ids and status (published ones for edit_post and delete_post, `scheduled` ones for reschedule_post and cancel_scheduled_post), failures per channel (retry_channel), the latest metrics, whether each search engine has indexed its articles, and its drafts pull request with the list of draft files (their text stays in the pull request; approve_drafts publishes them). Its numbers over time are in get_stats_overview with its id in launch_ids.',
    operations: ['getLaunch'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/launches/${args.launch_id}`),
  }),
  tool({
    name: 'launch_repo',
    title: 'Launch a repo',
    description:
      'Launch a GitHub repo\'s release: Shipcast runs its pre-flight check (release, launch.yml, license, README, demo), analyses the repo and writes the content for every channel into a drafts pull request to review; approve_drafts publishes it. With `direct: true` it skips the review, commits to main and publishes at once, which needs `confirm: true` after the user agrees. A release is launched only once: launching it again is refused. ' +
      PUBLISHES,
    operations: ['launchRepo'],
    input: z.object({
      repo: repo.describe('The GitHub repo, owner/name'),
      ref: z.string().min(1).max(140).optional().describe('The release tag, like v1.2.0; the latest release when left out'),
      direct: z.boolean().optional().describe('Publish without a drafts pull request to review; false by default'),
      confirm: confirmDirect,
    }),
    hints: HINTS.work,
    run: async (api, args) => {
      if (args.direct === true) requireConfirm(args.confirm, 'launch_repo', `Publishing ${args.repo} without reviewing its drafts`);
      return accepted(await api.call('POST', '/launches', { body: { repo: args.repo, ...(args.ref && { ref: args.ref }), direct: args.direct === true } }), `Launching ${args.repo}`);
    },
  }),
  tool({
    name: 'approve_drafts',
    title: 'Approve the drafts',
    description:
      'Approve a launch\'s drafts: merges its drafts pull request on GitHub, then publishes every channel in its mode (scheduled channels at their time). This is the owner\'s approval: show the user the drafts pull request (get_launch) and call with `confirm: true` only once they say the drafts are good; without it nothing happens. ' +
      PUBLISHES,
    operations: ['approveLaunch'],
    input: z.object({ launch_id: launchId, confirm }),
    hints: HINTS.work,
    run: async (api, args) => {
      requireConfirm(args.confirm, 'approve_drafts', `Approving launch ${args.launch_id}, which publishes it,`);
      return accepted(await api.call('POST', `/launches/${args.launch_id}/approve`), `Approving launch ${args.launch_id}`);
    },
  }),
  tool({
    name: 'write_article',
    title: 'Write an article',
    description:
      'Publish an article written by hand (not a release): it goes on the blog and Shipcast writes the pieces for the channels named, into a drafts pull request to review, or straight to publishing with `direct: true` and `confirm: true`. ' +
      PUBLISHES,
    operations: ['writeArticle'],
    input: z.object({
      title: z.string().min(1).max(200).describe('The article\'s title'),
      markdown: z.string().min(1).max(200_000).describe('The body in Markdown, without a top-level heading'),
      lang: z.enum(['en', 'es']).describe('The language it is written in'),
      channels: z.array(channel).optional().describe('Channels to announce it on, besides the blog'),
      direct: z.boolean().optional().describe('Publish without a drafts pull request to review; false by default'),
      confirm: confirmDirect,
    }),
    hints: HINTS.work,
    run: async (api, args) => {
      if (args.direct === true) requireConfirm(args.confirm, 'write_article', `Publishing "${args.title}" without reviewing its drafts`);
      return accepted(
        await api.call('POST', '/articles', { body: { title: args.title, markdown: args.markdown, lang: args.lang, channels: args.channels ?? [], direct: args.direct === true } }),
        `Writing "${args.title}"`,
      );
    },
  }),
  tool({
    name: 'retry_channel',
    title: 'Retry a channel',
    description: 'Give a channel that failed for good on a launch another chance: forgets the failure and publishes that channel again. get_launch lists the failures.',
    operations: ['retryChannel'],
    input: z.object({ launch_id: launchId, channel }),
    hints: HINTS.work,
    run: async (api, args) => accepted(await api.call('POST', `/launches/${args.launch_id}/retry/${args.channel}`), `Retrying ${args.channel} on launch ${args.launch_id}`),
  }),
];
