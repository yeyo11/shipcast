import type { PostChanges } from './edit.ts';

/*
 * The rules of an edit that the launch page needs before it asks, and the engine applies when it is
 * asked: which piece of a post is the one edited, which networks take a link only with the text,
 * which replace the text whole, which pieces are articles, and the text a link-after-text network
 * ends up showing. Pure and free of Node, so the page's browser bundle imports this module alone
 * (`@shipcast/engine/edit-rules`) and the page and edit.ts can never disagree.
 * See docs/decisions/edit-delete.md
 */

/** A post's own piece, a blog article or a subreddit's post: what is edited and deleted (a story, a comment or a newsletter issue is not) */
export function isMainPiece(channel: string, kind: string): boolean {
  if (channel === 'blog') return kind.startsWith('article:');
  return channel === 'reddit' ? kind.startsWith('post:') : kind === 'post';
}

/** Networks whose post is text alone: a link goes after the text, so the text must come with it */
export const TEXT_ONLY_POSTS: readonly string[] = ['mastodon', 'telegram', 'discord'];

/** Networks that replace the text whole and cannot read it back: any change there needs the text */
export const TEXT_REPLACED_WHOLE: readonly string[] = ['telegram', 'discord'];

/** Networks whose piece is an article: the text is its whole body, the link its canonical URL, the image its cover */
export const ARTICLE_CHANNELS: readonly string[] = ['devto', 'hashnode', 'blog'];

/** The text a network shows after an edit: on a text-only one, the text and then the link */
export function composedText(channel: string, changes: Pick<PostChanges, 'text' | 'link'>): string | undefined {
  if (changes.text === undefined) return undefined;
  return TEXT_ONLY_POSTS.includes(channel) && changes.link ? `${changes.text.trimEnd()}\n\n${changes.link}` : changes.text;
}
