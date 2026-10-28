import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseLaunchConfig, type AiTask, type Brand } from '@shipcast/schema';
import type { AiProvider, AiSetup, ObjectRequest, ObjectResult } from './ai.ts';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { FAKE_NOTICE, fakePack } from './fake-ai.ts';
import type { PipelineDeps } from './pipeline.ts';
import type { Launch } from './repositories/index.ts';

/*
 * LEGACY: the AI layer before the AI task runner, as one entry point (`@shipcast/engine/legacy-ai`):
 * the AiProvider port and its providers (ai.ts), claudio's REST client (claudio.ts), the setup a task
 * reads it through, and the fake provider of Action mode and the tests. Every task runs on the AI
 * task runner with the `ai-runner` flag on; with it off, on this. Only the files
 * .dependency-cruiser.cjs lists may import it (`legacy-ai-layer-only-in-legacy-files`), so removing
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

/**
 * The fake provider for one launch: it reads launch.yml from the checkout it is handed, as the real
 * providers read the repo, and answers with `fakePack`. It streams nothing.
 */
export function fakePackProvider(launch: Launch, brand: Brand): AiProvider {
  return {
    id: 'test',
    async generateObject(request: ObjectRequest): Promise<ObjectResult> {
      if (!request.hostDir) throw new Error('the fake AI provider only writes launch packs, from a checkout');
      const parsed = parseLaunchConfig(await readFile(join(request.hostDir, LAUNCH_CONFIG_PATH), 'utf8'));
      if (!parsed.ok) throw new Error(`the fake AI provider could not read ${LAUNCH_CONFIG_PATH}`);
      return { output: fakePack(launch, parsed.value, brand), costUsd: 0 };
    },
    async *streamText(): AsyncIterable<string> {
      yield FAKE_NOTICE;
    },
  };
}
