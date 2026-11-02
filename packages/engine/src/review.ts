import { draftFile, draftOf, pullRequestNumber } from '@shipcast/schema';
import { currentVersions, type ArticlePreview, type BlogCommit, type SitePreview } from './app-review.ts';
import { draftsBranch, isArticle, launchDir } from './drafts.ts';
import { draftPath } from './launch-store.ts';
import type { Launch, StoredDraft, StoredMediaRow } from './repositories/index.ts';

/** The GitHub calls reviewing a launch's drafts makes; `GitHubRest` has them all */
export interface ReviewGitHub {
  /** `mergedBy` and `mergedAt` once merged: who approved the drafts, and when */
  pullRequest(
    repo: string,
    number: number,
  ): Promise<{ number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string; title: string; headSha?: string; mergedBy?: string | null; mergedAt?: string | null }>;
  pullRequestFiles(repo: string, number: number): Promise<string[]>;
  /** The files with their blob shas, for the snapshot; the paths alone when a client lacks it */
  pullRequestFileEntries?(repo: string, number: number): Promise<Array<{ path: string; sha: string | null }>>;
  fileAt(repo: string, path: string, ref: string): Promise<string | undefined>;
  updateFile(repo: string, branch: string, path: string, content: string, message: string): Promise<void>;
  mergePullRequest(repo: string, number: number, title: string): Promise<{ sha: string }>;
}

export interface Draft {
  path: string;
  /** What it is, in words: "Article (en)", "Bluesky", "Instagram slide 3" */
  label: string;
  kind: 'article' | 'channel' | 'image' | 'video' | 'data';
  /** Text files only: what is in the pull request now */
  content?: string;
  /** Media only: where its bytes can be seen on the pull request's branch */
  url?: string;
  /** A launch Shipcast holds: whether this version is the one approved */
  approved?: boolean;
  /** A launch Shipcast holds, an article: as the blog would show it */
  preview?: ArticlePreview;
}

/** A launch Shipcast holds (docs/app-review.md): where its review stands, in place of a pull request */
export interface AppReview {
  /** Its drafts can be edited and approved: drafted and not out */
  open: boolean;
  /** The approval in force */
  approval: { by: string; at: string } | null;
  /** Why each channel may not go out yet, by channel */
  waiting: Record<string, string>;
  /** Its preview on the real site, as last asked for */
  preview: SitePreview | null;
  /** The commit that put its article and media on the site */
  published: BlogCommit | null;
  /** Each draft's current version by draft id: what the page sends back with its approval */
  versions: Record<string, number>;
}

export interface Review {
  /** The drafts pull request; none for a launch Shipcast holds, which has `app` */
  pullRequest?: { number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string };
  app?: AppReview;
  drafts: Draft[];
}

function describe(path: string, dir: string): Omit<Draft, 'content' | 'url'> {
  const article = /^src\/content\/posts\/([a-z]{2})\//.exec(path);
  if (article) return { path, label: `Article (${article[1]})`, kind: 'article' };
  const name = path.split('/').at(-1) ?? path;
  // A channel's draft is named as its definition says, and labelled with the heading it is written with
  const channel = path.startsWith(`${dir}/`) ? draftOf(name) : undefined;
  if (channel) return { path, label: draftFile(channel.channel, channel.part).title, kind: 'channel' };
  if (path === `${dir}/release-notes.md`) return { path, label: 'Release notes', kind: 'channel' };
  if (/\.(jpe?g|png)$/.test(name)) return { path, label: name.replace(/\.(jpe?g|png)$/, '').replace(/-/g, ' '), kind: 'image' };
  if (/\.mp4$/.test(name)) return { path, label: name.replace(/\.mp4$/, '').replace(/-/g, ' '), kind: 'video' };
  return { path, label: name, kind: 'data' };
}

const ORDER: Record<Draft['kind'], number> = { article: 0, channel: 1, image: 2, video: 3, data: 4 };

const sorted = (drafts: Draft[]) => drafts.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path, 'en', { numeric: true }));

/** A launch as the launch model's rows hold it, for the review the page shows */
export interface StoredReviewInput {
  drafts: readonly StoredDraft[];
  /** The launch's own files; a project's cover is the site's, not the launch's */
  media: readonly StoredMediaRow[];
  hasPack: boolean;
  channelsSource: string | null;
  /** An approval is in force: the drafts were decided (the merge, or a commit straight onto main) */
  approved: boolean;
}

/**
 * The review of a launch drafted to a pull request (before the launch model, imported), from the
 * launch model's rows: each text's current version and the media served by the app (`mediaUrl`).
 * Undefined for a launch without a pull request. The pull request's state is what
 * Shipcast knows of it: merged once an approval is recorded or the launch is out, closed once
 * publishing found it closed, open otherwise.
 */
export function reviewFromStore(launch: Launch, stored: StoredReviewInput, mediaUrl: (row: StoredMediaRow) => string): Review | undefined {
  const number = pullRequestNumber(launch);
  if (!number) return undefined;
  const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(launch.detail ?? '')?.[0] ?? '';
  const state = stored.approved || launch.status === 'published' ? 'merged' : launch.status === 'skipped' && (launch.detail ?? '').includes('closed without merging') ? 'closed' : 'open';
  const dir = launchDir(launch);
  const data = [...(stored.hasPack ? [`${dir}/pack.json`] : []), ...(isArticle(launch) && stored.channelsSource !== null ? [`${dir}/launch.yml`] : [])].map((path) => describe(path, dir));
  return { pullRequest: { number, url, state, branch: draftsBranch(launch) }, drafts: sorted([...storedDrafts(launch, stored, mediaUrl), ...data]) };
}

/** Each stored text at its current version under the path it came from, and the launch's files served by the app */
function storedDrafts(launch: Launch, stored: Pick<StoredReviewInput, 'drafts' | 'media'>, mediaUrl: (row: StoredMediaRow) => string): Draft[] {
  const dir = launchDir(launch);
  const texts = stored.drafts.map((d) => {
    const draft: Draft = describe(draftPath(d) ?? `${dir}/${d.channel}-${d.piece}.md`, dir);
    draft.content = d.body;
    return draft;
  });
  const files = stored.media.flatMap((row) => {
    if (row.publicPath === null) return [];
    const draft: Draft = describe(`public${row.publicPath}`, dir);
    if (draft.kind === 'image' || draft.kind === 'video') draft.url = mediaUrl(row);
    return [draft];
  });
  return [...texts, ...files];
}

/**
 * The review of a launch Shipcast holds (docs/app-review.md), from its rows alone: each draft's
 * current version, whether it is the approved one, and each article as the blog would show it.
 */
export function reviewForApp(
  launch: Launch,
  stored: Pick<StoredReviewInput, 'drafts' | 'media'> & { app: Omit<AppReview, 'versions'>; approvedPaths: ReadonlyMap<string, boolean>; previews: ReadonlyMap<string, ArticlePreview> },
  mediaUrl: (row: StoredMediaRow) => string,
): Review {
  const drafts = storedDrafts(launch, stored, mediaUrl).map((d) => {
    const approved = stored.approvedPaths.get(d.path);
    const preview = stored.previews.get(d.path);
    return { ...d, ...(approved !== undefined && { approved }), ...(preview && { preview }) };
  });
  return { app: { ...stored.app, versions: currentVersions(stored.drafts) }, drafts: sorted(drafts) };
}

/** A refused edit of a draft: not a draft of the launch, or too long for its network */
export class ReviewError extends Error {}
