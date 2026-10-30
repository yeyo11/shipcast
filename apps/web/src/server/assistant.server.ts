import { launchGrounding } from '@shipcast/engine';
import { startAssistantCheck } from '@shipcast/runtime';
import type { AssistantDeps } from './assistant.ts';
import { appContext } from './context.server';

/** The assistant's dependencies in this process: the AI settings' `assistant` task, the brand, the launches repo */
export async function assistantDeps(): Promise<AssistantDeps> {
  const ctx = await appContext();
  return {
    // The answers stream from the runner, with the owner's texts
    aiRunner: ctx.deps.aiRunner,
    texts: ctx.deps.aiTexts ?? (async () => ({})),
    brand: () => ctx.brand(),
    launch: async (launchId) => (await ctx.registry.launches.get(launchId)) ?? undefined,
    grounding: (launch) => launchGrounding(launch, { github: ctx.github, launchesRepo: ctx.settings.launchesRepo(), stored: ctx.deps.launchRead }),
    sessions: ctx.registry.assistant,
    // The check is a heavy job the page follows, never work inside this request
    startCheck: (launch, request) => startAssistantCheck(ctx.queue, launch, request),
  };
}
