import { REPLY_CAPABILITIES, REPLY_LIMITS } from '@shipcast/engine';
import { CHANNELS } from '@shipcast/schema';
import { readAutomation } from '@shipcast/runtime';
import { createServerFn } from '@tanstack/react-start';
import { commentService } from './app-services';
import { commentView } from './comment-view';
import { listFilter, readInboxSearch } from './comments-inbox';
import { commentThread, launchNames } from './comments-inbox.server';
import { checkComments, commentDeps, redraftComment } from './comments.server';
import { appContext } from './context.server';
import { forOwner } from './errors';
import { id, object, text } from './input';

/** The comment service over the app's registry, replies sent with each post's account (commentDeps) */
const service = async () => commentService({ registry: (await appContext()).registry, sending: commentDeps });

/**
 * One page of the inbox for the address (its tab and filters), with what the filters can offer, the
 * launches by name and, for the comment open to reply to (the first one when none is: a desktop
 * shows the list and the reply side by side), the post it answers. A handful of queries whatever the
 * list's size.
 */
export const listComments = createServerFn({ method: 'GET' })
  .validator((input: unknown) => readInboxSearch(object(input ?? {}, 'input')))
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const comments = await service();
    const filter = listFilter(data);
    const channel = CHANNELS.find((c) => c === filter.channel);
    const [{ page, facets }, settings, automation, accounts] = await Promise.all([
      comments.page({
        own: false,
        ...(filter.state && { bucket: filter.state }),
        ...(channel && { channel }),
        ...(filter.launch && { launchId: filter.launch }),
        ...(filter.post && { postId: filter.post }),
        ...(filter.q && { search: filter.q }),
        ...(filter.page && { page: filter.page }),
      }),
      comments.settings(),
      readAutomation(ctx.registry),
      ctx.registry.accounts.accounts(),
    ]);
    const openId = data.reply ?? page.comments[0]?.id;
    const record = openId === undefined ? undefined : (page.comments.find((c) => c.id === openId) ?? (await ctx.registry.comments.comment(openId)));
    const open = record && !record.own ? { comment: commentView(record), thread: await commentThread(ctx.registry, record) } : null;
    return {
      comments: page.comments.map(commentView),
      page: { number: page.page, pages: page.pages, total: page.total, size: page.pageSize },
      facets,
      // Every launch with a comment is in the facets, the open one's included
      launches: await launchNames(ctx.registry, facets.launches),
      open,
      settings,
      capabilities: REPLY_CAPABILITIES,
      limits: REPLY_LIMITS,
      /** The networks with a connected account: the reply settings list these */
      networks: [...new Set(accounts.map((a) => a.network))],
      automationOff: automation.mode === 'off',
      now: new Date().toISOString(),
    };
  });

export const checkCommentsNow = createServerFn({ method: 'POST' }).handler(async () => checkComments());

export const redraftReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => redraftComment(data));

export const saveReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: id(o.id), draft: text(o.draft, 'draft', 5000) };
  })
  .handler(async ({ data }) => forOwner(async () => commentView(await (await service()).editDraft(data.id, data.draft))));

export const approveReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => forOwner(async () => commentView(await (await service()).send(data))));

export const dismissReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => forOwner(async () => commentView(await (await service()).dismiss(data))));

export const saveCommentSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => object(input, 'input'))
  .handler(async ({ data }) => forOwner(async () => (await service()).saveSettings(data)));
