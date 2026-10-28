import type { AiTask } from '@shipcast/schema';
import type { AiSetup } from './ai.ts';
import type { PipelineDeps } from './pipeline.ts';

/*
 * LEGACY: the AI layer before the AI task runner, as one entry point (`@shipcast/engine/legacy-ai`):
 * the AiProvider port and its providers (ai.ts), claudio's REST client (claudio.ts), the setup a task
 * reads it through. Every task runs on the AI task runner with the `ai-runner` flag on; with it off,
 * on this. Only the files .dependency-cruiser.cjs lists may import it (`legacy-ai-layer-only-in-legacy-files`), so removing
 * the layer is deleting this file, ai.ts, claudio.ts and testing/ai.ts, and the old branch of each
 * listed file.
 */

export * from './ai.ts';
export * from './claudio.ts';

/** A task's provider, model and prompts: the settings', or the default provider with the prompts in code */
export async function setupFor(deps: Pick<PipelineDeps, 'ai' | 'aiSetup'>, task: AiTask): Promise<AiSetup> {
  if (deps.aiSetup) return deps.aiSetup(task);
  if (!deps.ai) throw new Error(`the ${task} task has neither the AI task runner nor a provider`);
  return { provider: deps.ai, prompts: {} };
}
