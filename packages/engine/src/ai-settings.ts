import { contentPackJsonSchema, formatIssues, InvalidRequest, parseLaunchConfig, ShipcastError, type Brand, type LaunchConfig } from '@shipcast/schema';
import { z } from 'zod';
import { AI_PROVIDERS, AI_TASKS, type AiTask } from './ai.ts';
import { articleConfig } from './article.ts';
import { LOCKED_ASSISTANT_ARTICLE_RULES, LOCKED_ASSISTANT_LAUNCH_RULES } from './assistant.ts';
import { LAUNCH_CONFIG_PATH } from './detect.ts';
import { launchDir } from './drafts.ts';
import type { GitHubSource } from './github.ts';
import {
  buildArticlePrompt,
  buildPrompt,
  DEFAULT_PROMPTS,
  isPromptId,
  LOCKED_ARTICLE_RULES,
  LOCKED_LAUNCH_RULES,
  LOCKED_PROFILE_RULES,
  LOCKED_REPLY_RULES,
  PROMPT_IDS,
  templateProblems,
  type Prompt,
  type PromptId,
  type PromptTexts,
} from './prompt.ts';
import type { Launch, Repositories } from './repositories/index.ts';

/*
 * The AI settings live in the registry's `settings` table, as JSON under two keys: which provider and
 * model each task runs with (and the brand's tone override), and the history of every edited prompt.
 * See docs/decisions/ai-providers.md.
 */

export const AI_SETTINGS_KEY = 'ai';
export const PROMPTS_KEY = 'prompts';
/** Versions kept per prompt; the oldest go first */
export const MAX_PROMPT_VERSIONS = 50;

const TaskChoice = z.strictObject({
  provider: z.enum(AI_PROVIDERS),
  /** Empty means the provider's own default */
  model: z.string().trim().max(200).optional(),
});
export type TaskChoice = z.infer<typeof TaskChoice>;

const AiSettings = z.strictObject({
  tasks: z.strictObject({ pack: TaskChoice, article: TaskChoice, assistant: TaskChoice, replies: TaskChoice, profile: TaskChoice }),
  /** Replaces brand.yml's tone in every prompt when set */
  tone: z.string().trim().max(2000).optional(),
});
export type AiSettings = z.infer<typeof AiSettings>;

// A client written before a task existed saves without it; that task keeps what it had
const AiSettingsInput = AiSettings.extend({
  tasks: z.strictObject({ pack: TaskChoice, article: TaskChoice, assistant: TaskChoice, replies: TaskChoice.optional(), profile: TaskChoice.optional() }),
});

/** claudio for everything, as before the settings existed */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  tasks: { pack: { provider: 'claudio' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' }, replies: { provider: 'claudio' }, profile: { provider: 'claudio' } },
};

export class InvalidAiSettings extends InvalidRequest {}

function clean(settings: AiSettings): AiSettings {
  const tasks = Object.fromEntries(
    AI_TASKS.map((task) => {
      const choice = settings.tasks[task];
      return [task, choice.model ? choice : { provider: choice.provider }];
    }),
  ) as AiSettings['tasks'];
  return settings.tone ? { tasks, tone: settings.tone } : { tasks };
}

/** The settings as stored, each task falling back on claudio; a stored value that no longer parses is ignored */
export async function readAiSettings(registry: Pick<Repositories, 'settings'>): Promise<AiSettings> {
  const stored = await registry.settings.setting<unknown>(AI_SETTINGS_KEY);
  const tasks = { ...DEFAULT_AI_SETTINGS.tasks };
  let tone: string | undefined;
  if (stored && typeof stored === 'object') {
    const value = stored as { tasks?: Record<string, unknown>; tone?: unknown };
    for (const task of AI_TASKS) {
      const parsed = TaskChoice.safeParse(value.tasks?.[task]);
      if (parsed.success) tasks[task] = parsed.data;
    }
    if (typeof value.tone === 'string' && value.tone.trim()) tone = value.tone.trim();
  }
  return clean({ tasks, tone });
}

export async function writeAiSettings(registry: Pick<Repositories, 'settings'>, input: unknown): Promise<AiSettings> {
  const parsed = AiSettingsInput.safeParse(input);
  if (!parsed.success) throw new InvalidAiSettings(parsed.error.issues.map((i) => `${i.path.join('.') || 'settings'}: ${i.message}`).join('; '));
  const stored = await readAiSettings(registry);
  const replies = parsed.data.tasks.replies ?? stored.tasks.replies;
  const profile = parsed.data.tasks.profile ?? stored.tasks.profile;
  const settings = clean({ ...parsed.data, tasks: { ...parsed.data.tasks, replies, profile } });
  await registry.settings.setSetting(AI_SETTINGS_KEY, settings);
  return settings;
}

export interface PromptVersion {
  text: string;
  savedAt: string;
}

/** Every edited prompt's versions, oldest first; the last one is in use */
export type PromptHistory = Partial<Record<PromptId, PromptVersion[]>>;

/** The parts of the prompt that are never editable, shown read-only beside the editable ones */
export function lockedPrompts(): {
  launchRules: readonly string[];
  articleRules: readonly string[];
  replyRules: readonly string[];
  profileRules: readonly string[];
  assistantLaunchRules: readonly string[];
  assistantArticleRules: readonly string[];
  packSchema: Record<string, unknown>;
} {
  return {
    launchRules: LOCKED_LAUNCH_RULES,
    articleRules: LOCKED_ARTICLE_RULES,
    replyRules: LOCKED_REPLY_RULES,
    profileRules: LOCKED_PROFILE_RULES,
    assistantLaunchRules: LOCKED_ASSISTANT_LAUNCH_RULES,
    assistantArticleRules: LOCKED_ASSISTANT_ARTICLE_RULES,
    packSchema: contentPackJsonSchema(),
  };
}

/** A prompt the owner may not change here: a state, not a bad request (409) */
export class LockedPrompt extends ShipcastError {
  constructor(message: string) {
    super(message, { code: 'refused', httpStatus: 409 });
  }
}
export class InvalidPrompt extends InvalidRequest {}

export async function promptHistory(registry: Pick<Repositories, 'settings'>): Promise<PromptHistory> {
  const stored = (await registry.settings.setting<Record<string, PromptVersion[]>>(PROMPTS_KEY)) ?? {};
  const history: PromptHistory = {};
  // Only known ids are read back: a prompt the code dropped, or anything else in the row, never reaches a prompt
  for (const id of PROMPT_IDS) {
    const versions = stored[id];
    if (Array.isArray(versions) && versions.length > 0) history[id] = versions.filter((v) => typeof v?.text === 'string' && typeof v.savedAt === 'string');
  }
  return history;
}

/** The prompts in use: the latest version of each edited one; the rest are their defaults */
export async function currentPrompts(registry: Pick<Repositories, 'settings'>): Promise<PromptTexts> {
  const texts: PromptTexts = {};
  for (const [id, versions] of Object.entries(await promptHistory(registry)) as Array<[PromptId, PromptVersion[]]>) {
    const last = versions.at(-1);
    if (last) texts[id] = last.text;
  }
  return texts;
}

function checkId(id: string): PromptId {
  if (/^(rules|schema|system)\b/.test(id)) throw new LockedPrompt(`${id} is locked: the rules that keep the text true to the code, and the pack's schema, cannot be edited`);
  if (!isPromptId(id)) throw new InvalidPrompt(`there is no prompt "${id}"`);
  return id;
}

/**
 * Saves a new version of an editable prompt; the previous ones are kept. The same text as the one in
 * use saves nothing. Locked parts have no id here, so they cannot be overwritten through this.
 */
export async function savePrompt(registry: Pick<Repositories, 'settings'>, id: string, text: string, now = new Date()): Promise<PromptVersion[]> {
  const promptId = checkId(id);
  const problems = templateProblems(text);
  if (problems.length > 0) throw new InvalidPrompt(problems.join('; '));
  const stored = (await registry.settings.setting<Record<string, PromptVersion[]>>(PROMPTS_KEY)) ?? {};
  const versions = Array.isArray(stored[promptId]) ? [...stored[promptId]] : [];
  const current = versions.at(-1)?.text ?? DEFAULT_PROMPTS[promptId];
  if (text === current) return versions;
  // The default is the first version, so restoring it is always possible from the list
  if (versions.length === 0) versions.push({ text: DEFAULT_PROMPTS[promptId], savedAt: 'default' });
  versions.push({ text, savedAt: now.toISOString() });
  const kept = versions.slice(-MAX_PROMPT_VERSIONS);
  await registry.settings.setSetting(PROMPTS_KEY, { ...stored, [promptId]: kept });
  return kept;
}

/** Puts an earlier version (or the default) back in use, as a new version: the history only grows */
export async function restorePrompt(registry: Pick<Repositories, 'settings'>, id: string, savedAt: string, now = new Date()): Promise<PromptVersion[]> {
  const promptId = checkId(id);
  if (savedAt === 'default') return savePrompt(registry, promptId, DEFAULT_PROMPTS[promptId], now);
  const versions = (await promptHistory(registry))[promptId] ?? [];
  const version = versions.find((v) => v.savedAt === savedAt);
  if (!version) throw new InvalidPrompt(`${promptId} has no version saved at ${savedAt}`);
  return savePrompt(registry, promptId, version.text, now);
}

/**
 * The final prompt a past launch would get today, with the prompts and tone given: rendered only,
 * no AI call. A release reads its launch.yml at the ref; an article, the one its drafts committed,
 * with a stand-in for the owner's text, which only the launches repo holds.
 */
export async function previewPrompt(
  launch: Launch,
  brand: Brand,
  deps: { github: GitHubSource; launchesRepo: string },
  options: { prompts: PromptTexts; tone?: string },
): Promise<Prompt & { task: AiTask }> {
  if (launch.trigger === 'article') {
    const text = await deps.github.fileAt(deps.launchesRepo, `${launchDir(launch)}/launch.yml`, 'HEAD').catch(() => undefined);
    const parsed = text === undefined ? undefined : parseLaunchConfig(text);
    const config: LaunchConfig = parsed?.ok ? parsed.value : articleConfig(brand, []);
    const title = launch.ref.replace(/^article:/, '').replace(/-/g, ' ');
    const input = { title, markdown: '(the article as you wrote it)', lang: brand.languages.blog[0] ?? 'en' };
    return { task: 'article', ...buildArticlePrompt(input, brand, config, deps.launchesRepo, options) };
  }
  const ref = launch.ref.startsWith('public:') ? 'HEAD' : launch.ref;
  const text = await deps.github.fileAt(launch.repo, LAUNCH_CONFIG_PATH, ref);
  if (text === undefined) throw new InvalidPrompt(`${launch.repo} has no ${LAUNCH_CONFIG_PATH} at ${ref}`);
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) throw new InvalidPrompt(formatIssues(LAUNCH_CONFIG_PATH, parsed.issues));
  return { task: 'pack', ...buildPrompt(launch, parsed.value, brand, options) };
}
