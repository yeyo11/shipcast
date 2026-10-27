/*
 * The Launches page's layout as plain data (docs/web-app.md): what waits for the owner leaves the
 * grid for slim rows above it, so the grid holds only launches that went out and every card in it
 * can be the same height. Safe in the browser bundle: no imports.
 */

/** Where a launch shows on the list */
export type LaunchLane =
  /** Drafts waiting in the pull request for the owner's approval: the yellow row */
  | 'approval'
  /** Not out and not waiting for the owner (drafting, or not launched): a quiet dashed row */
  | 'pending'
  /** Gone out, whole, in part or failing: a card in the grid */
  | 'out';

interface Laneable {
  status: string;
  state: { tone: string };
}

export function laneOf(launch: Laneable): LaunchLane {
  // A drafted launch with failures has partly gone out: it is a card, with its failures on it
  if (launch.status === 'drafted') return launch.state.tone === 'waiting' ? 'approval' : 'out';
  if (launch.status === 'detected' || launch.status === 'generating' || launch.status === 'skipped') return 'pending';
  return 'out';
}

/** The list split by lane, each keeping the list's own order (newest first) */
export function splitLaunches<T extends Laneable>(launches: readonly T[]): Record<LaunchLane, T[]> {
  const lanes: Record<LaunchLane, T[]> = { approval: [], pending: [], out: [] };
  for (const l of launches) lanes[laneOf(l)].push(l);
  return lanes;
}

/**
 * The project's picture: the GitHub avatar of the repo's owner, public and without a token. A
 * `logo:` in launch.yml would come first once it exists (future work, docs/web-app.md).
 */
export function ownerAvatarUrl(repo: string): string | null {
  const owner = repo.split('/')[0] ?? '';
  // GitHub logins are letters, digits and single hyphens; anything else is not asked for
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(owner)) return null;
  return `https://avatars.githubusercontent.com/${owner}?size=80`;
}
