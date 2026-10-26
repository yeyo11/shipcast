import { CAPABILITIES, launchConfigOf, readTimezone, SCHEDULABLE_CHANNELS, type Launch, type Registry, type ReviewGitHub } from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import { accountRows, pieceRows, type PieceState, type SnapshotInput } from './pieces.ts';

/** A channel a drafted launch can still put on a time, and its scheduled piece when it has one */
export interface SchedulingChannel {
  channel: Channel;
  scheduled: PieceState | null;
}

/**
 * What a launch's page shows of its published pieces: one row per piece with its account, numbers
 * over time and actions, the comment assistant's count per channel, and the channels a drafted
 * launch can still schedule. Read beside launchDetail, which the REST API shares and which keeps
 * its shape.
 */
export async function launchPieces(registry: Registry, launch: Launch, deps: { github: Pick<ReviewGitHub, 'fileAt'>; launchesRepo: string; draftPaths: readonly string[] }) {
  const [posts, accounts, readings, replies] = await Promise.all([
    registry.posts(launch.id),
    registry.accounts(),
    registry.postMetricHistory(launch.id),
    // What the assistant answered, counted per channel: the page never lists them
    registry.sentReplies(launch.id),
  ]);
  const out = posts.filter((p) => p.status !== 'scheduled');
  const shaped = accounts.map((a) => ({ id: a.id, network: a.network, label: a.label, identity: a.identity, avatarUrl: a.avatarUrl }));
  const rows = pieceRows({ posts: out, accounts: shaped, readings, capabilities: CAPABILITIES });
  // A week before the launch's day, so the line shows where the followers stood before it
  const since = new Date(Date.parse(launch.createdAt) - 7 * 86_400_000).toISOString().slice(0, 10);
  const usedIds = [...new Set(out.flatMap((p) => (p.accountId === null ? [] : [p.accountId])))];
  const snapshots: SnapshotInput[] = (await Promise.all(usedIds.map((id) => registry.accountSnapshots(id, { since })))).flat();
  const accountNumbers = accountRows({ posts: out, accounts: shaped, snapshots, launchedAt: launch.createdAt });
  return { rows, replies, accounts: accountNumbers, capabilities: CAPABILITIES, scheduling: await schedulingChannels(registry, launch, posts, deps) };
}

/**
 * The channels a time can be set for: only while the launch is drafted, the channels the engine
 * publishes that launch.yml does not set to off (or, when it cannot be read, those with a
 * draft in the pull request), and nothing of which is out yet.
 */
async function schedulingChannels(
  registry: Registry,
  launch: Launch,
  posts: Awaited<ReturnType<Registry['posts']>>,
  deps: { github: Pick<ReviewGitHub, 'fileAt'>; launchesRepo: string; draftPaths: readonly string[] },
): Promise<{ timezone: string; channels: SchedulingChannel[] }> {
  const timezone = await readTimezone(registry);
  if (launch.status !== 'drafted' && launch.status !== 'detected' && launch.status !== 'generating') return { timezone, channels: [] };
  const config = await launchConfigOf(deps.github, deps.launchesRepo, launch).catch(() => undefined);
  const drafted = (channel: Channel) =>
    deps.draftPaths.some((path) => {
      const name = path.split('/').at(-1) ?? '';
      return name === `${channel}.md` || (channel === 'newsletter' && name.startsWith('newsletter-'));
    });
  const candidates = SCHEDULABLE_CHANNELS.filter((channel) => {
    if (config) return config.publishing[channel] !== 'off';
    return drafted(channel);
  });
  const channels: SchedulingChannel[] = [];
  for (const channel of candidates) {
    const mine = posts.filter((p) => p.channel === channel);
    if (mine.some((p) => p.status !== 'scheduled')) continue;
    const scheduled = mine.find((p) => p.status === 'scheduled');
    channels.push({ channel, scheduled: scheduled ? { id: scheduled.id, status: scheduled.status, updatedAt: scheduled.updatedAt, scheduledAt: scheduled.scheduledAt } : null });
  }
  return { timezone, channels };
}
