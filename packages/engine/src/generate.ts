import { AI_TASK_DEFINITIONS, missingPieces, type Brand, type ContentPack, type LaunchConfig } from '@shipcast/schema';
import { chatIdOf, costOf, type AiTaskRunner } from './ai/runner.ts';
import { buildPrompt, type PromptOptions } from './prompt.ts';
import type { Launch } from './repositories/index.ts';
import type { Checkout } from './workspace.ts';

export type Generated =
  | { ok: true; pack: ContentPack; chatId: string | undefined; costUsd?: number | null }
  | { ok: false; problems: string[]; chatId: string | undefined; costUsd?: number | null };

/** What keeps a valid pack from being this launch's: another kind or repo, or a channel it turns on left without its piece */
function packProblems(pack: ContentPack, launch: Launch, config: LaunchConfig, brand: Brand): string[] {
  const problems: string[] = [];
  if (pack.kind !== launch.kind) problems.push(`kind is "${pack.kind}", the launch is "${launch.kind}"`);
  // A release's launch is about its repo, the primary one: further repos never stand in for it
  if (!pack.project.repo) problems.push(`project.repo is missing, the launch is ${launch.repo}`);
  else if (pack.project.repo.replace(/\/+$/, '').toLowerCase() !== `https://github.com/${launch.repo}`.toLowerCase()) {
    problems.push(`project.repo is ${pack.project.repo}, the launch is ${launch.repo}`);
  }
  problems.push(...missingPieces(pack, config, brand));
  return problems;
}

export interface GenerateOptions extends PromptOptions {
  runner: AiTaskRunner;
  launch: Launch;
  config: LaunchConfig;
  brand: Brand;
  /** The job's clone: what a provider with local tools reads */
  checkout: Checkout;
  /** The ref the code is read at (a release's tag, or HEAD for a repo made public): what a remote workspace is made from */
  ref: string;
  signal?: AbortSignal;
}

/**
 * Asks the AI task runner for the launch's content pack and accepts it only when it is valid, matches
 * the launch and covers every channel the launch turns on: the pack task's schema and ceilings, the
 * repo read by the provider's own means (the runner's tools over the clone, or a remote agent's
 * workspace). The runner validates the answer against the pack's schema and repairs it once; what is
 * checked here is what only this launch can say, so a pack that fails never reaches the drafts pull request.
 */
export async function generatePack(options: GenerateOptions): Promise<Generated> {
  const { runner, launch, config, brand, checkout } = options;
  const { prompt, system } = buildPrompt(launch, config, brand, { prompts: options.prompts, tone: options.tone });
  let result;
  try {
    result = await runner.run(AI_TASK_DEFINITIONS.pack, {
      system,
      prompt,
      repo: { name: launch.repo, ref: options.ref, hostDir: checkout.hostPath },
      ...(options.signal && { abortSignal: options.signal }),
    });
  } catch (error) {
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)], chatId: chatIdOf(error) };
  }
  const chatId = chatIdOf(result);
  const costUsd = costOf(result);
  const problems = packProblems(result.output, launch, config, brand);
  return problems.length > 0 ? { ok: false, problems, chatId, costUsd } : { ok: true, pack: result.output, chatId, costUsd };
}
