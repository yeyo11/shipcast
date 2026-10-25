import { CAPABILITIES, launchConfigOf, readTimezone, SCHEDULABLE_CHANNELS, type Launch, type Registry, type ReviewGitHub } from '@shipcast/engine';
import type { Channel } from '@shipcast/schema';
import { pieceRows, type PieceState } from './pieces.ts';

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
  const [posts, accounts, readings, comments] = await Promise.all([
    registry.posts(launch.id),
    registry.accounts(),
    registry.postMetricHistory(launch.id),
    // What the assistant answered: the comments of others it sent a reply to (the page counts them, never lists them)
    registry.comments({ launchId: launch.id, own: false, status: 'sent', limit: 5000 }),
  ]);
  const replies: Record<string, number> = {};
  for (const c of comments) replies[c.channel] = (replies[c.channel] ?? 0) + 1;
  const rows = pieceRows({
    posts: posts.filter((p) => p.status !== 'scheduled'),
    accounts: accounts.map((a) => ({ id: a.id, label: a.label, identity: a.identity, avatarUrl: a.avatarUrl })),
    readings,
    capabilities: CAPABILITIES,
  });
  return { rows, replies, capabilities: CAPABILITIES, scheduling: await schedulingChannels(registry, launch, posts, deps) };
}

/**
 * The channels a time can be set for: only while the launch is drafted, the channels the engine
 * publishes that launch.yml does not set to manual or off (or, when it cannot be read, those with a
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
    if (config) return config.publishing[channel] !== 'manual' && config.publishing[channel] !== 'off';
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
