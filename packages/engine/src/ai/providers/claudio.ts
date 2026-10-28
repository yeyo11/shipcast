import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need, optional, trimSlash } from './settings.ts';

const fields = [
  { key: 'url', label: 'URL', secret: false },
  { key: 'token', label: 'token', secret: true },
  // The name of a claudio tool preset that only reads (Read, Grep, Glob, git log): whatever claudio
  // calls it, so it is a setting and not a name written here
  { key: 'toolPreset', label: 'read-only tool preset', secret: false, optional: true },
] as const;

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'claudio', name: 'claudio', settings: fields } as const;

/**
 * claudio, through its OpenAI-compatible API at `/api/v1` (claudio 0.10). Behind it is an agent,
 * Claude Code, which reads the job's checkout where claudio mounts the workspace: so it gets no
 * client tools (claudio refuses client tools beside a response format), but its own read-only tools,
 * chosen by a preset header, and the folder to work in by another. Its /v1 takes no turn or budget
 * ceiling today, so the task's `maxTurns` and `maxBudgetUsd` are not sent; Shipcast's timeout and
 * output-token ceiling still hold.
 */
export const claudioAiProvider = aiProvider({
  ...self,
  listed: true,
  capabilities: { streaming: true, tools: false, structuredOutput: 'native-without-tools', repoAccess: 'remote-workspace' },
  // Its model catalog names its own default `default`
  defaultModel: () => 'default',
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const openai = createOpenAICompatible({
      name: 'claudio',
      baseURL: `${trimSlash(need(self, settings, 'url'))}/api/v1`,
      apiKey: need(self, settings, 'token'),
      supportsStructuredOutputs: true,
      ...(options.fetch && { fetch: options.fetch }),
    });
    return openai(modelId || 'default');
  },
  requestHeaders(settings, context) {
    const headers: Record<string, string> = {};
    if (context.cwd) headers['X-Claudio-Cwd'] = context.cwd;
    const preset = optional(settings, 'toolPreset');
    if (context.needsRepo && preset) headers['X-Claudio-Tool-Preset'] = preset;
    return headers;
  },
});
