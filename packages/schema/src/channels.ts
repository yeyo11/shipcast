import { z } from 'zod';

/**
 * Every channel Shipcast knows. The MVP publishes on blog, devto, bluesky, mastodon, instagram and
 * the newsletter (docs/decisions/mvp-scope.md); reddit can draft but is off unless a launch.yml turns
 * it on; the rest are named now so a launch.yml written today stays valid when their connectors arrive.
 */
export const CHANNELS = [
  'blog',
  'devto',
  'bluesky',
  'mastodon',
  'instagram',
  'reddit',
  'hackerNews',
  'hashnode',
  'linkedin',
  'x',
  'productHunt',
  'newsletter',
  'telegram',
  'discord',
] as const;

export const Channel = z.enum(CHANNELS);
export type Channel = z.infer<typeof Channel>;

/**
 * - `auto`: published as soon as the pack is generated, without review.
 * - `approval`: in the drafts pull request; published when it is merged.
 * - `manual`: in the drafts pull request as a draft the owner posts by hand; Shipcast never posts it.
 * - `off`: not generated at all.
 */
export const PublishMode = z.enum(['auto', 'approval', 'manual', 'off']);
export type PublishMode = z.infer<typeof PublishMode>;

/** Communities that judge self-promotion by hand: Shipcast only ever drafts for them. */
export const DRAFT_ONLY_CHANNELS: readonly Channel[] = ['reddit', 'hackerNews', 'productHunt'];

/** What a channel does when launch.yml does not mention it: the MVP's channels on, the rest off (Reddit, by the owner's choice, since 2026-10-25). */
export const DEFAULT_MODES: Readonly<Record<Channel, PublishMode>> = {
  blog: 'approval',
  devto: 'approval',
  bluesky: 'approval',
  mastodon: 'approval',
  instagram: 'approval',
  reddit: 'off',
  hackerNews: 'off',
  hashnode: 'off',
  linkedin: 'off',
  x: 'off',
  productHunt: 'off',
  newsletter: 'off',
  telegram: 'off',
  discord: 'off',
};

export const Language = z.enum(['en', 'es']);
export type Language = z.infer<typeof Language>;
