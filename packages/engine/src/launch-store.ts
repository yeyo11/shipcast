import { parseDocument } from 'yaml';
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

/**
 * The launch.yml the launch's channel rows say: the one they were copied from, each channel's mode
 * set from its row. What a reader of today's files (publishing, the schedule) is handed for a launch
 * whose channels Shipcast changed, such as the import's channels turned off.
 */
export function channelsAsLaunchYml(source: string, rows: readonly ChannelRow[]): string {
  const doc = parseDocument(source);
  // The rows are every channel there is: one the file names and the rows do not (a channel retired since) goes
  doc.setIn(['publishing'], doc.createNode(Object.fromEntries(rows.map((row) => [row.channel, row.mode]))));
  return String(doc);
}

/** A file of the pull request: a text's content, or null where it was listed without reading it; a file's sha256 when its bytes are at hand */
export interface PullRequestFile {
  path: string;
  content: string | null;
  sha256?: string;
}

/** The path a draft version came from, which `fields.path` keeps */
export const draftPath = (draft: Pick<StoredDraft, 'fields'>): string | undefined => (typeof draft.fields.path === 'string' ? draft.fields.path : undefined);
