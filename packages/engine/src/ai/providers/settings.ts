import { AiError } from '@shipcast/schema';
import type { AiProviderDefinition, AiProviderSettings } from './definition.ts';

/**
 * A setting the provider cannot build a model without. The error names the field, never a value,
 * and asks the owner to connect the provider: only they can fix it.
 */
export function need(definition: Pick<AiProviderDefinition, 'id' | 'name' | 'settings'>, settings: AiProviderSettings, key: string): string {
  const value = settings[key]?.trim();
  if (value) return value;
  const label = definition.settings.find((f) => f.key === key)?.label ?? key;
  throw new AiError('ai_not_connected', `the ${definition.name} has no ${label}: connect the AI provider again`, { provider: definition.id });
}

/** A setting that may be empty */
export const optional = (settings: AiProviderSettings, key: string): string | undefined => settings[key]?.trim() || undefined;

/** A base URL as the SDKs join paths to it */
export const trimSlash = (url: string): string => url.replace(/\/+$/, '');
