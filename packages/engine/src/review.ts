import { draftBody, pieceLimitProblem, pullRequestNumber } from '@shipcast/schema';
import { launchDir } from './drafts.ts';
import type { Launch } from './registry.ts';

/** The GitHub calls reviewing a launch's drafts makes; `GitHubRest` has them all */
export interface ReviewGitHub {
  pullRequest(repo: string, number: number): Promise<{ number: number; url: string; state: 'open' | 'merged' | 'closed'; branch: string; title: string }>;
  pullRequestFiles(repo: string, number: number): Promise<string[]>;
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

const CHANNEL_FILES: Record<string, string> = {
  'devto.md': 'dev.to',
  'hashnode.md': 'Hashnode',
  'bluesky.md': 'Bluesky',
  'mastodon.md': 'Mastodon',
  'instagram.md': 'Instagram',
  'telegram.md': 'Telegram',
  'discord.md': 'Discord',
  'github-discussion.md': 'GitHub Discussions',
  'threads.md': 'Threads',
  'linkedin.md': 'LinkedIn',
  'newsletter-en.md': 'Newsletter (en)',
  'newsletter-es.md': 'Newsletter (es)',
  'release-notes.md': 'Release notes',
};

function describe(path: string, dir: string): Omit<Draft, 'content' | 'url'> {
  const article = /^src\/content\/posts\/(en|es)\//.exec(path);
  if (article) return { path, label: `Article (${article[1]})`, kind: 'article' };
  const name = path.split('/').at(-1) ?? path;
  if (path.startsWith(`${dir}/`) && CHANNEL_FILES[name]) return { path, label: CHANNEL_FILES[name], kind: 'channel' };
  if (/^reddit-.+\.md$/.test(name)) return { path, label: `Reddit, ${name.slice(7, -3)}`, kind: 'channel' };
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
      // Raw URLs take the branch with its slashes as they are; an encoded one is a 404
      if (draft.kind === 'image' || draft.kind === 'video') {
        draft.url = `https://raw.githubusercontent.com/${deps.launchesRepo}/${(ref === 'HEAD' ? 'main' : ref).split('/').map(encodeURIComponent).join('/')}/${path}`;
      }
      return draft;
    }),
  );
  drafts.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path, 'en', { numeric: true }));
  return { pullRequest: { number: pr.number, url: pr.url, state: pr.state, branch: pr.branch }, drafts };
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
  const channel = /([a-z]+)\.md$/.exec(path)?.[1];
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
