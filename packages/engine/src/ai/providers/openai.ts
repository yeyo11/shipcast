import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need } from './settings.ts';

/** The OpenAI API's default in Action mode, where a developer picks OpenAI by a variable */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'openai', name: 'OpenAI API', settings: [{ key: 'apiKey', label: 'API key', secret: true }] } as const;

/**
 * The OpenAI API itself, through its own SDK provider: its current models refuse the `max_tokens`
 * that Chat Completions servers take, and the Responses API speaks their parameters. Strict JSON
 * Schema is off because the pack's schema has optional fields, which strict mode refuses. Not in the
 * AI settings: only Action mode chooses it.
 */
export const openaiAiProvider = aiProvider({
  ...self,
  listed: false,
  capabilities: { streaming: true, tools: true, structuredOutput: 'native', repoAccess: 'local-tools' },
  defaultModel: () => DEFAULT_OPENAI_MODEL,
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const openai = createOpenAI({ apiKey: need(self, settings, 'apiKey'), ...(options.fetch && { fetch: options.fetch }) });
    return openai(modelId || DEFAULT_OPENAI_MODEL);
  },
  providerOptions: { openai: { strictJsonSchema: false } },
});
