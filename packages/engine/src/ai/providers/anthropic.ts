import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from './definition.ts';
import { need } from './settings.ts';

/** Anthropic's current Opus, the default when the Anthropic API is chosen without a model */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'anthropic', name: 'Anthropic API', settings: [{ key: 'apiKey', label: 'API key', secret: true }] } as const;

/**
 * Anthropic's cache breakpoint as @ai-sdk/anthropic takes it (`providerOptions.anthropic.cacheControl`,
 * 4.0.x): on the system message it caches the tools and the instructions; on the call it is the API's
 * top-level `cache_control`, which caches up to the last block and moves with the history, step by
 * step. Two of the four breakpoints a request may have.
 */
const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

/**
 * What Anthropic's structured outputs compile in one request, over every strict tool and the
 * response format: past it, a 400 "Schema is too complex for compilation".
 */
const ANTHROPIC_STRICT_LIMITS = { optionalParams: 24, unionParams: 16 };

/**
 * A safety net for current Claude models' preserved thinking: a thinking block is bound to the tools
 * and the history it was made with, and replaying it after either changed is a 400 ("bound to a
 * different conversation"). The runner keeps every task's conversation append-only, so this should
 * never act; if a later change breaks that, the API drops the stale block (the model thinks again,
 * paying the output tokens) rather than failing the run. Sent as `thinking.block_binding` with no
 * `type`, so the model's own thinking default is left alone; @ai-sdk/anthropic adds the
 * `thinking-binding-controls-2026-08-01` beta it needs.
 */
const DROP_STALE_THINKING = { anthropic: { thinking: { blockBinding: { prefixMismatchBehavior: 'drop_block' } } } };

/** The Anthropic API; a repo is read through Shipcast's own tools over the checkout */
export const anthropicAiProvider = aiProvider({
  ...self,
  listed: true,
  capabilities: { streaming: true, tools: true, structuredOutput: 'native', repoAccess: 'local-tools', promptCaching: { system: EPHEMERAL, call: EPHEMERAL }, strictSchemas: ANTHROPIC_STRICT_LIMITS },
  providerOptions: DROP_STALE_THINKING,
  defaultModel: () => DEFAULT_ANTHROPIC_MODEL,
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    const anthropic = createAnthropic({ apiKey: need(self, settings, 'apiKey'), ...(options.fetch && { fetch: options.fetch }) });
    return anthropic(modelId || DEFAULT_ANTHROPIC_MODEL);
  },
});
