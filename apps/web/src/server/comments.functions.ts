import { CommentRefused, dismissComment, editReplyDraft, InvalidCommentSettings, readCommentSettings, REPLY_CAPABILITIES, REPLY_LIMITS, sendReply, writeCommentSettings } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { commentView, commentViews } from './comment-view';
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

export const listComments = createServerFn({ method: 'GET' }).handler(async () => {
  const { registry } = await appContext();
  return {
    comments: await commentViews(registry, { own: false, limit: 200 }),
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
