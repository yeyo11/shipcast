import { z } from 'zod';
import { confirm, HINTS, postId, requireConfirm, tool, ToolRefused, type ShipcastTool } from './shared.ts';

/* Published posts, one at a time: what each channel can do with one, editing and deleting it on its network */

export const guide =
  'Posts: get_capabilities says what each channel can edit or delete; edit_post and delete_post change one live post on its network.';

export const tools: ShipcastTool[] = [
  tool({
    name: 'get_capabilities',
    title: 'Get channel capabilities',
    description: 'What each channel can do with a post already published: whether it can be edited, deleted or only unpublished, and which fields an edit may change. Check this before edit_post or delete_post.',
    operations: ['listCapabilities'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/capabilities'),
  }),
  tool({
    name: 'edit_post',
    title: 'Edit a published post',
    description:
      'Edit one published post on its network, with the account it went out with. Give at least one field; a field the network does not take is refused (see get_capabilities). The change is public at once and replaces what was there: show the user the new text, then call with `confirm: true`; without it nothing changes. edit_launch_posts changes every post of a launch at once.',
    operations: ['editPost'],
    input: z.object({
      post_id: postId,
      text: z.string().min(1).optional().describe('The new text; on dev.to, Hashnode and the blog, the article\'s Markdown body'),
      title: z.string().min(1).max(200).optional().describe('Articles only: dev.to, Hashnode and the blog'),
      tags: z.array(z.string()).max(10).optional().describe('Articles only'),
      link: z.url().optional().describe('Added after the text on Mastodon, Telegram and Discord; the canonical URL on dev.to and Hashnode'),
      image_url: z.url().optional().describe('A new image: Mastodon, Telegram, and dev.to and Hashnode covers'),
      image_alt: z.string().optional().describe('What the image shows, where the network keeps it'),
      confirm,
    }),
    hints: HINTS.destructive,
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
      requireConfirm(args.confirm, 'edit_post', `Changing post ${args.post_id} in public`);
      return api.call('PATCH', `/posts/${args.post_id}`, { body: changes });
    },
  }),
  tool({
    name: 'delete_post',
    title: 'Delete a published post',
    description:
      'Delete one published post from its network (dev.to only unpublishes it); the launch never publishes it again, and it cannot be undone. Ask the user first, then call with `confirm: true`; without it nothing is deleted.',
    operations: ['deletePost'],
    input: z.object({ post_id: postId, confirm }),
    hints: HINTS.destructive,
    run: (api, args) => {
      requireConfirm(args.confirm, 'delete_post', `Deleting post ${args.post_id}`);
      return api.call('DELETE', `/posts/${args.post_id}`);
    },
  }),
];
