import { AiTaskRunner, anthropicAiProvider, fakePackAiProvider, openaiAiProvider, openaiCompatibleAiProvider, type AiRunSetup, type Launch } from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import type { CiAi } from './config.ts';

/*
 * Action mode's AI, on the AI task runner: what aiRunnerFor composes from the AI settings and the
 * keychain, composed here from the environment alone (docs/decisions/action-mode.md). The provider
 * modules and their settings' shape are the server's own; only where the values come from differs.
 * No provider here is a remote agent (claudio is never Action mode's), so every one reads the job's
 * clone with the runner's tools and the runner needs no archive source.
 */

/** What a draft fails with when it asks an AI that is not there: a dry run's, or a publish's pipeline */
export const CI_NO_AI = 'no AI provider is configured (SHIPCAST_AI_PROVIDER, anthropic or openai, with ANTHROPIC_API_KEY or OPENAI_API_KEY)';

/**
 * Every task's provider, settings and model, from the variables loadCiConfig read. The fake provider
 * is built for the launch being drafted, whose pack it names; without one it is as absent as no AI.
 * Throws CI_NO_AI then, when the task runs: building the runner never fails, so a dry run has one.
 */
export function ciAiRunSetup(ai: CiAi | undefined, launch?: { launch: Launch; brand: Brand }): AiRunSetup {
  const model = (id: string | undefined) => (id ? { model: id } : {});
  switch (ai?.kind) {
    case 'anthropic':
      return { provider: anthropicAiProvider, settings: { apiKey: ai.apiKey }, ...model(ai.model) };
    case 'openai':
      return { provider: openaiAiProvider, settings: { apiKey: ai.apiKey }, ...model(ai.model) };
    case 'openaiCompatible':
      return { provider: openaiCompatibleAiProvider, settings: { baseUrl: ai.baseUrl, model: ai.model, apiKey: ai.apiKey }, ...model(ai.model) };
    case 'fake':
      if (launch) return { provider: fakePackAiProvider(launch.launch, launch.brand), settings: {} };
      break;
    case undefined:
      break;
  }
  throw new Error(CI_NO_AI);
}

/** The runner a `ci` pipeline drafts with: one per pipeline, as the fake provider is one per launch */
export function ciAiRunner(ai: CiAi | undefined, launch?: { launch: Launch; brand: Brand }): AiTaskRunner {
  return new AiTaskRunner({ resolve: async () => ciAiRunSetup(ai, launch) });
}
