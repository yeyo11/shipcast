import { Refused, type Brand } from '@shipcast/schema';
import { claimArticle, type ArticleInput } from '../article.ts';
import { claimManual, type PipelineDeps } from '../pipeline.ts';
import type { LaunchLookup } from '../ports.ts';
import { preflight, type Preflight, type PreflightSource } from '../preflight.ts';
import type { Launch } from '../registry.ts';
import { approveLaunch, type ReviewGitHub } from '../review.ts';

/** Why a launch was not started, approved or published again; `launch` is the one found in the way, when there is one */
export class LaunchRefused extends Refused<'not_found' | 'not_ready' | 'launched' | 'state' | 'invalid'> {
  readonly launch: Launch | undefined;

  constructor(reason: LaunchRefused['reason'], message: string, launch?: Launch) {
    super(reason, message);
    this.launch = launch;
  }
}

/** A manual launch that was claimed, with the pre-flight it passed */
export interface Claimed {
  launch: Launch;
  preflight: Preflight;
}

export interface LaunchServiceDeps {
  launches: LaunchLookup;
  /** The claim's: the registry that records it once, and GitHub for the latest release when no ref is named */
  claims: Pick<PipelineDeps, 'github' | 'registry' | 'launchesRepo'>;
  github: PreflightSource & ReviewGitHub;
}

/**
 * Starting and moving a launch along, the way the app, the REST API and the CLI do it: a repo
 * launched by hand after its pre-flight, an article written in the app, and the drafts approved
 * (publishing again is PublishingService's). "A launch happens once": every start is a claim that a
 * second click, a re-run or another process finds taken. Drafting and publishing themselves are jobs, which
 * the caller queues (or, in the CLI, runs) with the launch this answers.
 */
export class LaunchService {
  readonly #deps: LaunchServiceDeps;

  constructor(deps: LaunchServiceDeps) {
    this.#deps = deps;
  }

  async #launch(launchId: number): Promise<Launch> {
    const launch = await this.#deps.launches.get(launchId);
    if (!launch) throw new LaunchRefused('not_found', 'no such launch');
    return launch;
  }

  /** The repo's checks before a launch: a release, launch.yml, a README… */
  preflight(repo: string, ref: string | undefined): Promise<Preflight> {
    return preflight(repo, ref, { github: this.#deps.github });
  }

  /**
   * Claims a repo's launch by hand once its pre-flight passes. Refused (LaunchRefused) when a
   * required check fails (`not_ready`, its details in the words), when the release cannot be found
   * (`invalid`), or when that release was launched already (`launched`). `checked` is told the
   * pre-flight whatever it found, for a caller that shows every check (the CLI). The brand is read
   * only once the pre-flight passed: a repo not ready never needs the launches repo's brand.yml.
   */
  async claimManual(repo: string, ref: string | undefined, brand: () => Promise<Brand>, checked?: (preflight: Preflight) => void): Promise<Claimed> {
    const check = await this.preflight(repo, ref);
    checked?.(check);
    if (!check.ok) throw new LaunchRefused('not_ready', check.checks.filter((c) => !c.ok && c.required).map((c) => c.detail).join(' '));
    const claim = await claimManual(repo, ref, await brand(), this.#deps.claims);
    if ('error' in claim) throw new LaunchRefused('invalid', claim.error);
    if (!claim.claimed) throw new LaunchRefused('launched', `${repo} ${claim.launch.ref} was launched already (${claim.launch.status}).`, claim.launch);
    return { launch: claim.launch, preflight: check };
  }

  /** Claims an article written in the app; one whose draft failed can be written again under the same title */
  async claimArticle(input: ArticleInput, brand: Brand): Promise<Launch> {
    const claim = await claimArticle(input, brand, this.#deps.claims);
    if (!claim.claimed && claim.launch.status !== 'failed') throw new LaunchRefused('launched', `An article titled like this exists already (${claim.launch.status}). Change the title.`, claim.launch);
    return claim.launch;
  }

  /** Approves the drafts: merges their pull request, after which the caller queues the publishing */
  async approve(launchId: number): Promise<Launch> {
    const launch = await this.#launch(launchId);
    await approveLaunch(launch, { github: this.#deps.github, launchesRepo: this.#deps.claims.launchesRepo });
    return launch;
  }
}
