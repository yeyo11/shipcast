import type { z } from 'zod';
import { ContentPack, contentPackJsonSchema } from '../content-pack.ts';
import { CheckAnswer, checkJsonSchema, ProfileReviewAnswer, profileReviewJsonSchema, ReplyAnswer, replyJsonSchema } from './answers.ts';

/*
 * What Shipcast asks an AI for, as data: one definition per task, the answer's schema and the
 * ceilings of one run. The runner (packages/engine/src/ai/runner.ts) runs any of them the same way;
 * the values are today's, taken from where each task sets them, so moving a task onto the runner
 * changes how it is run and not how far it may go.
 */

/** The tasks the AI settings choose a provider and a model for */
export const AI_TASKS = ['pack', 'article', 'assistant', 'replies', 'profile'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export interface AiTaskLimits {
  /** Model calls in one run, tool rounds included; the AI SDK providers' `MAX_STEPS`, or the task's `maxTurns` */
  maxSteps: number;
  /** Per model call */
  maxOutputTokens: number;
  /** The whole run, repair included; Shipcast enforces it whatever the provider */
  timeoutMs: number;
  /** An agent's turns, for a provider that takes a ceiling of its own (claudio's REST API took `maxTurns`) */
  maxTurns?: number;
  /**
   * The spend ceiling in USD, for a provider that takes one: the task's default
   * (DEFAULT_AI_BUDGETS_USD), which the AI settings may override per task. Always set, since a provider left without one applies its own (Claudio: 1 USD, too little
   * for a pack and more than a reply needs).
   */
  maxBudgetUsd: number;
}

export interface AiTaskOutput<T> {
  /** What the answer is validated with: never trusted as the model returns it */
  schema: z.ZodType<T>;
  /** What the model is given: the response format's schema, or the submit tool's input */
  jsonSchema: () => Record<string, unknown>;
  /** A short name for the response format (`content_pack`) */
  name: string;
}

/**
 * Whether the task reads the repository: `always` (the pack, a check against the code), `when-given`
 * (a reply, when its launch's code is checked out) or `never`.
 */
export type RepoNeed = 'always' | 'when-given' | 'never';

export interface AiTaskDefinition<T = unknown> {
  id: string;
  /** The AI settings' task whose provider and model it runs with */
  settingsTask: AiTask;
  /** The structured answer; none for a task that streams text (the writing assistant) */
  output?: AiTaskOutput<T>;
  needsRepo: RepoNeed;
  limits: AiTaskLimits;
}

/**
 * What an agent that reads the repository itself (Claudio's Claude Code, in a workspace) may run
 * there, as Claude Code permission rules: its file tools, and the shell commands that only read.
 * Claudio's guard lets a Bash call through only when every subcommand matches one of them, and the
 * file tools only inside the workspace.
 */
export const ANALYSIS_RULES = [
  'Read',
  'Grep',
  'Glob',
  'Bash(ls *)',
  'Bash(find *)',
  'Bash(cat *)',
  'Bash(head *)',
  'Bash(tail *)',
  'Bash(sed -n *)',
  'Bash(grep *)',
  'Bash(wc *)',
  'Bash(cut *)',
] as const;

/** The AI SDK providers' tool rounds before they must answer (packages/engine/src/ai.ts, MAX_STEPS) */
const SDK_MAX_STEPS = 40;
/** Room for a whole content pack, every language and channel, in one answer (ai.ts, MAX_OUTPUT_TOKENS) */
const MAX_OUTPUT_TOKENS = 32_000;
/** How long claudio let a generation run before stopping it (claudio.ts, `timeoutMs`) */
const TIMEOUT_MS = 30 * 60_000;

/**
 * The tasks whose spend ceiling the owner may set in the AI settings: every task definition's id but
 * the provider check, whose ceiling only has to be next to nothing. The writing assistant and its
 * check against the code share the `assistant` settings task, but not its budget: a check reads the
 * repository, a suggestion does not.
 */
export const AI_BUDGET_TASKS = ['pack', 'article', 'assistant', 'assistant-check', 'replies', 'profile'] as const;
export type AiBudgetTask = (typeof AI_BUDGET_TASKS)[number];

/** Each task's spend ceiling in USD until the AI settings override it: the one place they are set */
export const DEFAULT_AI_BUDGETS_USD: Readonly<Record<AiBudgetTask, number>> = {
  pack: 5,
  article: 3,
  'assistant-check': 2,
  assistant: 1,
  replies: 1,
  profile: 0.5,
};

/** The highest ceiling the AI settings accept for one run, so a typo cannot open the meter */
export const MAX_AI_BUDGET_USD = 50;

const task = <T>(definition: AiTaskDefinition<T>): AiTaskDefinition<T> => definition;

export const AI_TASK_DEFINITIONS = {
  /** A release's content pack, from its code (generate.ts): no turn ceiling but the SDK's */
  pack: task({
    id: 'pack',
    settingsTask: 'pack',
    output: { schema: ContentPack, jsonSchema: contentPackJsonSchema, name: 'content_pack' },
    needsRepo: 'always',
    limits: { maxSteps: SDK_MAX_STEPS, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, maxBudgetUsd: DEFAULT_AI_BUDGETS_USD.pack },
  }),
  /** An article's translation and pieces (article.ts): the owner's text is the truth, no repo */
  article: task({
    id: 'article',
    settingsTask: 'article',
    output: { schema: ContentPack, jsonSchema: contentPackJsonSchema, name: 'content_pack' },
    needsRepo: 'never',
    limits: { maxSteps: SDK_MAX_STEPS, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, maxBudgetUsd: DEFAULT_AI_BUDGETS_USD.article },
  }),
  /** A turn of the writing assistant, streamed (assistant.ts): text, no repo, no output ceiling set today */
  assistant: task<string>({
    id: 'assistant',
    settingsTask: 'assistant',
    needsRepo: 'never',
    limits: { maxSteps: 1, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, maxBudgetUsd: DEFAULT_AI_BUDGETS_USD.assistant },
  }),
  /** A launch's text checked against its code (assistant.ts, checkAgainstCode: maxTurns 30) */
  assistantCheck: task({
    id: 'assistant-check',
    settingsTask: 'assistant',
    output: { schema: CheckAnswer, jsonSchema: checkJsonSchema, name: 'check' },
    needsRepo: 'always',
    limits: { maxSteps: 30, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, maxTurns: 30, maxBudgetUsd: DEFAULT_AI_BUDGETS_USD['assistant-check'] },
  }),
  /** A reply to a comment (comments.ts: maxTurns 20), grounded in the code when it is checked out */
  replies: task({
    id: 'replies',
    settingsTask: 'replies',
    output: { schema: ReplyAnswer, jsonSchema: replyJsonSchema, name: 'reply' },
    needsRepo: 'when-given',
    limits: { maxSteps: 20, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, maxTurns: 20, maxBudgetUsd: DEFAULT_AI_BUDGETS_USD.replies },
  }),
  /** A review of an account's profile (profile.ts: maxTurns 5) */
  profile: task({
    id: 'profile',
    settingsTask: 'profile',
    output: { schema: ProfileReviewAnswer, jsonSchema: profileReviewJsonSchema, name: 'profile_review' },
    needsRepo: 'never',
    limits: { maxSteps: 5, maxOutputTokens: MAX_OUTPUT_TOKENS, timeoutMs: TIMEOUT_MS, maxTurns: 5, maxBudgetUsd: DEFAULT_AI_BUDGETS_USD.profile },
  }),
  /**
   * Whether a provider answers at all, for onboarding and the AI settings (a provider without a
   * readiness of its own): one word, spending next to nothing, run with the provider being tested
   * rather than the settings' choice. The onboarding's old test gave it 30 s.
   */
  providerCheck: task<string>({
    id: 'provider-check',
    settingsTask: 'assistant',
    needsRepo: 'never',
    limits: { maxSteps: 1, maxOutputTokens: 16, timeoutMs: 30_000, maxTurns: 1, maxBudgetUsd: 0.05 },
  }),
} as const;
