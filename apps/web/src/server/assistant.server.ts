import { launchGrounding, setupFor } from '@shipcast/engine';
import type { AssistantDeps } from './assistant.ts';
import { appContext } from './context.server';

/** The assistant's dependencies in this process: the AI settings' `assistant` task, the brand, the launches repo */
export async function assistantDeps(): Promise<AssistantDeps> {
  const ctx = await appContext();
  return {
    setup: () => setupFor(ctx.deps, 'assistant'),
    brand: () => ctx.brand(),
    launch: async (launchId) => (await ctx.registry.launches.get(launchId)) ?? undefined,
    grounding: (launch) => launchGrounding(launch, { github: ctx.github, launchesRepo: ctx.settings.launchesRepo() }),
    checkout: (repo, ref) => ctx.deps.checkout(repo, ref),
    sessions: ctx.registry,
    aiWorkdir: ctx.deps.aiWorkdir ?? ctx.config.workspaceProviderDir,
    ...(ctx.deps.maxBudgetUsd !== undefined && { maxBudgetUsd: ctx.deps.maxBudgetUsd }),
  };
}
