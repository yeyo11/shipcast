import type { AnyChannelAdapter } from './adapter.ts';
import { blueskyAdapter } from './bluesky.ts';
import { devtoAdapter } from './devto.ts';
import { discordAdapter } from './discord.ts';
import { githubDiscussionsAdapter } from './github-discussions.ts';
import { hashnodeAdapter } from './hashnode.ts';
import { instagramAdapter } from './instagram.ts';
import { linkedinAdapter } from './linkedin.ts';
import { mastodonAdapter } from './mastodon.ts';
import { newsletterAdapter } from './newsletter.ts';
import { redditAdapter } from './reddit.ts';
import { telegramAdapter } from './telegram.ts';
import { threadsAdapter } from './threads.ts';
import { youtubeAdapter } from './youtube.ts';

/**
 * The adapter half of every channel the engine publishes, by the definitions' ids (the blog is
 * published by the merge, and has none). The order is the Channels page's, where the networks are
 * listed as before; a new channel is its module and a line here, beside its definition's line in
 * packages/schema/src/channels/registry.ts.
 */
export const CHANNEL_ADAPTERS: readonly AnyChannelAdapter[] = [
  devtoAdapter,
  blueskyAdapter,
  mastodonAdapter,
  instagramAdapter,
  threadsAdapter,
  linkedinAdapter,
  redditAdapter,
  newsletterAdapter,
  hashnodeAdapter,
  telegramAdapter,
  discordAdapter,
  youtubeAdapter,
  githubDiscussionsAdapter,
];

/** A channel's adapter, or undefined for a channel with none (the blog) */
export function adapterOf(channel: string, adapters: readonly AnyChannelAdapter[] = CHANNEL_ADAPTERS): AnyChannelAdapter | undefined {
  return adapters.find((a) => a.definition.id === channel);
}
