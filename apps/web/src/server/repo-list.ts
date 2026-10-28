import type { GitHubRest } from '@shipcast/engine';
import type { Cache, Json } from '@shipcast/runtime/redis';

/*
 * The "Launch a repo" page lists the owner's repositories, which only GitHub knows: the one page
 * loader that cannot read the registry instead. With `realtime-ui` it is a cached read, shared by
 * every replica through the process's cache (Redis's with `redis-state`): GitHub is asked at most once
 * per REPO_LIST_TTL_SECONDS, and a new repository shows up within that, or at once from the
 * releases picker, which asks GitHub on the owner's click.
 */

export const REPO_LIST_TTL_SECONDS = 600;

export type RepoList = Array<{ repo: string; description: string | null; pushedAt: string }>;

export async function repoList(deps: { github: Pick<GitHubRest, 'userRepos'>; cache: Pick<Cache, 'remember'> | undefined }, owner: string): Promise<RepoList> {
  if (!deps.cache) return deps.github.userRepos(owner);
  // Plain JSON both ways: strings and nulls only
  const cached = await deps.cache.remember<Json>(`repos:${owner.toLowerCase()}`, REPO_LIST_TTL_SECONDS, async () => (await deps.github.userRepos(owner)) as unknown as Json);
  return cached as unknown as RepoList;
}
