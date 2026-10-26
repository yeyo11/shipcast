/** How the app names states, shared by the server functions and the pages */

export type Tone = 'published' | 'waiting' | 'draft' | 'quiet' | 'failed';

export interface LaunchView {
  id: number;
  repo: string;
  ref: string;
  kind: string;
  trigger: string;
  status: string;
  /** The state in the owner's words, and its shape */
  state: { label: string; tone: Tone };
  pullRequest: string | undefined;
  problem: string | undefined;
  createdAt: string;
  /** One per piece: a channel can have several (an article per language, an issue per language, a story) */
  posts: Array<{ id: number; channel: string; kind: string; url: string | null; publishedAt: string; status: string; scheduledAt: string | null }>;
  failures: Array<{ channel: string; message: string }>;
  /** Replies Shipcast sent under this launch's posts, per channel: a count, never a row each */
  replies: Record<string, number>;
  headline: Array<{ label: string; value: number }>;
}

/** A piece beside its channel's name: nothing for the post itself, the language for an article or an issue */
export function pieceName(kind: string): string {
  if (kind === 'post') return '';
  const lang = /^(?:article|issue):(\w+)$/.exec(kind)?.[1];
  return lang ? lang.toUpperCase() : kind;
}

/** One channel of a launch: its pieces, the state of the lot, and how many replies it answered */
export interface ChannelGroup {
  channel: string;
  pieces: Array<{ key: string; label: string; url: string | null; status: string; failure: string | undefined }>;
  state: { label: string; tone: Tone };
  /** Open by itself: a failed piece is never left folded away */
  hasFailure: boolean;
  /** More than one piece, so the row can be opened */
  expandable: boolean;
  replies: number;
}

/**
 * A launch's pieces grouped by channel, in the order the channels first appear. One row per channel is
 * what the owner reads ("did it go out everywhere?"); the pieces (a language, a story) are its detail.
 * A channel that failed before anything was published has no piece, only its failure.
 */
export function groupChannels(launch: Pick<LaunchView, 'posts' | 'failures' | 'replies'>): ChannelGroup[] {
  const order: string[] = [];
  const note = (channel: string) => {
    if (!order.includes(channel)) order.push(channel);
  };
  for (const p of launch.posts) note(p.channel);
  for (const f of launch.failures) note(f.channel);
  return order.map((channel) => {
    const failure = launch.failures.find((f) => f.channel === channel)?.message;
    const pieces = launch.posts
      .filter((p) => p.channel === channel)
      .map((p) => ({ key: String(p.id), label: pieceName(p.kind) || 'Post', url: p.url, status: p.status, failure: undefined as string | undefined }));
    if (pieces.length === 0 && failure !== undefined) pieces.push({ key: `failed:${channel}`, label: 'Post', url: null, status: 'failed', failure });
    const live = pieces.filter((p) => p.status === 'live' || p.status === 'edited').length;
    const scheduled = pieces.filter((p) => p.status === 'scheduled').length;
    const deleted = pieces.filter((p) => p.status === 'deleted').length;
    let state: ChannelGroup['state'];
    if (failure !== undefined) state = live > 0 ? { label: `${live} of ${pieces.length}`, tone: 'failed' } : { label: 'Failed', tone: 'failed' };
    else if (deleted === pieces.length) state = { label: 'Deleted', tone: 'quiet' };
    else if (scheduled > 0) state = { label: scheduled === pieces.length ? 'Scheduled' : `${live} of ${pieces.length}`, tone: 'waiting' };
    else state = live === pieces.length ? { label: 'Published', tone: 'published' } : { label: `${live} of ${pieces.length}`, tone: 'waiting' };
    return { channel, pieces, state, hasFailure: failure !== undefined, expandable: pieces.length > 1, replies: launch.replies[channel] ?? 0 };
  });
}

export const CHANNEL_NAMES: Record<string, string> = {
  blog: 'Blog',
  devto: 'dev.to',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  instagram: 'Instagram',
  newsletter: 'Newsletter',
  hashnode: 'Hashnode',
  telegram: 'Telegram',
  discord: 'Discord',
  githubDiscussions: 'GitHub Discussions',
  threads: 'Threads',
  reddit: 'Reddit',
  linkedin: 'LinkedIn',
  // Metric sources that are not channels, as their cards on a launch's page are titled
  search: 'Google Search',
  bing: 'Bing',
  github: 'GitHub',
};

/** The design system's glyph for a channel, when it has one */
export function channelIcon(channel: string): string | undefined {
  const file: Record<string, string> = {
    blog: 'blog',
    devto: 'devto',
    bluesky: 'bluesky',
    mastodon: 'mastodon',
    instagram: 'instagram',
    hashnode: 'hashnode',
    reddit: 'reddit',
    linkedin: 'linkedin',
    telegram: 'telegram',
    discord: 'discord',
    github: 'github',
    githubDiscussions: 'github',
    newsletter: 'newsletter',
  };
  return file[channel] ? `/icons/${file[channel]}.svg` : undefined;
}
