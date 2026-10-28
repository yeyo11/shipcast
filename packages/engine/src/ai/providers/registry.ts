import { anthropicAiProvider } from './anthropic.ts';
import { claudioAiProvider } from './claudio/index.ts';
import type { AiProviderDefinition } from './definition.ts';
import { openaiAiProvider } from './openai.ts';
import { openaiCompatibleAiProvider } from './openai-compatible.ts';

/**
 * Every AI provider Shipcast can run a task on, in the order the AI settings list them. A new
 * provider is its module in this folder and a line here.
 */
export const AI_PROVIDER_DEFINITIONS = [claudioAiProvider, anthropicAiProvider, openaiCompatibleAiProvider, openaiAiProvider] as const;

type Definitions = (typeof AI_PROVIDER_DEFINITIONS)[number];
/** Every provider's id, the ones only Action mode chooses included */
export type AiProviderDefinitionId = Definitions['id'];
/** The providers the AI settings offer */
export type ListedAiProviderId = Extract<Definitions, { listed: true }>['id'];

/**
 * The per-provider tables, derived from a list of definitions: the registry's below, and the contract
 * test's with a provider added, to show a new provider lands in the AI settings from its module alone.
 */
export function aiProviderTables(definitions: readonly AiProviderDefinition[]) {
  const listed = definitions.filter((d) => d.listed);
  return {
    ids: definitions.map((d) => d.id),
    /** What the AI settings offer, in order */
    listed: listed.map((d) => d.id),
    names: Object.fromEntries(definitions.map((d) => [d.id, d.name])) as Record<string, string>,
    byId: new Map<string, AiProviderDefinition>(definitions.map((d) => [d.id, d])),
  };
}

const TABLES = aiProviderTables(AI_PROVIDER_DEFINITIONS);

/** The providers the AI settings offer, as the settings' schema takes them */
export const LISTED_AI_PROVIDERS = TABLES.listed as readonly ListedAiProviderId[] as readonly [ListedAiProviderId, ...ListedAiProviderId[]];

/** A provider's definition; undefined for an id that is not one */
export function aiProviderDefinition(id: string): AiProviderDefinition | undefined {
  return TABLES.byId.get(id);
}

/** A provider's name, or the id as given */
export const aiProviderName = (id: string): string => TABLES.names[id] ?? id;

/** The providers the AI settings offer, as the settings name them */
export const AI_PROVIDERS = LISTED_AI_PROVIDERS;
export type AiProviderId = ListedAiProviderId;
