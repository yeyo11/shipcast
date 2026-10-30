import { CAPABILITIES, pullRequestNumber, Refused, type Channel, type DeleteSupport } from '@shipcast/schema';
import { isAppLaunch } from '../app-review.ts';
import { draftsBranch } from '../drafts.ts';
import type { PostOutcome } from '../edit.ts';
import type { GitHubSource, PreviewWriter } from '../github.ts';
import { dedupeKeyOf } from '../launch-import.ts';
import { mediaKey, type MediaStore } from '../media/store.ts';
import type { DeletionMode, Launch, LaunchDeletion, Post, Repositories } from '../repositories/index.ts';
import type { AppReviewService } from './app-review.ts';
import type { PostService } from './posts.ts';

/** Why a launch was not deleted */
export class DeletionRefused extends Refused<'not_found' | 'state' | 'invalid'> {}

/** One channel a published launch still has pieces out on, and what deleting them there does */
export interface DeletionChannel {
  channel: Channel;
  /** Its pieces still out (live or edited) */
  out: number;
  /** `yes`, `unpublish` (dev.to keeps a draft) or `no` (Instagram, the newsletter: they stay whatever is chosen) */
  remove: DeleteSupport;
}

/** What deleting a launch would do, for the owner to choose before anything happens */
export interface DeletionPlan {
  launch: Launch;
  /** `removed`: nothing of it was ever out, so it goes with its rows; `hidden`: it published, so it is soft-deleted */
  mode: DeletionMode;
  /** Why it cannot be deleted now; absent when it can */
  refused?: string;
  /** The channels with pieces out, whose posts are kept unless the owner ticks them; none for a launch never published */
  channels: DeletionChannel[];
  /** Pieces out on other channels than the blog: each links the article, so removing the article breaks that many links */
  articleLinks: number;
}

export interface DeletionResult {
  mode: DeletionMode;
  deletion: LaunchDeletion;
  /** What became of each post the owner chose to delete on its network */
  outcomes: PostOutcome[];
  /** With the article removed while posts still link it: how many, in words */
  warning?: string;
  /** What could not be tidied up after (a pull request left open, media bytes kept): the deletion stands */
  problems: string[];
}

export interface LaunchDeletionDeps {
  registry: Pick<Repositories, 'launches' | 'posts' | 'attempts' | 'launchDeletions' | 'launchStore'>;
  /** Runs `work` in one transaction with every repository over it (`inTransaction`, from the composition root) */
  inTransaction<T>(work: (tx: Repositories) => Promise<T>): Promise<T>;
  /** Deleting a piece on its network: PostService's, the one way a published piece is deleted */
  posts: Pick<PostService, 'deleteMany'>;
  /** Whether a drafts pull request was merged (the article is then on the site), and closing one left open */
  github: Pick<GitHubSource, 'pullRequestState'> & Pick<PreviewWriter, 'closePreview'>;
  /** Read at each call: the launches repo is a setting the owner can change */
  readonly launchesRepo: string;
  /** With `app-review`: a launch Shipcast holds whose article reached the site, and its preview to close */
  appReview?: Pick<AppReviewService, 'published' | 'closePreview'> | undefined;
  /** Where a removed launch's media bytes are, deleted once no launch names them */
  media?: Pick<MediaStore, 'delete'> | undefined;
}

const isOut = (post: Post) => post.status === 'live' || post.status === 'edited';

/** "1 post", "3 posts" */
const postCount = (n: number) => `${n} ${n === 1 ? 'post' : 'posts'}`;

/**
 * Deleting a launch (docs/launch-delete.md), with the `launch-delete` flag: one never published is
 * removed with every row that hangs on it; a published one is soft-deleted, hidden from the lists,
 * the rounds and the metrics, its posts kept on the networks unless the owner chooses, channel by
 * channel, to delete them there too (through PostService). Either way the deletion is recorded, and a
 * removed launch's key keeps a trigger from launching the same release again.
 */
export class LaunchDeletionService {
  readonly #deps: LaunchDeletionDeps;

  constructor(deps: LaunchDeletionDeps) {
    this.#deps = deps;
  }

  /** What deleting the launch would do; nothing is changed */
  async plan(launchId: number): Promise<DeletionPlan> {
    const launch = await this.#deps.registry.launches.get(launchId);
    if (!launch) throw new DeletionRefused('not_found', 'no such launch');
    const pieces = await this.#deps.registry.posts.posts(launchId);
    const out = pieces.filter(isOut);
    const published = await this.#published(launch, pieces);
    const channels = [...new Set(out.map((p) => p.channel))].map((channel) => ({ channel, out: out.filter((p) => p.channel === channel).length, remove: CAPABILITIES[channel].delete }));
    const refused = launch.deletedAt
      ? `it was deleted already, on ${launch.deletedAt.slice(0, 10)}`
      : launch.status === 'generating' || launch.status === 'detected'
        ? 'its drafts are being written: delete it once they are'
        : undefined;
    return { launch, mode: published ? 'hidden' : 'removed', ...(refused && { refused }), channels, articleLinks: out.filter((p) => p.channel !== 'blog').length };
  }

  /**
   * Deletes the launch. `channels` are those whose posts go from the networks too (a published launch
   * only; none by default). Removing the article (`blog`) is allowed while other posts link it: the
   * answer's warning says how many are left pointing to a broken link.
   */
  async delete(launchId: number, options: { channels?: readonly Channel[]; by?: string } = {}): Promise<DeletionResult> {
    const plan = await this.plan(launchId);
    if (plan.refused) throw new DeletionRefused('state', `This launch cannot be deleted: ${plan.refused}.`);
    const channels = [...new Set(options.channels ?? [])];
    const by = options.by ?? 'owner';
    const { launch } = plan;
    const dedupeKey = (await this.#deps.registry.launches.dedupeKey(launch.id)) ?? dedupeKeyOf(launch);
    const base = { launchId: launch.id, dedupeKey, repo: launch.repo, ref: launch.ref, by };

    if (plan.mode === 'removed') {
      if (channels.length > 0) throw new DeletionRefused('invalid', 'nothing of this launch was published: there is nothing to delete on the networks');
      const problems = await this.#closeOpenDrafts(launch);
      const files = (await this.#deps.registry.launchStore.media(launch.id)).map((m) => m.sha256);
      const deletion = await this.#deps.inTransaction(async (tx) => {
        // Its scheduled pieces, attempts and snapshot go with it; jobs and assistant sessions stay, unlinked
        await tx.launchImports.removeLaunch(launch.id);
        return tx.launchDeletions.record({ ...base, mode: 'removed', channels: [], articleLinks: null });
      });
      problems.push(...(await this.#dropUnusedMedia(files)));
      return { mode: 'removed', deletion, outcomes: [], problems };
    }

    const unknown = channels.filter((c) => !plan.channels.some((p) => p.channel === c));
    if (unknown.length > 0) throw new DeletionRefused('invalid', `nothing of this launch is out on ${unknown.join(', ')}`);
    const outcomes = channels.length > 0 ? await this.#deps.posts.deleteMany(launch.id, channels) : [];
    // Nothing more goes out: what waited for its time is dropped with the launch
    const pieces = await this.#deps.registry.posts.posts(launch.id);
    for (const p of pieces.filter((x) => x.status === 'scheduled')) await this.#deps.registry.posts.unschedulePost(p.id);
    const articleGone = channels.includes('blog');
    const linking = pieces.filter((p) => isOut(p) && p.channel !== 'blog').length;
    await this.#deps.registry.launches.hide(launch.id);
    const deletion = await this.#deps.registry.launchDeletions.record({ ...base, mode: 'hidden', channels, articleLinks: articleGone ? linking : null });
    const warning =
      articleGone && linking > 0 ? `${postCount(linking)} still ${linking === 1 ? 'links' : 'link'} to the article, which is gone: ${linking === 1 ? 'its link is' : 'their links are'} broken now.` : undefined;
    return { mode: 'hidden', deletion, outcomes, ...(warning && { warning }), problems: [] };
  }

  /**
   * Whether anything of the launch reached an audience: a piece out (or deleted since), a piece whose
   * attempt may have gone out, or its article on the site (a merged pull request, a direct commit, or
   * the commit of a launch Shipcast holds)
   */
  async #published(launch: Launch, pieces: readonly Post[]): Promise<boolean> {
    if (launch.status === 'published') return true;
    if (pieces.some((p) => p.status !== 'scheduled' && p.status !== 'failed')) return true;
    const attempts = await this.#deps.registry.attempts.ofLaunch(launch.id);
    if (attempts.some((a) => a.state === 'live' || a.state === 'unknown' || a.state === 'attempting')) return true;
    if (isAppLaunch(launch)) return (await this.#deps.appReview?.published(launch.id)) !== undefined;
    if (launch.detail?.startsWith('direct:')) return true;
    const number = launch.status === 'drafted' ? pullRequestNumber(launch) : undefined;
    return number !== undefined && (await this.#deps.github.pullRequestState(this.#deps.launchesRepo, number)) === 'merged';
  }

  /** A removed launch leaves nothing open that could still publish it: its drafts pull request, its preview on the site */
  async #closeOpenDrafts(launch: Launch): Promise<string[]> {
    const problems: string[] = [];
    const say = (what: string) => (error: unknown) => problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    if (isAppLaunch(launch)) {
      await this.#deps.appReview?.closePreview(launch).catch(say('its preview on the site was left open'));
      return problems;
    }
    const number = launch.status === 'drafted' ? pullRequestNumber(launch) : undefined;
    if (number !== undefined) await this.#deps.github.closePreview(this.#deps.launchesRepo, number, draftsBranch(launch)).catch(say(`its drafts pull request #${number} was left open`));
    return problems;
  }

  /** The bytes no launch names any more, deleted from the media store; any it refuses are only reported */
  async #dropUnusedMedia(files: readonly string[]): Promise<string[]> {
    const problems: string[] = [];
    for (const sha256 of new Set(files)) {
      if (!this.#deps.media || (await this.#deps.registry.launchStore.mediaInUse(sha256))) continue;
      await this.#deps.media.delete(mediaKey(sha256)).catch((error: unknown) => problems.push(`a media file (${sha256.slice(0, 12)}) was kept in the store: ${error instanceof Error ? error.message : String(error)}`));
    }
    return problems;
  }
}
