import { isDeepStrictEqual } from 'node:util';
import { draftOf, type Channel, type LaunchConfig } from '@shipcast/schema';
import { launchDir } from './drafts.ts';
import type { ChannelRow, Launch, StoredDraft, StoredMediaRow, StoredPack } from './repositories/index.ts';

/*
 * How a drafts pull request's files map onto the launch model's rows (docs/launch-store.md): the
 * shadow write of the model's second phase stores them through this mapping, the check compares a
 * pull request with the rows through it, and the import of the existing launches reads them the same way.
 */

/** What one file of a drafts pull request is in the launch model */
export type StoredFile =
  /** A piece's draft, kept whole as a draft version's body: an article with its front matter, a channel's draft file */
  | { kind: 'draft'; channel: string; piece: string }
  /** `pack.json`: a row of `packs` */
  | { kind: 'pack' }
  /** An article's `launch.yml`, the channels chosen in the app: the launch's channel rows */
  | { kind: 'channels' }
  /** A file under `public/`: the media store, and a `media` row with its address on the site */
  | { kind: 'media'; publicPath: string; role: string; shared: boolean }
  /** Site content that is not the launch's (`projects.yml`): left to the pull request */
  | { kind: 'site' };

/** The piece of a channel draft with no part of its own (`bluesky.md`), so every draft has one */
export const MAIN_PIECE = 'post';

/** The channel the release notes are drafted under: they are a draft, not a channel that publishes */
export const RELEASE_NOTES = 'releaseNotes';

const ARTICLE = /^src\/content\/posts\/(en|es)\/[^/]+\.md$/;

/** What a file of the launch's drafts pull request is stored as */
export function storedFile(launch: Pick<Launch, 'repo' | 'ref'>, path: string): StoredFile {
  const dir = launchDir(launch);
  const article = ARTICLE.exec(path);
  if (article) return { kind: 'draft', channel: 'blog', piece: `article:${article[1]}` };
  if (path === `${dir}/pack.json`) return { kind: 'pack' };
  if (path === `${dir}/launch.yml`) return { kind: 'channels' };
  if (path === `${dir}/release-notes.md`) return { kind: 'draft', channel: RELEASE_NOTES, piece: 'notes' };
  if (path.startsWith(`${dir}/`)) {
    const draft = draftOf(path);
    if (draft) return { kind: 'draft', channel: draft.channel, piece: draft.part || MAIN_PIECE };
  }
  if (path.startsWith('public/')) {
    const publicPath = path.slice('public'.length);
    return { kind: 'media', publicPath, role: mediaRole(publicPath), shared: !publicPath.startsWith(`/${dir}/`) };
  }
  // projects.yml and anything else of the site's own
  return { kind: 'site' };
}

/** What a launch's file is for, from its name, as `media.role` records it */
export function mediaRole(publicPath: string): string {
  const name = publicPath.split('/').at(-1) ?? publicPath;
  if (publicPath.startsWith('/covers/')) return 'cover';
  if (publicPath.includes('/screenshots/')) return 'screenshot';
  if (/^og\.(png|jpe?g)$/.test(name)) return 'og';
  if (name === 'instagram-story.jpg') return 'story';
  if (/^instagram-\d+\.(jpe?g|png|mp4)$/.test(name)) return 'carousel';
  if (/^demo\./.test(name)) return 'demo';
  return 'other';
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', webm: 'video/webm' };

/** A file's type from its extension; what the pipeline draws and records is a handful of known ones */
export function mimeOf(path: string): string {
  return MIME[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export function mediaKind(mime: string): string {
  const [type] = mime.split('/');
  return type === 'image' || type === 'video' || type === 'audio' ? type : 'document';
}

/** launch.yml's channels as the launch's rows: each channel's mode, and the options that are a channel's own */
export function channelRows(config: LaunchConfig): ChannelRow[] {
  return (Object.keys(config.publishing) as Channel[]).map((channel) => ({
    channel,
    mode: config.publishing[channel],
    options: channel === 'reddit' ? { subreddits: config.reddit.subreddits } : {},
  }));
}

/** The launch's rows, as the check compares them with its pull request */
export interface StoreCopy {
  pack: StoredPack | undefined;
  channelsSource: string | null;
  drafts: readonly StoredDraft[];
  media: readonly StoredMediaRow[];
}

/** A file of the pull request: a text's content, or null where it was listed without reading it; a file's sha256 when its bytes are at hand */
export interface PullRequestFile {
  path: string;
  content: string | null;
  sha256?: string;
}

/** The path a draft version came from, which `fields.path` keeps */
export const draftPath = (draft: Pick<StoredDraft, 'fields'>): string | undefined => (typeof draft.fields.path === 'string' ? draft.fields.path : undefined);

/**
 * Every way the launch's rows differ from its pull request, one line each, none when they agree: a
 * file the rows lack, a text whose current version is not the file's, a draft no longer in the pull
 * request. `launchYml` is a release's launch.yml (in the project's repo, not the pull request) when it
 * was read. Files listed without their content are checked for presence only.
 */
export function storeDifferences(launch: Pick<Launch, 'repo' | 'ref'>, copy: StoreCopy, files: readonly PullRequestFile[], launchYml?: string | null): string[] {
  const out: string[] = [];
  const draftsByKey = new Map(copy.drafts.map((d) => [`${d.channel}\n${d.piece}`, d]));
  const seen = new Set<string>();
  for (const file of files) {
    const stored = storedFile(launch, file.path);
    if (stored.kind === 'draft') {
      const draft = draftsByKey.get(`${stored.channel}\n${stored.piece}`);
      seen.add(`${stored.channel}\n${stored.piece}`);
      if (!draft) out.push(`${file.path}: no draft in the database`);
      else if (file.content !== null && draft.body !== file.content) out.push(`${file.path}: the database's version ${draft.n} differs from the pull request`);
    } else if (stored.kind === 'pack') {
      if (!copy.pack) out.push(`${file.path}: no pack in the database`);
      else if (file.content !== null && !samePack(copy.pack.pack, file.content)) out.push(`${file.path}: the database's pack ${copy.pack.version} differs from the pull request`);
    } else if (stored.kind === 'channels') {
      if (copy.channelsSource === null) out.push(`${file.path}: no channels in the database`);
      else if (file.content !== null && copy.channelsSource !== file.content) out.push(`${file.path}: the database's channels were read from another launch.yml`);
    } else if (stored.kind === 'media') {
      const row = copy.media.find((m) => m.publicPath === stored.publicPath);
      if (!row) out.push(`${file.path}: no media in the database`);
      else if (file.sha256 !== undefined && row.sha256 !== file.sha256) out.push(`${file.path}: the database's file has other bytes`);
    }
  }
  for (const draft of copy.drafts) {
    if (!seen.has(`${draft.channel}\n${draft.piece}`)) out.push(`${draftPath(draft) ?? `${draft.channel} ${draft.piece}`}: in the database, not in the pull request`);
  }
  if (launchYml !== undefined && launchYml !== null && !launch.ref.startsWith('article:') && copy.channelsSource !== launchYml) {
    out.push(`launch.yml of ${launch.repo}: the database's channels were read from another version`);
  }
  return out;
}

function samePack(stored: Record<string, unknown>, text: string): boolean {
  try {
    // jsonb keeps no key order, so the pack is compared as a value, not as text
    return isDeepStrictEqual(stored, JSON.parse(text));
  } catch {
    return false;
  }
}
