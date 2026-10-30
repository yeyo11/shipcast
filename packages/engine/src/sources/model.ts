import type { Channel, Language } from '@shipcast/schema';
import type { LaunchSource } from '../repositories/index.ts';

/*
 * A launch made from sources (launch-sources, docs/sources.md): what the owner gives, checked the
 * same way whichever way it comes in (the app, the REST API), and what a launch with no repo
 * publishes by.
 */

/** One source as the owner gives it */
export type SourceInput =
  /** The owner's own words: notes, a draft, an opinion */
  | { kind: 'text'; text: string; title?: string }
  /** A page Shipcast fetches once, when the launch is created */
  | { kind: 'url'; url: string }
  /** A repo; the primary one (the first, unless another is marked) at a release, the others at `ref` or their default branch */
  | { kind: 'repo'; repo: string; ref?: string; primary?: boolean }
  /** A file uploaded before (POST /media), named by its sha256 */
  | { kind: 'media'; sha256: string; name?: string; alt?: string };

export interface SourcesLaunchInput {
  /** What the launch is called; a launch with no repo takes its blog slug from it */
  title: string;
  /** The language the owner wrote the title and the text in */
  lang: Language;
  /** The channels besides the blog, for a launch with no repo; a repo's launch.yml decides for one with a primary repo */
  channels: Channel[];
  sources: SourceInput[];
}

/** What one launch may be made of, so a request can never make an analysis read without bound */
export const SOURCE_LIMITS = {
  sources: 12,
  repos: 5,
  urls: 8,
  media: 10,
  /** Characters of one text source */
  textChars: 100_000,
  titleChars: 200,
  /** Characters of a file's name or alt text */
  labelChars: 500,
} as const;

/** A request that cannot make a launch, said for the owner */
export class InvalidSources extends Error {}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Checks a request's sources and says the first thing wrong, the way the app and the API both refuse it */
export function checkSources(input: SourcesLaunchInput): void {
  const { sources } = input;
  if (!input.title.trim()) throw new InvalidSources('a launch needs a title');
  if (input.title.length > SOURCE_LIMITS.titleChars) throw new InvalidSources(`a title has at most ${SOURCE_LIMITS.titleChars} characters`);
  if (sources.length === 0) throw new InvalidSources('a launch needs at least one source');
  if (sources.length > SOURCE_LIMITS.sources) throw new InvalidSources(`a launch has at most ${SOURCE_LIMITS.sources} sources`);
  const count = (kind: SourceInput['kind']) => sources.filter((s) => s.kind === kind).length;
  if (count('repo') > SOURCE_LIMITS.repos) throw new InvalidSources(`a launch has at most ${SOURCE_LIMITS.repos} repos`);
  if (count('url') > SOURCE_LIMITS.urls) throw new InvalidSources(`a launch has at most ${SOURCE_LIMITS.urls} pages`);
  if (count('media') > SOURCE_LIMITS.media) throw new InvalidSources(`a launch has at most ${SOURCE_LIMITS.media} files`);
  const repos = sources.filter((s) => s.kind === 'repo');
  if (repos.filter((r) => r.primary).length > 1) throw new InvalidSources('only one repo can be the primary one');
  if (new Set(repos.map((r) => r.repo.toLowerCase())).size !== repos.length) throw new InvalidSources('a repo is given twice');
  for (const s of sources) {
    if (s.kind === 'text') {
      if (!s.text.trim()) throw new InvalidSources('a text source is empty');
      if (s.text.length > SOURCE_LIMITS.textChars) throw new InvalidSources(`a text source has at most ${SOURCE_LIMITS.textChars} characters`);
    } else if (s.kind === 'url') {
      let url: URL;
      try {
        url = new URL(s.url);
      } catch {
        throw new InvalidSources(`${s.url.slice(0, 80)} is not a URL`);
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new InvalidSources('a page is an http or https URL');
    } else if (s.kind === 'repo') {
      if (!REPO.test(s.repo)) throw new InvalidSources('a repo is owner/name');
    } else if (!SHA256.test(s.sha256)) {
      throw new InvalidSources('a file is named by the sha256 its upload answered');
    } else if ((s.name?.length ?? 0) > SOURCE_LIMITS.labelChars || (s.alt?.length ?? 0) > SOURCE_LIMITS.labelChars) {
      throw new InvalidSources(`a file's name and alt text have at most ${SOURCE_LIMITS.labelChars} characters`);
    }
  }
}

/** The repo source whose release is the launch: the one marked primary, or the first */
export function primaryRepoOf(sources: readonly SourceInput[]): Extract<SourceInput, { kind: 'repo' }> | undefined {
  const repos = sources.filter((s): s is Extract<SourceInput, { kind: 'repo' }> => s.kind === 'repo');
  return repos.find((r) => r.primary) ?? repos[0];
}

/** A source's id in the analysis' index and claims: `S1`, `S2`… by position */
export const sourceId = (source: Pick<LaunchSource, 'position'>) => `S${source.position}`;

/** The repos of a launch's sources, the primary one first: whose stars and numbers are the launch's */
export function sourceRepos(sources: readonly LaunchSource[]): string[] {
  const repos = sources.filter((s) => s.repo !== null && (s.kind === 'repo_release' || s.kind === 'repo_ref' || s.kind === 'repo'));
  return [...repos.filter((s) => s.role === 'primary'), ...repos.filter((s) => s.role !== 'primary')].map((s) => s.repo!);
}
