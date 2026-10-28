/*
 * The Channels page groups its networks by what they are for, as tabs: where posts go (social),
 * where long writing goes (blog and newsletter), what only reads numbers (measurement) and the AI
 * providers. A network does not declare a group: it follows from what the catalog says it does
 * (an AI flag, the channel it publishes, that channel's definition's group), so a new connector lands
 * in the right tab by itself.
 */

import { LONG_FORM_CHANNELS } from '@shipcast/schema/channels';

export type NetworkGroup = 'social' | 'blog' | 'measurement' | 'ai';

export const NETWORK_GROUPS: ReadonlyArray<{ id: NetworkGroup; name: string }> = [
  { id: 'social', name: 'Social networks' },
  { id: 'blog', name: 'Blog & newsletter' },
  { id: 'measurement', name: 'Measurement' },
  { id: 'ai', name: 'AI providers' },
];

/** The channels that carry an article or a newsletter rather than a short post */
const LONG_FORM: ReadonlySet<string> = new Set(LONG_FORM_CHANNELS);

export function groupOf(network: { channel?: string | undefined; ai?: boolean | undefined }): NetworkGroup {
  if (network.ai) return 'ai';
  if (!network.channel) return 'measurement';
  return LONG_FORM.has(network.channel) ? 'blog' : 'social';
}

export function readGroup(value: unknown): NetworkGroup | undefined {
  return NETWORK_GROUPS.find((g) => g.id === value)?.id;
}
