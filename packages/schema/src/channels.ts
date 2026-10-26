import { z } from 'zod';

/**
 * Every channel Shipcast publishes on, each through its own connector. Only networks Shipcast posts
 * to itself are channels: there are no drafts for the owner to post by hand
 * (docs/decisions/automatic-channels-only.md).
 */
export const CHANNELS = [
  'blog',
  'devto',
  'bluesky',
  'mastodon',
  'instagram',
  'reddit',
  'hashnode',
  'linkedin',
  'newsletter',
  'telegram',
  'discord',
  'githubDiscussions',
  'threads',
] as const;

export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

/**
 * - `auto`: published as soon as the pack is generated, without review.
 * - `approval`: in the drafts pull request; published when it is merged.
 * - `off`: not generated at all.
 */
export const PublishMode = z.enum(['auto', 'approval', 'off']);
export type PublishMode = z.infer<typeof PublishMode>;

/**
 * What a channel does when launch.yml does not mention it: the MVP's channels and GitHub Discussions
 * on, the rest off, so a network that needs an account is never drafted for before one is connected.
 */
export const DEFAULT_MODES: Readonly<Record<Channel, PublishMode>> = {
  blog: 'approval',
  devto: 'approval',
  bluesky: 'approval',
  mastodon: 'approval',
  instagram: 'approval',
  reddit: 'off',
  hashnode: 'off',
  linkedin: 'off',
  newsletter: 'off',
  telegram: 'off',
  discord: 'off',
  // Nothing to connect: the GitHub App posts it, so it is on like the MVP's channels
  githubDiscussions: 'approval',
  threads: 'off',
};

export const Language = z.enum(['en', 'es']);
export type Language = z.infer<typeof Language>;
