import { channelDefinition, isMainPiece } from '@shipcast/schema/channels';
import type { PostChanges } from './edit.ts';

/*
 * The rules of an edit that the launch page needs before it asks, and the engine applies when it is
 * asked: which piece of a post is the one edited, which networks take a link only with the text,
 * which replace the text whole, which pieces are articles, and the text a link-after-text network
 * ends up showing. Each is read from the channel's definition (packages/schema/src/channels), so a
 * network states its rules once. Pure and free of Node, so the page's browser bundle imports this
 * module alone (`@shipcast/engine/edit-rules`) and the page and edit.ts can never disagree.
 * See docs/decisions/edit-delete.md
 */

/** A post's own piece, a blog article or a subreddit's post: what is edited and deleted (a story, a comment or a newsletter issue is not) */
export { isMainPiece };

/** A network whose post is text alone: a link goes after the text, so the text must come with it */
export const linkAfterText = (channel: string): boolean => channelDefinition(channel)?.edit.linkAfterText === true;

/** A network that replaces the text whole and cannot read it back: any change there needs the text */
export const textRequired = (channel: string): boolean => channelDefinition(channel)?.edit.textRequired === true;

/** A network whose piece is an article: the text is its whole body, the link its canonical URL, the image its cover */
export const carriesArticle = (channel: string): boolean => channelDefinition(channel)?.edit.article === true;

/** The text a network shows after an edit: on a text-only one, the text and then the link */
export function composedText(channel: string, changes: Pick<PostChanges, 'text' | 'link'>): string | undefined {
  if (changes.text === undefined) return undefined;
  return linkAfterText(channel) && changes.link ? `${changes.text.trimEnd()}\n\n${changes.link}` : changes.text;
}
