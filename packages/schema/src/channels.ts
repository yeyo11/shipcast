import { z } from 'zod';
import { CHANNELS, type ChannelId } from './channels/registry.ts';

/** Every channel Shipcast publishes on: the ids of the registry (channels/registry.ts) */
export const Channel = z.enum(CHANNELS);
export type Channel = ChannelId;

/**
 * - `auto`: published as soon as the pack is generated, without review.
 * - `approval`: in the drafts pull request; published when it is merged.
 * - `off`: not generated at all.
 */
export const PublishMode = z.enum(['auto', 'approval', 'off']);
export type PublishMode = z.infer<typeof PublishMode>;

export const Language = z.enum(['en', 'es']);
export type Language = z.infer<typeof Language>;
