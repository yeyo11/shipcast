import { CAPABILITIES, launchConfigOf, readTimezone, SCHEDULABLE_CHANNELS, type Launch, type Repositories, type ReviewGitHub } from '@shipcast/engine';
import { draftOf, type Channel, type LaunchConfig } from '@shipcast/schema';
import { accountRows, pieceRows, type PieceState, type SnapshotInput } from './pieces.ts';
import { accountAvatar } from './pieces.ts';

interface PiecesDeps {
  github: Pick<ReviewGitHub, 'fileAt'>;
  launchesRepo: string;
  draftPaths: readonly string[] | Promise<readonly string[]>;
  /**
   * With `github-events`: launch.yml as the drafts snapshot kept it, instead of a read from GitHub;
   * with `launch-store-read`, the launch model's channel rows. Asked only for a launch that can still schedule
   */
  launchConfig?: () => Promise<LaunchConfig | undefined>;
}

/** A channel a drafted launch can still put on a time, and its scheduled piece when it has one */
export interface SchedulingChannel {
  channel: Channel;
  scheduled: PieceState | null;
  /** launch.yml's mode for it, when launch.yml could be read: `auto` goes out on its own at its time */
  mode?: 'auto' | 'approval';
  /** Its network's account when the last check of it failed: the piece waits until it is reconnected */
  broken?: { id: number; label: string; problem: string | null };
}

/**
 * What a launch's page shows of its published pieces: one row per piece with its account, numbers
 * over time and actions, the comment assistant's count per channel, and the channels a drafted
 * launch can still schedule. Read beside launchDetail, which the REST API shares and which keeps
 * its shape.
 */
export async function launchPieces(registry: Pick<Repositories, 'posts' | 'metrics' | 'accounts' | 'comments' | 'settings'>, launch: Launch, deps: PiecesDeps) {
  const [posts, accounts, readings, replies] = await Promise.all([
    registry.posts.posts(launch.id),
    registry.accounts.accounts(),
    registry.metrics.postMetricHistory(launch.id),
    // What the assistant answered, counted per channel: the page never lists them
    registry.comments.sentReplies(launch.id),
  ]);
  const out = posts.filter((p) => p.status !== 'scheduled');
  const shaped = accounts.map((a) => ({ id: a.id, network: a.network, label: a.label, identity: a.identity, avatarUrl: accountAvatar(a) }));
  const rows = pieceRows({ posts: out, accounts: shaped, readings, capabilities: CAPABILITIES });
  // A week before the launch's day, so the line shows where the followers stood before it
  const since = new Date(Date.parse(launch.createdAt) - 7 * 86_400_000).toISOString().slice(0, 10);
  const usedIds = [...new Set(out.flatMap((p) => (p.accountId === null ? [] : [p.accountId])))];
  const snapshots: SnapshotInput[] = (await Promise.all(usedIds.map((id) => registry.accounts.accountSnapshots(id, { since })))).flat();
  const accountNumbers = accountRows({ posts: out, accounts: shaped, snapshots, launchedAt: launch.createdAt });
  return { rows, replies, accounts: accountNumbers, capabilities: CAPABILITIES, scheduling: await schedulingChannels(registry, launch, posts, accounts, deps) };
}

/**
 * The channels a time can be set for: only while the launch is drafted, the channels the engine
 * publishes that launch.yml does not set to off (or, when it cannot be read, those with a
 * draft in the pull request), and nothing of which is out yet.
 */
async function schedulingChannels(
  registry: Pick<Repositories, 'posts' | 'metrics' | 'accounts' | 'comments' | 'settings'>,
  launch: Launch,
  posts: Awaited<ReturnType<Repositories['posts']['posts']>>,
  accounts: Awaited<ReturnType<Repositories['accounts']['accounts']>>,
  deps: PiecesDeps,
): Promise<{ timezone: string; channels: SchedulingChannel[] }> {
  const timezone = await readTimezone(registry);
  if (launch.status !== 'drafted' && launch.status !== 'detected' && launch.status !== 'generating') return { timezone, channels: [] };
  const config = await (deps.launchConfig ? deps.launchConfig() : launchConfigOf(deps.github, deps.launchesRepo, launch)).catch(() => undefined);
  // Only needed when launch.yml cannot be read; the caller may still be reading them from GitHub
  const draftPaths = config ? [] : await deps.draftPaths;
  // Each channel's drafts found by its own matcher: `github-discussion.md`, `newsletter-<lang>.md`
  const drafted = (channel: Channel) => draftPaths.some((path) => draftOf(path)?.channel === channel);
  const candidates = SCHEDULABLE_CHANNELS.filter((channel) => {
    if (config) return config.publishing[channel] !== 'off';
    return drafted(channel);
  });
  const channels: SchedulingChannel[] = [];
  for (const channel of candidates) {
    const mine = posts.filter((p) => p.channel === channel);
    if (mine.some((p) => p.status !== 'scheduled')) continue;
    const scheduled = mine.find((p) => p.status === 'scheduled');
    const mode = config?.publishing[channel];
    // The account a piece goes out with: the network's primary one (a channel's network shares its id)
    const own = accounts.filter((a) => a.network === channel);
    const account = own.find((a) => a.primary) ?? own[0];
    channels.push({
      channel,
      scheduled: scheduled ? { id: scheduled.id, status: scheduled.status, updatedAt: scheduled.updatedAt, scheduledAt: scheduled.scheduledAt } : null,
      ...((mode === 'auto' || mode === 'approval') && { mode }),
      ...(account?.status === 'failed' && { broken: { id: account.id, label: account.label, problem: account.problem } }),
    });
  }
  return { timezone, channels };
}
