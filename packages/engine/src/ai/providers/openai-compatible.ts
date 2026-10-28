import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need, optional, trimSlash } from './settings.ts';

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'openaiCompatible', name: 'OpenAI-compatible server', settings: [
  { key: 'baseUrl', label: 'base URL', secret: false },
  { key: 'model', label: 'model', secret: false },
  { key: 'apiKey', label: 'API key', secret: true, optional: true },
] } as const;

/**
 * Any server that speaks OpenAI's chat completions: a local model (Ollama, llama.cpp, vLLM) or a
 * hosted one. Most honour a JSON Schema response format, fewer honour it beside tools, so a task
 * with tools answers through the submit tool.
 */
export const openaiCompatibleAiProvider = aiProvider({
  ...self,
  listed: true,
  capabilities: { streaming: true, tools: true, structuredOutput: 'native-without-tools', repoAccess: 'local-tools' },
  defaultModel: (settings: AiProviderSettings) => need(self, settings, 'model'),
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const apiKey = optional(settings, 'apiKey');
    const provider = createOpenAICompatible({
      name: 'openaiCompatible',
      baseURL: trimSlash(need(self, settings, 'baseUrl')),
      supportsStructuredOutputs: true,
      ...(apiKey && { apiKey }),
      ...(options.fetch && { fetch: options.fetch }),
    });
    return provider(modelId || need(self, settings, 'model'));
  },
});
