import { pullRequestNumber } from '@shipcast/schema';
import type { DraftFile } from '../drafts.ts';
import { launchConfigText } from '../publish.ts';
import type { DraftSnapshot, Launch, Repositories } from '../repositories/index.ts';
import { openedSnapshot, readDraftSnapshot, type ReviewGitHub } from '../review.ts';
import type { LaunchStoreService } from './launch-store.ts';

export interface DraftSnapshotDeps {
  github: ReviewGitHub;
  registry: Pick<Repositories, 'drafts' | 'launches'>;
  /** Read at each call: the launches repo is a setting the owner can change */
  readonly launchesRepo: string;
  /** With `launch-store`: each reading of a pull request also checks the launch model's copy of it */
  launchStore?: Pick<LaunchStoreService, 'pullRequestRead'>;
}

/** How many recent launches the poll and the deliveries look through for a pull request's launch */
const RECENT = 500;

/**
 * The drafts snapshot's use cases (docs/plans/performance-refactor.md, phase 7): what writes the row
 * the launch page reads instead of GitHub. Built only with the `github-events` flag on; without it
 * nothing calls this and the page reads GitHub as before.
 */
export class DraftSnapshotService {
  readonly #deps: DraftSnapshotDeps;

  constructor(deps: DraftSnapshotDeps) {
    this.#deps = deps;
  }

  get(launchId: number): Promise<DraftSnapshot | undefined> {
    return this.#deps.registry.drafts.snapshot(launchId);
  }

  /** Reads the pull request from GitHub and rewrites the snapshot; undefined for a launch without one */
  async refresh(launch: Launch): Promise<DraftSnapshot | undefined> {
    const read = await readDraftSnapshot(launch, { github: this.#deps.github, launchesRepo: this.#deps.launchesRepo });
    if (!read) return undefined;
    const saved = await this.#deps.registry.drafts.saveSnapshot(read);
    // It reports what differs on its own and never throws
    await this.#deps.launchStore?.pullRequestRead(launch, read).catch(() => undefined);
    return saved;
  }

  /**
   * After the pipeline opened the pull request: the snapshot is the files it pushed. A pull request
   * that was open already (a re-run) carries what was pushed before, so it is read instead.
   */
  async opened(launch: Launch, pr: { number: number; url: string; created: boolean }, branch: string, files: readonly DraftFile[]): Promise<void> {
    if (!pr.created) {
      await this.refresh(launch);
      return;
    }
    const launchYml = await launchConfigText(this.#deps.github, this.#deps.launchesRepo, launch).catch(() => undefined);
    await this.#deps.registry.drafts.saveSnapshot(openedSnapshot(launch, pr, branch, files, launchYml));
  }

  /** After Shipcast committed an edit to one draft */
  async edited(launch: Launch, path: string, content: string): Promise<void> {
    await this.#deps.registry.drafts.patchSnapshotFile(launch.id, path, content);
  }

  /** The launch whose drafts are in this pull request of the launches repo, whatever its status now */
  async launchOf(number: number): Promise<Launch | undefined> {
    const repo = `/${this.#deps.launchesRepo.toLowerCase()}/pull/`;
    return (await this.#deps.registry.launches.recent(RECENT)).find((l) => pullRequestNumber(l) === number && (l.detail?.toLowerCase().includes(repo) ?? false));
  }

  /**
   * The poll's safety net for missed deliveries: every launch whose pull request was open when last
   * read, or was never read, is read again. Conditional reads make an unchanged one cost 304s.
   */
  async refreshOpen(): Promise<{ refreshed: number; problems: string[] }> {
    const candidates = (await this.#deps.registry.launches.recent(RECENT)).filter((l) => pullRequestNumber(l) !== undefined && l.status === 'drafted');
    const known = new Map((await this.#deps.registry.drafts.snapshots(candidates.map((l) => l.id))).map((s) => [s.launchId, s]));
    const problems: string[] = [];
    let refreshed = 0;
    for (const launch of candidates) {
      const state = known.get(launch.id)?.pullRequest.state;
      if (state !== undefined && state !== 'open') continue;
      try {
        if (await this.refresh(launch)) refreshed++;
      } catch (error) {
        problems.push(`${launch.repo} ${launch.ref}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { refreshed, problems };
  }
}
