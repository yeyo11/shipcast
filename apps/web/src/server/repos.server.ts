import { GitHubError, type GitHubRest, type Preflight, type Repositories } from '@shipcast/engine';
import type { Cache } from '@shipcast/runtime/redis';
import { Refused, ShipcastError } from '@shipcast/schema';
import { launchService } from './app-services.ts';
import type { AppContext } from './context.server.ts';
import { repoList } from './repo-list.ts';
import type { ReposApi } from './repos-api.ts';

/*
 * The repos and releases a launch is made from, and the pre-flight alone, as the repos routes
 * (repos-api.ts) and the Launch page's server functions (launches.functions.ts) both need them. One
 * implementation, two doors.
 *
 * Every read goes to GitHub, so the rate limit is minded the way the page always did: the repo list
 * through the process's shared cache (repo-list.ts), the releases and the pre-flight through the
 * client's own conditional requests, whose 304s cost nothing against the limit.
 */

export interface ReposDeps {
  github: Pick<GitHubRest, 'userRepos' | 'releases'>;
  /** The launch service's pre-flight, the one a launch by hand runs before its claim */
  preflight(repo: string, ref: string | undefined): Promise<Preflight>;
  cache: Pick<Cache, 'remember'> | undefined;
  registry: { launches: Pick<Repositories['launches'], 'find'> };
  /** The brand's GitHub owner, whose repos are offered */
  owner(): Promise<string>;
}

/**
 * GitHub's failures as Shipcast's own, so the API answers them with a status rather than a 500: a repo
 * GitHub does not show this token is not found, anything else (its rate limit among them) is upstream
 */
async function fromGitHub<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (error.status === 404) throw new Refused('not_found', `GitHub has no ${what} that Shipcast can read`);
    throw new ShipcastError(`GitHub did not answer for ${what} (${error.status}); try again in a while`, { code: 'upstream', httpStatus: 502, retryable: true, cause: error });
  }
}

export function reposService(deps: ReposDeps): ReposApi {
  return {
    async repos() {
      const owner = await deps.owner();
      const repos = await fromGitHub(`owner ${owner}`, () => repoList(deps, owner));
      return { owner, repos };
    },
    async releases(repo) {
      const releases = await fromGitHub(`repo ${repo}`, () => deps.github.releases(repo));
      // A page of releases at most (GitHub's 30), each one indexed lookup of the claim that keeps a launch to once
      const launches = await Promise.all(releases.map((r) => deps.registry.launches.find(repo, r.tag)));
      return releases.map((r, i) => {
        const launch = launches[i];
        return { ...r, launch: launch ? { id: launch.id, status: launch.status } : null };
      });
    },
    check: (repo, ref) => fromGitHub(`repo ${repo}`, () => deps.preflight(repo, ref)),
  };
}

/** What the repos routes run in the app's process, built per request by api-deps.server.ts */
export function reposApi(ctx: AppContext): ReposApi {
  return reposService({
    github: ctx.github,
    preflight: (repo, ref) => launchService(ctx).preflight(repo, ref),
    cache: ctx.process.shared.cache,
    registry: ctx.registry,
    owner: async () => (await ctx.brand()).github,
  });
}
