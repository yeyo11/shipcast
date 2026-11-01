import type { Launch, LaunchReadService, Repositories, ReviewGitHub } from '@shipcast/engine';
import { jobsView } from './jobs.server.ts';
import { launchNumbers, waitingComments } from './launch-summary.server.ts';
import { launchDetail } from './launches.server.ts';
import { launchPieces } from './pieces.server.ts';

export interface LaunchPageDeps {
  registry: Repositories;
  github: ReviewGitHub;
  launchesRepo: string;
  /** The drafts and the channels from the launch model's tables: a view of the page never reaches GitHub */
  stored: Pick<LaunchReadService, 'review' | 'channelConfig'>;
}

/** Everything a launch's page shows, read at once */
export async function launchPage(deps: LaunchPageDeps, launch: Launch) {
  const { registry, github, launchesRepo } = deps;
  // Everything at once: the page waited for each read in turn
  const detailing = launchDetail(registry, launch, { stored: deps.stored });
  // Caught here as well: launchPieces may never wait for it, and a rejection nobody awaits would end the process
  const draftPaths = detailing.then((d) => (d.review && !('error' in d.review) ? d.review.drafts.map((x) => x.path) : [])).catch(() => []);
  const launchConfig = () => deps.stored.channelConfig(launch);
  const [detail, pieces, jobs, numbers, waiting] = await Promise.all([
    detailing,
    launchPieces(registry, launch, { draftPaths, launchConfig }),
    jobsView(registry, { launchId: launch.id }),
    launchNumbers(registry, [launch]),
    waitingComments(registry, launch.id),
  ]);
  return { ...detail, pieces, jobs, numbers: numbers.get(launch.id)!, waitingComments: waiting };
}
