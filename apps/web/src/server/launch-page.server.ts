import { launchConfigFrom, type DraftSnapshot, type Launch, type Repositories, type ReviewGitHub } from '@shipcast/engine';
import { jobsView } from './jobs.server.ts';
import { launchNumbers, waitingComments } from './launch-summary.server.ts';
import { launchDetail } from './launches.server.ts';
import { launchPieces } from './pieces.server.ts';

export interface LaunchPageDeps {
  registry: Repositories;
  github: ReviewGitHub;
  launchesRepo: string;
  /**
   * With `github-events`: the drafts snapshot is the page's only view of the pull request and its
   * launch.yml, so a view of the page never reaches GitHub; without it both are read from GitHub
   */
  drafts?: { get(launchId: number): Promise<DraftSnapshot | undefined> };
}

/** Everything a launch's page shows, read at once */
export async function launchPage(deps: LaunchPageDeps, launch: Launch) {
  const { registry, github, launchesRepo } = deps;
  const snapshot = deps.drafts?.get(launch.id);
  // Everything at once: the page waited for each read in turn, the slowest (GitHub's) first
  const detailing = launchDetail(registry, launch, { github, launchesRepo, ...(snapshot && { snapshot }) });
  // Caught here as well: launchPieces may never wait for it, and a rejection nobody awaits would end the process
  const draftPaths = detailing.then((d) => (d.review && !('error' in d.review) ? d.review.drafts.map((x) => x.path) : [])).catch(() => []);
  const launchConfig = snapshot?.then((s) => launchConfigFrom(s?.launchYml));
  const [detail, pieces, jobs, numbers, waiting] = await Promise.all([
    detailing,
    launchPieces(registry, launch, { github, launchesRepo, draftPaths, ...(launchConfig && { launchConfig }) }),
    jobsView(registry, { launchId: launch.id }),
    launchNumbers(registry, [launch]),
    waitingComments(registry, launch.id),
  ]);
  return { ...detail, pieces, jobs, numbers: numbers.get(launch.id)!, waitingComments: waiting };
}
