import type { ArticleInput } from '@shipcast/engine';
import { CHANNELS, type Channel } from '@shipcast/schema';
import { InvalidInput, list, object, text } from './input.ts';

/*
 * The shapes of the requests that start work, checked the same way whether they come from a page's
 * server function or from the REST API, so the two can never accept different things.
 */

export interface LaunchRequest {
  repo: string;
  ref: string | undefined;
  /** Straight to main and published, without a drafts pull request to review */
  direct: boolean;
}

export function launchRequest(input: unknown): LaunchRequest {
  const o = object(input, 'input');
  const repo = text(o.repo, 'repo', 140);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new InvalidInput('a repo is owner/name');
  return { repo, ref: o.ref === undefined || o.ref === null || o.ref === '' ? undefined : text(o.ref, 'ref', 140), direct: o.direct === true };
}

export function articleRequest(input: unknown): { input: ArticleInput; direct: boolean } {
  const o = object(input, 'input');
  const lang = text(o.lang, 'lang', 2);
  if (lang !== 'en' && lang !== 'es') throw new InvalidInput('lang is en or es');
  const channels = list(o.channels ?? [], 'channels').filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));
  const title = text(o.title, 'title', 200).trim();
  const markdown = text(o.markdown, 'markdown', 200_000);
  if (!title || !markdown.trim()) throw new InvalidInput('an article needs a title and a body');
  return { input: { title, markdown, lang, channels }, direct: o.direct === true };
}

export function channelName(value: unknown): Channel {
  const channel = text(value, 'channel', 40);
  if (!(CHANNELS as readonly string[]).includes(channel)) throw new InvalidInput('unknown channel');
  return channel as Channel;
}
