import { SOURCE_LIMITS, type ArticleInput, type SourceInput, type SourcesLaunchInput } from '@shipcast/engine';
import { CHANNELS, type Channel } from '@shipcast/schema';
import { id, InvalidInput, list, object, text } from './input.ts';

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

const optional = (value: unknown, name: string, max: number) => (value === undefined || value === null || value === '' ? undefined : text(value, name, max));

/** One source of a launch made from sources, by its kind; anything else in it is refused rather than ignored */
function sourceInput(value: unknown, name: string): SourceInput {
  const o = object(value, name);
  const kind = text(o.kind, `${name}.kind`, 10);
  if (kind === 'text') {
    const title = optional(o.title, `${name}.title`, SOURCE_LIMITS.titleChars);
    return { kind, text: text(o.text, `${name}.text`, SOURCE_LIMITS.textChars), ...(title && { title }) };
  }
  if (kind === 'url') return { kind, url: text(o.url, `${name}.url`, 2000) };
  if (kind === 'repo') {
    const ref = optional(o.ref, `${name}.ref`, 140);
    return { kind, repo: text(o.repo, `${name}.repo`, 140), ...(ref && { ref }), ...(o.primary === true && { primary: true }) };
  }
  if (kind === 'media') {
    const label = optional(o.name, `${name}.name`, SOURCE_LIMITS.labelChars);
    const alt = optional(o.alt, `${name}.alt`, SOURCE_LIMITS.labelChars);
    return { kind, sha256: text(o.sha256, `${name}.sha256`, 64), ...(label && { name: label }), ...(alt && { alt }) };
  }
  throw new InvalidInput(`${name}.kind is text, url, repo or media`);
}

/** A launch made from sources: its title, language, channels and sources (the engine's checkSources judges the rest) */
export function sourcesRequest(input: unknown): SourcesLaunchInput {
  const o = object(input, 'input');
  const lang = text(o.lang ?? 'en', 'lang', 2);
  if (lang !== 'en' && lang !== 'es') throw new InvalidInput('lang is en or es');
  const channels = list(o.channels ?? [], 'channels').filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c));
  if (!Array.isArray(o.sources)) throw new InvalidInput('sources must be a list');
  if (o.sources.length > SOURCE_LIMITS.sources) throw new InvalidInput(`a launch has at most ${SOURCE_LIMITS.sources} sources`);
  return { title: text(o.title, 'title', SOURCE_LIMITS.titleChars).trim(), lang, channels, sources: o.sources.map((s, i) => sourceInput(s, `sources[${i}]`)) };
}

/** A moment with its offset; a time without one would be read in the server's zone, which is nobody's choice */
export function moment(value: unknown, name: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new InvalidInput(`${name} is an ISO 8601 date-time with its offset, such as 2026-10-27T17:00:00+01:00`);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new InvalidInput(`${name} is not a real date`);
  return at;
}

export function channelName(value: unknown): Channel {
  const channel = text(value, 'channel', 40);
  if (!(CHANNELS as readonly string[]).includes(channel)) throw new InvalidInput('unknown channel');
  return channel as Channel;
}

/**
 * An approval: the launch, and for a launch Shipcast holds the versions the owner read (the review's
 * `app.versions`, draft id to version id), so a draft changed since is refused instead of approved
 * unseen. An id alone is still read, as the API took it before.
 */
export function approvalRequest(input: unknown): { id: number; versions: Record<string, number> | undefined } {
  if (typeof input === 'number') return { id: id(input), versions: undefined };
  const o = object(input, 'input');
  return { id: id(o.id), versions: approvalVersions(o.versions) };
}

export function approvalVersions(value: unknown): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined;
  const o = object(value, 'versions');
  const entries = Object.entries(o);
  if (entries.length > 500) throw new InvalidInput('versions names too many drafts');
  for (const [key, version] of entries) {
    if (!/^\d{1,10}$/.test(key) || typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) throw new InvalidInput('versions maps each draft id to the version id read');
  }
  return Object.fromEntries(entries) as Record<string, number>;
}
