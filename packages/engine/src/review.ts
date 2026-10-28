import { draftBody, draftFile, draftOf, pieceLimitProblem, pullRequestNumber } from '@shipcast/schema';
import { launchDir, type DraftFile } from './drafts.ts';
import { launchConfigText } from './publish.ts';
import type { DraftSnapshot, DraftSnapshotInput, Launch } from './repositories/index.ts';

/** The GitHub calls reviewing a launch's drafts makes; `GitHubRest` has them all */
export interface ReviewGitHub {
  pullRequest(repo: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string; title: string; headSha?: string }>;
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
}

export interface Review {
  pullRequest: { number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string };
  drafts: Draft[];
}

function describe(path: string, dir: string): Omit<Draft, 'content' | 'url'> {
  const article = /^src\/content\/posts\/(en|es)\//.exec(path);
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

/**
 * A launch's drafts as they are in its pull request now, with the owner's edits: the articles and
 * every channel's text to read and edit, the media to look at. Media and data are listed, not read.
 */
export async function readReview(launch: Launch, deps: { github: ReviewGitHub; launchesRepo: string }): Promise<Review | undefined> {
  const number = pullRequestNumber(launch);
  if (!number) return undefined;
  const pr = await deps.github.pullRequest(deps.launchesRepo, number);
  const ref = pr.state === 'merged' ? 'HEAD' : pr.branch;
  const dir = launchDir(launch);
  // Every text is read at once: one after the other, a launch's dozen drafts took seconds on each load of its page
  const drafts: Draft[] = await Promise.all(
    (await deps.github.pullRequestFiles(deps.launchesRepo, number)).map(async (path) => {
      const draft: Draft = describe(path, dir);
      if (draft.kind === 'article' || draft.kind === 'channel') draft.content = (await deps.github.fileAt(deps.launchesRepo, path, ref)) ?? '';
      return withMediaUrl(draft, deps.launchesRepo, ref);
    }),
  );
  return { pullRequest: { number: pr.number, url: pr.url, state: pr.state, branch: pr.branch }, drafts: sorted(drafts) };
}

const isText = (draft: Pick<Draft, 'kind'>) => draft.kind === 'article' || draft.kind === 'channel';

/** Raw URLs take the branch with its slashes as they are; an encoded one is a 404 */
function withMediaUrl(draft: Draft, launchesRepo: string, ref: string): Draft {
  if (draft.kind === 'image' || draft.kind === 'video') {
    draft.url = `https://raw.githubusercontent.com/${launchesRepo}/${(ref === 'HEAD' ? 'main' : ref).split('/').map(encodeURIComponent).join('/')}/${draft.path}`;
  }
  return draft;
}

const sorted = (drafts: Draft[]) => drafts.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path, 'en', { numeric: true }));

/** The review the page shows, from the snapshot alone: the same shape readReview answers from GitHub */
export function reviewFromSnapshot(launch: Launch, snapshot: DraftSnapshot, launchesRepo: string): Review {
  const { pullRequest } = snapshot;
  const ref = pullRequest.state === 'merged' ? 'HEAD' : pullRequest.branch;
  const dir = launchDir(launch);
  const drafts = snapshot.files.map((file) => {
    const draft: Draft = describe(file.path, dir);
    if (isText(draft)) draft.content = file.content ?? '';
    return withMediaUrl(draft, launchesRepo, ref);
  });
  return { pullRequest: { ...pullRequest }, drafts: sorted(drafts) };
}

/**
 * The drafts pull request read from GitHub into a snapshot: its state and head, each file with its
 * sha and the text of every article and channel draft, and the launch.yml the launch publishes by.
 * Every read is conditional through the client's ETag cache, so a poll of an unchanged pull request
 * costs 304s. Undefined for a launch without a pull request.
 */
export async function readDraftSnapshot(launch: Launch, deps: { github: ReviewGitHub; launchesRepo: string }): Promise<DraftSnapshotInput | undefined> {
  const number = pullRequestNumber(launch);
  if (!number) return undefined;
  const { github, launchesRepo } = deps;
  const [pr, entries, launchYml] = await Promise.all([
    github.pullRequest(launchesRepo, number),
    github.pullRequestFileEntries ? github.pullRequestFileEntries(launchesRepo, number) : github.pullRequestFiles(launchesRepo, number).then((paths) => paths.map((path) => ({ path, sha: null }))),
    // Unreadable is what the page already copes with: it falls back on the drafts' own channels
    launchConfigText(github, launchesRepo, launch).catch(() => undefined),
  ]);
  const ref = pr.state === 'merged' ? 'HEAD' : pr.branch;
  const dir = launchDir(launch);
  const files = await Promise.all(
    entries.map(async ({ path, sha }) => ({ path, sha, content: isText(describe(path, dir)) ? ((await github.fileAt(launchesRepo, path, ref)) ?? '') : null })),
  );
  return {
    launchId: launch.id,
    pullRequest: { number: pr.number, url: pr.url, state: pr.state, branch: pr.branch },
    headSha: pr.headSha ?? null,
    launchYml: launchYml ?? null,
    files,
  };
}

/**
 * The snapshot of a pull request Shipcast just opened, from the files it pushed: no read back from
 * GitHub. The head and the shas come with the `opened` delivery or the next poll.
 */
export function openedSnapshot(launch: Launch, pr: { number: number; url: string }, branch: string, files: readonly DraftFile[], launchYml: string | undefined): DraftSnapshotInput {
  const dir = launchDir(launch);
  return {
    launchId: launch.id,
    pullRequest: { number: pr.number, url: pr.url, state: 'open', branch },
    headSha: null,
    launchYml: launchYml ?? null,
    files: files.map((f) => ({ path: f.path, sha: null, content: isText(describe(f.path, dir)) && 'content' in f ? f.content : null })),
  };
}

export class ReviewError extends Error {}

/** Saves an edit to one draft as a commit on the pull request's branch: what is merged is what goes out */
export async function editDraft(launch: Launch, path: string, content: string, deps: { github: ReviewGitHub; launchesRepo: string }): Promise<void> {
  const review = await readReview(launch, deps);
  if (!review) throw new ReviewError('this launch has no drafts pull request');
  if (review.pullRequest.state !== 'open') throw new ReviewError('the pull request is no longer open: its drafts were already decided');
  const draft = review.drafts.find((d) => d.path === path);
  if (!draft || (draft.kind !== 'article' && draft.kind !== 'channel')) throw new ReviewError(`${path} is not a draft of this launch`);
  // The network would refuse it at publishing time, after the merge: refused here, while it can still be fixed
  const channel = draftOf(path)?.channel;
  const tooLong = draft.kind === 'channel' && channel ? pieceLimitProblem(channel, draftBody(content)) : undefined;
  if (tooLong) throw new ReviewError(`${draft.label}: ${tooLong}`);
  await deps.github.updateFile(deps.launchesRepo, review.pullRequest.branch, path, content.endsWith('\n') ? content : `${content}\n`, `Edit ${draft.label} in Shipcast`);
}

/** Approves a launch: its pull request is merged, which publishes the blog; the engine publishes the rest */
export async function approveLaunch(launch: Launch, deps: { github: ReviewGitHub; launchesRepo: string }): Promise<{ sha: string }> {
  const number = pullRequestNumber(launch);
  if (!number) throw new ReviewError('this launch has no drafts pull request');
  const pr = await deps.github.pullRequest(deps.launchesRepo, number);
  if (pr.state !== 'open') throw new ReviewError(`the pull request is ${pr.state}`);
  return deps.github.mergePullRequest(deps.launchesRepo, number, `${pr.title} (#${number})`);
}
