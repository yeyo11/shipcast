import { AI_TASK_DEFINITIONS, AiError } from '@shipcast/schema';
import type { AiRunSetup, AiTaskRunner } from './runner.ts';

/*
 * Whether a provider can answer now, for onboarding and the AI settings: its own readiness where it
 * has one (Claudio's /api/ready, which says when Claude is not signed in), else one cheap call
 * through the runner, whose failure is an AiError in the owner's words. Nothing here is the old
 * provider layer's.
 */

export type AiProviderCheck = { ok: true; detail: string } | { ok: false; code: string; problem: string };

const PROMPT = 'Answer with the single word OK.';

export async function checkAiProvider(runner: AiTaskRunner, setup: AiRunSetup, options: { fetch?: typeof fetch } = {}): Promise<AiProviderCheck> {
  const { provider, settings } = setup;
  try {
    if (provider.ready) {
      const readiness = await provider.ready(settings, options);
      return readiness.ready ? { ok: true, detail: `the ${provider.name} is ready` } : { ok: false, code: readiness.reason, problem: readiness.message };
    }
    let answer = '';
    for await (const chunk of runner.stream(AI_TASK_DEFINITIONS.providerCheck, { prompt: PROMPT }, setup).textStream) {
      answer += chunk;
      // A model that ignores "one word" has still answered: enough is read to say so
      if (answer.length > 40) break;
    }
    return { ok: true, detail: `it answered “${answer.trim().slice(0, 40)}”` };
  } catch (error) {
    if (error instanceof AiError) return { ok: false, code: error.code, problem: error.message };
    throw error;
  }
}
