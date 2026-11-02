import { z } from 'zod';
import { accepted, confirm, HINTS, launchId, PUBLISHES, requireConfirm, tool, type ShipcastTool } from './shared.ts';

/* A launch's drafts before they are approved: read and edited, previewed on the site; and a whole launch published again */

export const guide =
  'Drafts, before approve_drafts: get_launch lists a launch\'s draft files, get_draft reads one in full and edit_draft replaces its text until that piece is out (an edit after approval needs approve_drafts again). preview_on_site puts a launch\'s article on a preview of the real site, and get_site_preview gives its address once deployed, a few minutes later. publish_again sends what an approved launch still has pending; retry_channel is for one channel that failed.';

const path = z.string().min(1).max(300).describe('The draft\'s path, as get_launch lists them under drafts.files');

export const tools: ShipcastTool[] = [
  tool({
    name: 'get_draft',
    title: 'Read a draft',
    description:
      'Read one draft of a launch in full: an article\'s Markdown or a channel\'s piece, as its current version; media come with their address instead. `open` says whether the drafts can still be edited. Read a draft before edit_draft, which replaces the whole text.',
    operations: ['getDraft'],
    input: z.object({ launch_id: launchId, path }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/launches/${args.launch_id}/draft`, { query: { path: args.path } }),
  }),
  tool({
    name: 'edit_draft',
    title: 'Edit a draft',
    description:
      'Replace one draft\'s whole text before it goes out, as a new version. Nothing is published. An edit made after approve_drafts is not covered by that approval: that piece waits until the drafts are approved again. Refused for a piece already out (edit it with edit_post), an article already on the site, a text too long for its network, and a launch decided in its pull request before Shipcast held its drafts. Send the full text as get_draft gives it, changed.',
    operations: ['editDraft'],
    input: z.object({ launch_id: launchId, path, content: z.string().max(200_000).describe('The draft\'s whole new text') }),
    // The draft is a version in Shipcast's own rows: nothing reaches GitHub or a network
    hints: HINTS.setting,
    run: (api, args) => api.call('PUT', `/launches/${args.launch_id}/draft`, { body: { path: args.path, content: args.content } }),
  }),
  tool({
    name: 'preview_on_site',
    title: 'Preview on the real site',
    description:
      'Push a launch\'s article and media to a preview branch of the public launches repo, with a draft pull request that is never merged, which the site deploys to an address nobody can guess. It answers at once with the preview\'s branch and pull request; the address takes a few minutes: read it with get_site_preview. Asked again, the same preview is updated. Refused for an old launch decided in its pull request, which had its own preview.',
    operations: ['requestSitePreview'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.work,
    run: (api, args) => api.call('POST', `/launches/${args.launch_id}/site-preview`),
  }),
  tool({
    name: 'get_site_preview',
    title: 'Get the site preview',
    description:
      'The preview on the real site that preview_on_site asked for, with its address in `url` once deployed (a few minutes after asking); without `url` it is still being deployed, so try again later. `urlSha` older than `sha` means the address still shows the previous version.',
    operations: ['getSitePreview'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/launches/${args.launch_id}/site-preview`),
  }),
  tool({
    name: 'publish_again',
    title: 'Publish a launch again',
    description:
      'Publish what a drafted launch still has pending, such as after its drafts were approved and the publishing never ran: every channel its approval clears goes out publicly, in its mode (scheduled ones at their time). A piece already out is never sent again, and a launch whose drafts still wait for approval publishes nothing. Refused for a launch that is not drafted (published, failed, skipped). For one channel that failed, use retry_channel. ' +
      PUBLISHES +
      ' Call with confirm: true once they agree.',
    operations: ['publishLaunchAgain'],
    input: z.object({ launch_id: launchId, confirm }),
    hints: HINTS.work,
    run: async (api, args) => {
      requireConfirm(args.confirm, 'publish_again', `Publishing launch ${args.launch_id}`);
      return accepted(await api.call('POST', `/launches/${args.launch_id}/publish`), `Publishing what launch ${args.launch_id} has pending`);
    },
  }),
];
