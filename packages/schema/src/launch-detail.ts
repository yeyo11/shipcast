/**
 * The pull request number a launch's detail points to, if its drafts went through one. A drafted
 * launch's detail is the pull request's URL; a skipped one's adds why after it, and still names it.
 */
export function pullRequestNumber(launch: { detail: string | null }): number | undefined {
  const number = Number(/\/pull\/(\d+)/.exec(launch.detail ?? '')?.[1]);
  return number || undefined;
}
