import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need } from './settings.ts';

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'fake', name: 'Fake provider', settings: [{ key: 'apiKey', label: 'API key', secret: true }] } as const;

/**
 * A provider for tests, never in the registry: an OpenAI-compatible model at an address that does
 * not exist, so whatever answers it is the test's fetch. It claims no structured output, so it is
 * the one that exercises the submit tool, and it shows what adding a provider takes: this module and
 * a line in a registry.
 */
export const fakeAiProvider = aiProvider({
  ...self,
  listed: true,
  capabilities: { streaming: true, tools: true, structuredOutput: 'none', repoAccess: 'local-tools' },
  defaultModel: () => 'fake-model',
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const provider = createOpenAICompatible({
      name: 'fake',
      baseURL: 'https://fake.invalid/v1',
      apiKey: need(self, settings, 'apiKey'),
      ...(options.fetch && { fetch: options.fetch }),
    });
    return provider(modelId || 'fake-model');
  },
});
