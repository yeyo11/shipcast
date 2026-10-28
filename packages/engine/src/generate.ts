import { AI_TASK_DEFINITIONS, ContentPack, contentPackJsonSchema, missingPieces, type Brand, type LaunchConfig } from '@shipcast/schema';
import type { AiProvider } from './ai.ts';
import { chatIdOf, costOf, type AiTaskRunner } from './ai/runner.ts';
import { ANALYSIS_TOOLS, buildPrompt, type PromptOptions } from './prompt.ts';
import type { Launch } from './repositories/index.ts';
import type { Checkout } from './workspace.ts';

export type Generated =
  | { ok: true; pack: ContentPack; chatId: string | undefined; costUsd?: number | null }
  | { ok: false; problems: string[]; chatId: string | undefined; costUsd?: number | null };

export interface GenerateOptions extends PromptOptions {
  ai: AiProvider;
  /** The model the settings chose for this task; the provider's default without one */
  model?: string;
  launch: Launch;
  config: LaunchConfig;
  brand: Brand;
  checkout: Checkout;
  /** Spend ceiling for one generation */
  maxBudgetUsd?: number;
}

/**
 * Asks the AI for the launch's content pack and accepts it only when it is valid, matches the launch
 * and covers every channel the launch turns on. What the model returns is never trusted as is: a
 * pack that fails here never reaches the drafts pull request.
 */
export async function generatePack(options: GenerateOptions): Promise<Generated> {
  const { ai, launch, config, brand, checkout } = options;
  const { prompt, system } = buildPrompt(launch, config, brand, { prompts: options.prompts, tone: options.tone });

  let result;
  try {
    result = await ai.generateObject({
      prompt,
      appendSystemPrompt: system,
      cwd: checkout.providerPath,
      hostDir: checkout.hostPath,
      jsonSchema: contentPackJsonSchema(),
      allowedTools: ANALYSIS_TOOLS,
      model: options.model,
      maxBudgetUsd: options.maxBudgetUsd,
    });
  } catch (error) {
    const chatId = error instanceof Error && 'chatId' in error ? (error.chatId as string | undefined) : undefined;
    return { ok: false, problems: [error instanceof Error ? error.message : String(error)], chatId };
  }

  const parsed = ContentPack.safeParse(result.output);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'pack'}: ${i.message}`),
      chatId: result.chatId,
    };
  }

  const pack = parsed.data;
  const problems = packProblems(pack, launch, config, brand);
  return problems.length > 0 ? { ok: false, problems, chatId: result.chatId, costUsd: result.costUsd } : { ok: true, pack, chatId: result.chatId, costUsd: result.costUsd };
}

/** What keeps a valid pack from being this launch's: another kind or repo, or a channel it turns on left without its piece */
function packProblems(pack: ContentPack, launch: Launch, config: LaunchConfig, brand: Brand): string[] {
  const problems: string[] = [];
  if (pack.kind !== launch.kind) problems.push(`kind is "${pack.kind}", the launch is "${launch.kind}"`);
  if (pack.project.repo.replace(/\/+$/, '').toLowerCase() !== `https://github.com/${launch.repo}`.toLowerCase()) {
    problems.push(`project.repo is ${pack.project.repo}, the launch is ${launch.repo}`);
  }
  problems.push(...missingPieces(pack, config, brand));
  return problems;
}

export interface RunnerGenerateOptions extends PromptOptions {
  runner: AiTaskRunner;
  launch: Launch;
  config: LaunchConfig;
  brand: Brand;
  /** The job's clone: what a provider with local tools reads */
  checkout: Checkout;
  /** The ref the code is read at (a release's tag, or HEAD for a repo made public): what a remote workspace is made from */
  ref: string;
  /** The settings' spend ceiling, over the task's own */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

/**
 * The content pack through the AI task runner (`ai-runner`): the same prompt, the pack task's
 * schema and ceilings, the repo read by the provider's own means (the runner's tools over the clone,
 * or a remote agent's workspace). The runner validates the answer against the pack's schema and
 * repairs it once; what is checked here is what only this launch can say.
 */
export async function generatePackOnRunner(options: RunnerGenerateOptions): Promise<Generated> {
  const { runner, launch, config, brand, checkout } = options;
  const { prompt, system } = buildPrompt(launch, config, brand, { prompts: options.prompts, tone: options.tone });
  let result;
  try {
    result = await runner.run(AI_TASK_DEFINITIONS.pack, {
      system,
      prompt,
      repo: { name: launch.repo, ref: options.ref, hostDir: checkout.hostPath },
      ...(options.maxBudgetUsd !== undefined && { limits: { maxBudgetUsd: options.maxBudgetUsd } }),
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
