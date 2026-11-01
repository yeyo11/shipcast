import type { CommentRecord, Repositories } from '@shipcast/engine';
import { channelDefinition } from '@shipcast/schema/channels';
import { draftBody } from '@shipcast/schema/markdown';
import { launchName } from './attention.ts';

/*
 * What the inbox shows around a comment that the comment row does not carry: the launch it is on by
 * name, and for the comment opened to reply to, the post it answers (its text, as the piece's draft
 * has it) and the account the reply would go out under.
 */

type Registry = Pick<Repositories, 'launches' | 'posts' | 'accounts' | 'launchStore'>;

/** The launches the comments are on, by id: their title, or the repo and tag */
export async function launchNames(registry: Pick<Repositories, 'launches'>, launches: ReadonlyArray<{ id: number; repo: string; ref: string }>): Promise<Record<number, string>> {
  const named = await Promise.all(
    launches.map(async (l) => {
      const fields = await registry.launches.modelFields(l.id).catch(() => undefined);
      return [l.id, fields?.title?.trim() || launchName(l.repo, l.ref)] as const;
    }),
  );
  return Object.fromEntries(named);
}

export interface CommentThread {
  /** The post's own words, when its draft is kept; Shipcast keeps no copy of an older post */
  postText: string | null;
  postUrl: string | null;
  /** Who the reply goes out as: the account the post went out with */
  account: string | null;
}

export async function commentThread(registry: Registry, comment: CommentRecord): Promise<CommentThread> {
  const post = await registry.posts.post(comment.postId);
  if (!post) return { postText: null, postUrl: null, account: null };
  const [drafts, account] = await Promise.all([registry.launchStore.drafts(comment.launchId), post.accountId ? registry.accounts.account(post.accountId) : Promise.resolve(undefined)]);
  const draft = drafts.find((d) => d.channel === post.channel && d.piece === post.kind);
  let postText: string | null = null;
  if (draft) {
    // A channel's draft opens with its heading and the approval note, which are never the post's
    const body = draftBody(draft.body);
    postText = channelDefinition(post.channel)?.draft?.read(body)?.text ?? body;
  }
  return { postText: postText?.trim() || null, postUrl: post.url, account: account ? (account.identity ?? account.label) : null };
}
