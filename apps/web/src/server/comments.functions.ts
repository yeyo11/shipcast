import { REPLY_CAPABILITIES, REPLY_LIMITS } from '@shipcast/engine';
import { CHANNELS } from '@shipcast/schema';
import { createServerFn } from '@tanstack/react-start';
import { commentService } from './app-services';
import { commentView } from './comment-view';
import { readCommentsSearch } from './comments-search';
import { checkComments, commentDeps, redraftComment } from './comments.server';
import { appContext } from './context.server';
import { forOwner } from './errors';
import { id, object, text } from './input';

/** The comment service over the app's registry, replies sent with each post's account (commentDeps) */
const service = async () => commentService({ registry: (await appContext()).registry, sending: commentDeps });

/** One page of comments for the filters in the address, with what the filters can offer: a handful of queries whatever the list's size */
export const listComments = createServerFn({ method: 'GET' })
  .validator((input: unknown) => readCommentsSearch(object(input ?? {}, 'input')))
  .handler(async ({ data }) => {
    const comments = await service();
    const channel = CHANNELS.find((c) => c === data.channel);
    const { page, facets } = await comments.page({
      own: false,
      ...(data.state && { bucket: data.state }),
      ...(channel && { channel }),
      ...(data.launch && { launchId: data.launch }),
      ...(data.post && { postId: data.post }),
      ...(data.q && { search: data.q }),
      ...(data.page && { page: data.page }),
    });
    return {
      comments: page.comments.map(commentView),
      page: { number: page.page, pages: page.pages, total: page.total, size: page.pageSize },
      facets,
      settings: await comments.settings(),
      capabilities: REPLY_CAPABILITIES,
      limits: REPLY_LIMITS,
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
