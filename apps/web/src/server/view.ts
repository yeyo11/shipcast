/** How the app names states, shared by the server functions and the pages */

export type Tone = 'published' | 'waiting' | 'draft' | 'manual' | 'failed';

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
  headline: Array<{ label: string; value: number }>;
}

/** A piece beside its channel's name: nothing for the post itself, the language for an article or an issue */
export function pieceName(kind: string): string {
  if (kind === 'post') return '';
  const lang = /^(?:article|issue):(\w+)$/.exec(kind)?.[1];
  return lang ? lang.toUpperCase() : kind;
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
  reddit: 'Reddit',
  hackerNews: 'Hacker News',
  productHunt: 'Product Hunt',
  linkedin: 'LinkedIn',
  x: 'X',
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
    hackerNews: 'hacker-news',
    linkedin: 'linkedin',
    x: 'x',
    telegram: 'telegram',
    discord: 'discord',
    github: 'github',
    productHunt: 'product-hunt',
    newsletter: 'newsletter',
  };
  return file[channel] ? `/icons/${file[channel]}.svg` : undefined;
}
