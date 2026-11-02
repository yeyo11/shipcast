/*
 * The Channels page groups its networks by what they are for, as tabs: where posts go (social),
 * where long writing goes (blog and newsletter) and what only reads numbers (measurement). A network
 * does not declare a group: it follows from what the catalog says it does (an AI flag, the channel it
 * publishes, that channel's definition's group), so a new connector lands in the right tab by itself.
 * The AI providers are a group with no tab: they are configured in Settings → AI, which links to
 * each one's connect page (since 2026-11-02).
 */

import { LONG_FORM_CHANNELS } from '@shipcast/schema/channels';

export type NetworkGroup = 'social' | 'blog' | 'measurement' | 'ai';

/** The Channels page's tabs; `short` is the tab's name on a phone, where they must fit one line */
export const NETWORK_GROUPS: ReadonlyArray<{ id: Exclude<NetworkGroup, 'ai'>; name: string; short: string }> = [
  { id: 'social', name: 'Social networks', short: 'Social' },
  { id: 'blog', name: 'Blog & newsletter', short: 'Blog' },
  { id: 'measurement', name: 'Measurement', short: 'Measurement' },
];

/** Whether a network is an AI provider, which lives in Settings → AI rather than on Channels */
export const isAiNetwork = (network: { ai?: boolean | undefined }): boolean => network.ai === true;

/** The channels that carry an article or a newsletter rather than a short post */
const LONG_FORM: ReadonlySet<string> = new Set(LONG_FORM_CHANNELS);

export function groupOf(network: { channel?: string | undefined; ai?: boolean | undefined }): NetworkGroup {
  if (network.ai) return 'ai';
  if (!network.channel) return 'measurement';
  return LONG_FORM.has(network.channel) ? 'blog' : 'social';
}

/** A tab of the Channels page named in the address; `ai`, the removed tab, is not one */
export function readGroup(value: unknown): Exclude<NetworkGroup, 'ai'> | undefined {
  return NETWORK_GROUPS.find((g) => g.id === value)?.id;
}
