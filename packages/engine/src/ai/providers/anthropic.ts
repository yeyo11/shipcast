import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need } from './settings.ts';

/** Anthropic's current Opus, the default when the Anthropic API is chosen without a model */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'anthropic', name: 'Anthropic API', settings: [{ key: 'apiKey', label: 'API key', secret: true }] } as const;

/** The Anthropic API; a repo is read through Shipcast's own tools over the checkout */
export const anthropicAiProvider = aiProvider({
  ...self,
  listed: true,
  capabilities: { streaming: true, tools: true, structuredOutput: 'native', repoAccess: 'local-tools' },
  defaultModel: () => DEFAULT_ANTHROPIC_MODEL,
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const anthropic = createAnthropic({ apiKey: need(self, settings, 'apiKey'), ...(options.fetch && { fetch: options.fetch }) });
    return anthropic(modelId || DEFAULT_ANTHROPIC_MODEL);
  },
});
