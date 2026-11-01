import { PackKind } from '@shipcast/schema';
import { z } from 'zod';
import { accepted, channel, cursor, HINTS, launchId, limit, PUBLISHES, tool, type ShipcastTool } from './shared.ts';

/* Launches: finding them, starting one from a release or an article, approving its drafts, retrying a channel */

export const guide =
  'Launches: list_launches finds them (by state, how they started, pack, repo or words in them) and get_launch reads one in full. launch_repo, approve_drafts, write_article and retry_channel start background work that publishes publicly: confirm with the user first, then follow the job with list_jobs.';

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
      'One launch in full: its published posts (with their ids, for edit_post and delete_post), failures per channel, the latest metrics, whether each search engine has indexed its articles, and its drafts pull request with the list of draft files (their text stays in the pull request).',
    operations: ['getLaunch'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/launches/${args.launch_id}`),
  }),
  tool({
    name: 'launch_repo',
    title: 'Launch a repo',
    description:
      'Launch a GitHub repo\'s release: Shipcast runs its pre-flight check (release, launch.yml, license, README, demo), analyses the repo and writes the content for every channel into a drafts pull request to review; approve_drafts publishes it. With `direct: true` it skips the review, commits to main and publishes at once. A release is launched only once: launching it again is refused. ' +
      PUBLISHES,
    operations: ['launchRepo'],
    input: z.object({
      repo: repo.describe('The GitHub repo, owner/name'),
      ref: z.string().min(1).max(140).optional().describe('The release tag, like v1.2.0; the latest release when left out'),
      direct: z.boolean().optional().describe('Publish without a drafts pull request to review; false by default'),
    }),
    hints: HINTS.work,
    run: async (api, args) => accepted(await api.call('POST', '/launches', { body: { repo: args.repo, ...(args.ref && { ref: args.ref }), direct: args.direct === true } }), `Launching ${args.repo}`),
  }),
  tool({
    name: 'approve_drafts',
    title: 'Approve the drafts',
    description: 'Approve a launch\'s drafts: merges its drafts pull request on GitHub, then publishes every channel in its mode. Use get_launch first to see the drafts. ' + PUBLISHES,
    operations: ['approveLaunch'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.work,
    run: async (api, args) => accepted(await api.call('POST', `/launches/${args.launch_id}/approve`), `Approving launch ${args.launch_id}`),
  }),
  tool({
    name: 'write_article',
    title: 'Write an article',
    description:
      'Publish an article written by hand (not a release): it goes on the blog and Shipcast writes the pieces for the channels named, into a drafts pull request to review, or straight to publishing with `direct: true`. ' +
      PUBLISHES,
    operations: ['writeArticle'],
    input: z.object({
      title: z.string().min(1).max(200).describe('The article\'s title'),
      markdown: z.string().min(1).max(200_000).describe('The body in Markdown, without a top-level heading'),
      lang: z.enum(['en', 'es']).describe('The language it is written in'),
      channels: z.array(channel).optional().describe('Channels to announce it on, besides the blog'),
      direct: z.boolean().optional().describe('Publish without a drafts pull request to review; false by default'),
    }),
    hints: HINTS.work,
    run: async (api, args) =>
      accepted(
        await api.call('POST', '/articles', { body: { title: args.title, markdown: args.markdown, lang: args.lang, channels: args.channels ?? [], direct: args.direct === true } }),
        `Writing "${args.title}"`,
      ),
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
