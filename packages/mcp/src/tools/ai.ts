import { AI_BUDGET_TASKS, AI_TASKS, MAX_AI_BUDGET_USD } from '@shipcast/schema';
import { z } from 'zod';
import { HINTS, launchId, tool, type ShipcastTool, type ToolHints } from './shared.ts';

/* The AI settings: the provider and model of each task, its budget, and the prompts with their history */

export const guide =
  'AI settings: get_ai_settings shows each AI task\'s provider, model and spend ceiling (USD per run) and whether each provider\'s credential is set; set_ai_settings and use_ai_provider_for_all change them, test_ai_provider checks a provider works. get_ai_prompts, save_ai_prompt and restore_ai_prompt read and edit the prompts, and preview_ai_prompt renders what a past launch would get, without an AI call. A change to a provider, a model or a prompt changes the content of every launch from the next run: confirm it with the user. Keys and tokens are set in the app only.';

const FUTURE = 'It changes the content of every launch generated from the next run on, not the drafts already written: confirm the change with the user.';

const provider = z.string().min(1).max(50).describe('A provider id, as get_ai_settings lists them in `providers`');
const promptId = z.string().min(1).max(100).describe('A prompt id, as get_ai_prompts lists them, such as pack.launch, channel.bluesky or reply');

// Strict: a key or token slipped beside the provider is refused here rather than dropped unseen
const taskChoice = z.strictObject({
  provider,
  model: z.string().max(200).optional().describe('The provider\'s model id; left out, the provider\'s default'),
});

/** Checks a provider: no state changes, but its one cheap call reaches the provider and may cost a little */
const CHECKS: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const tools: ShipcastTool[] = [
  tool({
    name: 'get_ai_settings',
    title: 'Get the AI settings',
    description:
      'The AI settings: which provider and model each AI task uses (pack: a release\'s content; article; assistant: the in-app writing assistant; replies: drafted comment replies; profile: profile reviews), the tone that replaces brand.yml\'s, and each task\'s spend ceiling in USD per run (the overridden ones in settings.budgets, the defaults and the maximum in budgets). Also lists the providers and whether each one\'s credential is set, never the credential itself. Only reads.',
    operations: ['getAiSettings'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/ai/settings'),
  }),
  tool({
    name: 'set_ai_settings',
    title: 'Set the AI settings',
    description:
      `Replace the AI settings as a whole: start from the \`settings\` get_ai_settings returns and change only what the user asked. Every task gets a provider and optionally a model. \`tone\` replaces brand.yml's tone in every prompt (null: brand.yml's). \`budgets\` are spend ceilings in USD per run of a task, at most ${MAX_AI_BUDGET_USD}; a task left out of them runs with its default, so send back every override you want kept. A provider without its credential set makes that task fail. ${FUTURE} No key or token is accepted: credentials are connected in the app.`,
    operations: ['setAiSettings'],
    input: z.object({
      tasks: z.record(z.enum(AI_TASKS), taskChoice).describe(`The provider and model of every task: ${AI_TASKS.join(', ')}`),
      tone: z.string().max(2000).nullable().describe('How to write, replacing brand.yml\'s tone; null to use brand.yml\'s'),
      budgets: z
        .partialRecord(z.enum(AI_BUDGET_TASKS), z.number().positive().max(MAX_AI_BUDGET_USD))
        .describe(`USD per run, by task (${AI_BUDGET_TASKS.join(', ')}); a task left out runs with its default; {} for every default`),
    }),
    hints: HINTS.setting,
    run: (api, args) => api.call('PUT', '/ai/settings', { body: { tasks: args.tasks, ...(args.tone !== null && args.tone.trim() !== '' && { tone: args.tone }), budgets: args.budgets } }),
  }),
  tool({
    name: 'use_ai_provider_for_all',
    title: 'Use one AI provider for every task',
    description: `Switch every AI task to one provider: a task already on it keeps its model, the others take the provider's default model; the tone and the budgets stay. Check it first with test_ai_provider. ${FUTURE}`,
    operations: ['useAiProviderForAll'],
    input: z.object({ provider }),
    hints: HINTS.setting,
    run: (api, args) => api.call('POST', `/ai/providers/${encodeURIComponent(args.provider)}/use-for-all`),
  }),
  tool({
    name: 'test_ai_provider',
    title: 'Test an AI provider',
    description:
      'Check that a provider works with the credential set in the app: its readiness check where it has one (claudio\'s proves its address, its token and the Claude sign-in), otherwise one cheap model call, which may cost a fraction of a cent. Answers ok with a detail, or the problem in the provider\'s words. Changes no setting.',
    operations: ['testAiProvider'],
    input: z.object({ provider }),
    hints: CHECKS,
    run: (api, args) => api.call('POST', `/ai/providers/${encodeURIComponent(args.provider)}/test`),
  }),
  tool({
    name: 'get_ai_prompts',
    title: 'Get the AI prompts',
    description:
      'The editable prompts (the brief of each kind of pack, each channel\'s brief, the article\'s, the reply\'s, the profile review\'s): each with its default and its saved versions, oldest first, the last one in use (a prompt never edited has none). Also the {{variables}} a prompt may use, and the locked rules appended after every prompt, which cannot be edited. Only reads.',
    operations: ['listAiPrompts'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/ai/prompts'),
  }),
  tool({
    name: 'save_ai_prompt',
    title: 'Save an AI prompt',
    description: `Save a new text for one editable prompt, kept as its newest version; the earlier ones stay and restore_ai_prompt brings them back. Only the {{variables}} get_ai_prompts lists are allowed; the locked rules are not editable. The same text as the one in use saves nothing. ${FUTURE} Check the result with preview_ai_prompt.`,
    operations: ['saveAiPrompt'],
    input: z.object({ prompt_id: promptId, text: z.string().min(1).max(20_000).describe('The whole prompt, as a template') }),
    hints: HINTS.setting,
    run: (api, args) => api.call('PUT', `/ai/prompts/${encodeURIComponent(args.prompt_id)}`, { body: { text: args.text } }),
  }),
  tool({
    name: 'restore_ai_prompt',
    title: 'Restore an AI prompt',
    description: `Put an earlier version of a prompt back in use, saved as its newest version (the history only grows): the version's saved_at from get_ai_prompts, or "default" for the text Shipcast ships. ${FUTURE}`,
    operations: ['restoreAiPrompt'],
    input: z.object({ prompt_id: promptId, saved_at: z.string().min(1).max(100).describe('The version\'s savedAt from get_ai_prompts, or "default"') }),
    hints: HINTS.setting,
    run: (api, args) => api.call('POST', `/ai/prompts/${encodeURIComponent(args.prompt_id)}/restore`, { body: { savedAt: args.saved_at } }),
  }),
  tool({
    name: 'preview_ai_prompt',
    title: 'Preview a launch\'s AI prompt',
    description:
      'The final prompt and system prompt a past launch would get today with the saved prompts and tone, and the task it runs: rendered only, with no AI call and nothing spent. A release reads its launch.yml at its ref on GitHub. Use it to see what a prompt edit changes.',
    operations: ['previewAiPrompt'],
    input: z.object({ launch_id: launchId }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/launches/${args.launch_id}/prompt-preview`),
  }),
];
