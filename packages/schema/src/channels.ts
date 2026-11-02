import { z } from 'zod';
import { LANGUAGE_PATTERN, type Language as LanguageCode } from './languages.ts';
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

/** A language code (languages.ts): an ISO 639-1 code, two lowercase letters */
export type Language = LanguageCode;

// A plain string schema at run time (its JSON Schema is a pattern), typed as the two letters it checks
export const Language = z.string().regex(LANGUAGE_PATTERN, 'a language is an ISO 639-1 code: two lowercase letters, such as en') as unknown as z.ZodType<Language, Language>;
