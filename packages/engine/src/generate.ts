import { ContentPack, contentPackJsonSchema, missingPieces, type Brand, type LaunchConfig } from '@shipcast/schema';
import type { AiProvider } from './ai.ts';
import { ANALYSIS_TOOLS, buildPrompt, type PromptOptions } from './prompt.ts';
import type { Launch } from './repositories/index.ts';
import type { Checkout } from './workspace.ts';

export type Generated =
  | { ok: true; pack: ContentPack; chatId: string | undefined }
  | { ok: false; problems: string[]; chatId: string | undefined };

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
  const problems: string[] = [];
  if (pack.kind !== launch.kind) problems.push(`kind is "${pack.kind}", the launch is "${launch.kind}"`);
  if (pack.project.repo.replace(/\/+$/, '').toLowerCase() !== `https://github.com/${launch.repo}`.toLowerCase()) {
    problems.push(`project.repo is ${pack.project.repo}, the launch is ${launch.repo}`);
  }
  problems.push(...missingPieces(pack, config, brand));

  return problems.length > 0 ? { ok: false, problems, chatId: result.chatId } : { ok: true, pack, chatId: result.chatId };
}
