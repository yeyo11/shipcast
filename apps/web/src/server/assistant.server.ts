import { launchGrounding, setupFor } from '@shipcast/engine';
import { startAssistantCheck } from '@shipcast/runtime';
import type { AssistantDeps } from './assistant.ts';
import { appContext } from './context.server';

/** The assistant's dependencies in this process: the AI settings' `assistant` task, the brand, the launches repo */
export async function assistantDeps(): Promise<AssistantDeps> {
  const ctx = await appContext();
  return {
    // With `ai-runner` the answers stream from the runner, with the owner's texts; else from the old provider
    ...(ctx.deps.aiRunner ? { aiRunner: ctx.deps.aiRunner, texts: ctx.deps.aiTexts ?? (async () => ({})) } : { setup: () => setupFor(ctx.deps, 'assistant') }),
    brand: () => ctx.brand(),
    launch: async (launchId) => (await ctx.registry.launches.get(launchId)) ?? undefined,
    grounding: (launch) => launchGrounding(launch, { github: ctx.github, launchesRepo: ctx.settings.launchesRepo() }),
    checkout: (repo, ref) => ctx.deps.checkout(repo, ref),
    sessions: ctx.registry.assistant,
    // With `ai-runner` the check is a heavy job the page follows, never work inside this request
    ...(ctx.deps.aiRunner && { startCheck: (launch, request) => startAssistantCheck(ctx.queue, launch, request) }),
    aiWorkdir: ctx.deps.aiWorkdir ?? ctx.config.workspaceProviderDir,
    ...(ctx.deps.maxBudgetUsd !== undefined && { maxBudgetUsd: ctx.deps.maxBudgetUsd }),
  };
}
