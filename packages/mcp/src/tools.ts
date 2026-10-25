import { CHANNELS } from '@shipcast/schema';
import { z } from 'zod';
import type { ShipcastApi } from './client.ts';

/*
 * Shipcast's tools, defined once for both the MCP server and WebMCP. Each one is a single call of the
 * REST API, so a tool can do exactly what a token's scopes allow and nothing the app would refuse.
 * The descriptions are written for the model that picks the tool: what it does, when to use it, and
 * what it costs (a public post, a merge), since that is all the model sees.
 */

/** The MCP tool annotations; WebMCP maps them onto its own (readOnlyHint, consequentialHint) */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  /** Reaches past Shipcast: GitHub, the networks a post goes out on */
  openWorldHint: boolean;
}

export interface ShipcastTool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  hints: ToolHints;
  run(api: ShipcastApi, args: z.infer<S>): Promise<unknown>;
}

/** A refusal the tool makes itself before calling the API, such as a delete without `confirm` */
export class ToolRefused extends Error {}

const read: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const work: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

const launchId = z.number().int().positive().describe('The launch id, as list_launches gives it');
const postId = z.number().int().positive().describe('The post id, from the `posts` of get_launch');
const channel = z.enum(CHANNELS).describe('A channel of launch.yml');

/** Keeps the generic type of each tool while collecting them in one list */
const tool = <S extends z.ZodObject>(definition: ShipcastTool<S>): ShipcastTool => definition as unknown as ShipcastTool;

/** What a write that starts work answers: the job, to follow with list_jobs */
const accepted = (answer: unknown, what: string) => ({ ...(answer as object), note: `${what}. It runs as a background job: follow it with list_jobs, then get_launch.` });

const PUBLISHES = 'Publishing is public and happens once per launch; confirm with the user before calling this.';

export const TOOLS: ShipcastTool[] = [
  tool({
    name: 'list_launches',
    title: 'List launches',
    description:
      'List Shipcast launches (a release of a GitHub repo, or an article written by hand), newest first, with each one\'s status (detected, generating, drafted, published, skipped, failed), drafts pull request, posts and headline numbers. Pages with `cursor` (the `next` of the previous page).',
    input: z.object({
      limit: z.number().int().min(1).max(100).optional().describe('How many, 1 to 100; 20 by default'),
      cursor: z.string().optional().describe('The `next` value of the previous page'),
      status: z.enum(['detected', 'generating', 'drafted', 'published', 'skipped', 'failed']).optional().describe('Only launches in this state'),
    }),
    hints: read,
    run: (api, args) => api.call('GET', '/launches', { query: { limit: args.limit, cursor: args.cursor, status: args.status } }),
  }),
  tool({
    name: 'get_launch',
    title: 'Get a launch',
    description:
      'One launch in full: its published posts (with their ids, for edit_post and delete_post), failures per channel, the latest metrics, whether each search engine has indexed its articles, and its drafts pull request with the list of draft files (their text stays in the pull request).',
    input: z.object({ launch_id: launchId }),
    hints: read,
    run: (api, args) => api.call('GET', `/launches/${args.launch_id}`),
  }),
  tool({
    name: 'launch_repo',
    title: 'Launch a repo',
    description:
      'Launch a GitHub repo\'s release: Shipcast runs its pre-flight check (release, launch.yml, license, README, demo), analyses the repo and writes the content for every channel into a drafts pull request to review; approve_drafts publishes it. With `direct: true` it skips the review, commits to main and publishes at once. A release is launched only once: launching it again is refused. ' +
      PUBLISHES,
    input: z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name').describe('The GitHub repo, owner/name'),
      ref: z.string().min(1).max(140).optional().describe('The release tag, like v1.2.0; the latest release when left out'),
      direct: z.boolean().optional().describe('Publish without a drafts pull request to review; false by default'),
    }),
    hints: work,
    run: async (api, args) => accepted(await api.call('POST', '/launches', { body: { repo: args.repo, ...(args.ref && { ref: args.ref }), direct: args.direct === true } }), `Launching ${args.repo}`),
  }),
  tool({
    name: 'approve_drafts',
    title: 'Approve the drafts',
    description: 'Approve a launch\'s drafts: merges its drafts pull request on GitHub, then publishes every channel in its mode. Use get_launch first to see the drafts. ' + PUBLISHES,
    input: z.object({ launch_id: launchId }),
    hints: work,
    run: async (api, args) => accepted(await api.call('POST', `/launches/${args.launch_id}/approve`), `Approving launch ${args.launch_id}`),
  }),
  tool({
    name: 'write_article',
    title: 'Write an article',
    description:
      'Publish an article written by hand (not a release): it goes on the blog and Shipcast writes the pieces for the channels named, into a drafts pull request to review, or straight to publishing with `direct: true`. ' +
      PUBLISHES,
    input: z.object({
      title: z.string().min(1).max(200).describe('The article\'s title'),
      markdown: z.string().min(1).max(200_000).describe('The body in Markdown, without a top-level heading'),
      lang: z.enum(['en', 'es']).describe('The language it is written in'),
      channels: z.array(channel).optional().describe('Channels to announce it on, besides the blog'),
      direct: z.boolean().optional().describe('Publish without a drafts pull request to review; false by default'),
    }),
    hints: work,
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
    input: z.object({ launch_id: launchId, channel }),
    hints: work,
    run: async (api, args) => accepted(await api.call('POST', `/launches/${args.launch_id}/retry/${args.channel}`), `Retrying ${args.channel} on launch ${args.launch_id}`),
  }),
  tool({
    name: 'list_accounts',
    title: 'List connected accounts',
    description: 'The connected accounts Shipcast publishes with (one per network and brand), their public settings and the result of their last check. Secrets never leave the keychain.',
    input: z.object({}),
    hints: read,
    run: (api) => api.call('GET', '/accounts'),
  }),
  tool({
    name: 'list_jobs',
    title: 'List jobs',
    description: 'The background work running or finished in the last day (drafting, publishing, reading numbers), newest first, with each job\'s state and log. Follow a launch_repo, approve_drafts, write_article or retry_channel here.',
    input: z.object({}),
    hints: read,
    run: (api) => api.call('GET', '/jobs'),
  }),
  tool({
    name: 'get_capabilities',
    title: 'Get channel capabilities',
    description: 'What each channel can do with a post already published: whether it can be edited, deleted or only unpublished, and which fields an edit may change. Check this before edit_post or delete_post.',
    input: z.object({}),
    hints: read,
    run: (api) => api.call('GET', '/capabilities'),
  }),
  tool({
    name: 'edit_post',
    title: 'Edit a published post',
    description:
      'Edit one published post on its network, with the account it went out with. Give at least one field; a field the network does not take is refused (see get_capabilities). The change is public at once and replaces what was there; confirm the new text with the user first.',
    input: z
      .object({
        post_id: postId,
        text: z.string().min(1).optional().describe('The new text; on dev.to, Hashnode and the blog, the article\'s Markdown body'),
        title: z.string().min(1).max(200).optional().describe('Articles only: dev.to, Hashnode and the blog'),
        tags: z.array(z.string()).max(10).optional().describe('Articles only'),
        link: z.url().optional().describe('Added after the text on Mastodon, Telegram and Discord; the canonical URL on dev.to and Hashnode'),
        image_url: z.url().optional().describe('A new image: Mastodon, Telegram, and dev.to and Hashnode covers'),
        image_alt: z.string().optional().describe('What the image shows, where the network keeps it'),
      }),
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (api, args) => {
      const changes = {
        ...(args.text !== undefined && { text: args.text }),
        ...(args.title !== undefined && { title: args.title }),
        ...(args.tags !== undefined && { tags: args.tags }),
        ...(args.link !== undefined && { link: args.link }),
        ...(args.image_url !== undefined && { imageUrl: args.image_url }),
        ...(args.image_alt !== undefined && { imageAlt: args.image_alt }),
      };
      if (Object.keys(changes).length === 0) throw new ToolRefused('edit_post needs at least one field to change: text, title, tags, link, image_url or image_alt');
      return api.call('PATCH', `/posts/${args.post_id}`, { body: changes });
    },
  }),
  tool({
    name: 'delete_post',
    title: 'Delete a published post',
    description:
      'Delete one published post from its network (dev.to only unpublishes it); the launch never publishes it again, and it cannot be undone. Ask the user first, then call with `confirm: true`; without it nothing is deleted.',
    input: z.object({
      post_id: postId,
      confirm: z.boolean().optional().describe('Must be true: the user agreed to delete this post'),
    }),
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (api, args) => {
      // The schema allows false so the model gets this explanation rather than a bare validation error
      if (args.confirm !== true) throw new ToolRefused(`Nothing was deleted. Deleting post ${args.post_id} is permanent: ask the user, then call delete_post again with confirm: true.`);
      return api.call('DELETE', `/posts/${args.post_id}`);
    },
  }),
];

export const toolByName = (name: string): ShipcastTool | undefined => TOOLS.find((t) => t.name === name);
