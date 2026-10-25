import type { PostChanges } from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import { InvalidInput, list, object, text } from './input.ts';
import { channelName } from './requests.ts';

/** An absolute http(s) address: what a link or an image must be for every network to take it */
function address(value: unknown, name: string): string {
  const raw = text(value, name, 2000);
  try {
    if (['https:', 'http:'].includes(new URL(raw).protocol)) return raw;
  } catch {
    // falls through to the error below
  }
  throw new InvalidInput(`${name} must be an absolute http(s) URL`);
}

/** A change to published pieces, as a client sends it; at least one field */
export function postChanges(value: unknown): PostChanges {
  const body = object(value, 'the body');
  const changes: PostChanges = {
    ...(body.text !== undefined && { text: text(body.text, 'text') }),
    ...(body.title !== undefined && { title: text(body.title, 'title', 200) }),
    ...(body.tags !== undefined && { tags: list(body.tags, 'tags') }),
    ...(body.link !== undefined && { link: address(body.link, 'link') }),
    ...(body.imageUrl !== undefined && { imageUrl: address(body.imageUrl, 'imageUrl') }),
    ...(body.imageAlt !== undefined && { imageAlt: text(body.imageAlt, 'imageAlt', 1500) }),
  };
  if (changes.text !== undefined && changes.text.trim() === '') throw new InvalidInput('text cannot be empty');
  if (changes.tags && changes.tags.length > 10) throw new InvalidInput('at most 10 tags');
  if (Object.keys(changes).length === 0) throw new InvalidInput('send at least one of text, title, tags, link, imageUrl');
  return changes;
}

/** Channels named in a body's list or a query's comma-separated value; none means every channel */
export function channelList(value: unknown): Channel[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const names = typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : list(value, 'channels');
  return names.length === 0 ? undefined : names.map(channelName);
}
