import { CommentRefused, dismissComment, editReplyDraft, InvalidCommentSettings, readCommentSettings, REPLY_CAPABILITIES, REPLY_LIMITS, sendReply, writeCommentSettings } from '@shipcast/engine';
import { CHANNELS } from '@shipcast/schema';
import { createServerFn } from '@tanstack/react-start';
import { commentView } from './comment-view';
import { readCommentsSearch } from './comments-search';
import { checkComments, commentDeps, redraftComment } from './comments.server';
import { appContext } from './context.server';
import { id, InvalidInput, object, text } from './input';

/** What the owner can act on comes back as a message for the page; a network's refusal too, in its words */
function asInput<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof CommentRefused || error instanceof InvalidCommentSettings) throw new InvalidInput(error.message);
    throw error;
  });
}

/** One page of comments for the filters in the address, with what the filters can offer: a handful of queries whatever the list's size */
export const listComments = createServerFn({ method: 'GET' })
  .validator((input: unknown) => readCommentsSearch(object(input ?? {}, 'input')))
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    const channel = CHANNELS.find((c) => c === data.channel);
    const [page, facets, posts] = await Promise.all([
      registry.commentsPage({
        own: false,
        ...(data.state && { bucket: data.state }),
        ...(channel && { channel }),
        ...(data.launch && { launchId: data.launch }),
        ...(data.post && { postId: data.post }),
        ...(data.q && { search: data.q }),
        ...(data.page && { page: data.page }),
      }),
      registry.commentFacets(false),
      data.launch ? registry.commentPosts(data.launch, false) : Promise.resolve([]),
    ]);
    return {
      comments: page.comments.map(commentView),
      page: { number: page.page, pages: page.pages, total: page.total, size: page.pageSize },
      facets: { ...facets, posts },
      settings: await readCommentSettings(registry),
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
  .handler(async ({ data }) => asInput(async () => commentView(await editReplyDraft(data.id, data.draft, (await appContext()).registry))));

export const approveReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => asInput(async () => commentView(await sendReply(data, await commentDeps()))));

export const dismissReply = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => asInput(async () => commentView(await dismissComment(data, (await appContext()).registry))));

export const saveCommentSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => object(input, 'input'))
  .handler(async ({ data }) => asInput(async () => writeCommentSettings((await appContext()).registry, data)));
