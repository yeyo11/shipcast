import {
  AI_PROVIDERS,
  AI_TASKS,
  currentPrompts,
  DEFAULT_PROMPTS,
  lockedPrompts,
  previewPrompt,
  promptHistory,
  PROMPT_IDS,
  PROMPT_VARIABLES,
  readAiSettings,
  restorePrompt,
  savePrompt,
  writeAiSettings,
  type AiProviderId,
  type GitHubSource,
} from '@shipcast/engine';
import { aiProviderCheck } from '@shipcast/runtime';
import { AI_BUDGET_TASKS, DEFAULT_AI_BUDGETS_USD, MAX_AI_BUDGET_USD } from '@shipcast/schema';
import type { AiApi } from './ai-api.ts';
import { accountService } from './app-services.ts';
import type { AppContext } from './context.server.ts';

/*
 * The AI settings and prompts, as the AI routes (ai-api.ts) and the AI page's server functions
 * (ai.functions.ts) both need them. One implementation, two doors. A provider's credential is never
 * here: claudio's token and the API keys are saved by the app alone.
 */

const PROVIDER_NAMES: Record<AiProviderId, string> = { claudio: 'claudio', anthropic: 'Anthropic API', openaiCompatible: 'OpenAI-compatible server' };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The parts of the app's context the AI settings use: narrow, so a test builds them over its own registry */
export type AiContext = Pick<AppContext, 'registry' | 'secrets' | 'brand'> & {
  settings: { current(): { claudioUrl?: string | undefined; claudioToken?: string | undefined }; claudio(): { url: string; token: string }; launchesRepo(): string };
  github: GitHubSource;
  deps: Pick<AppContext['deps'], 'aiRunner'>;
};

/** claudio's address and token are the instance's settings (or .env); the other providers' keys are connected accounts */
async function connected(ctx: AiContext, brand: string, provider: AiProviderId): Promise<boolean> {
  if (provider !== 'claudio') return (await accountService(ctx).primary(brand, provider)) !== undefined;
  const { claudioUrl, claudioToken } = ctx.settings.current();
  return Boolean(claudioUrl && claudioToken);
}

/** What the AI routes run in the app's process, built per request by api-deps.server.ts */
export function aiApi(ctx: AiContext): AiApi {
  return {
    async settings() {
      const brand = await ctx.brand();
      return {
        settings: await readAiSettings(ctx.registry),
        brandTone: brand.tone ?? null,
        tasks: [...AI_TASKS],
        budgets: { tasks: [...AI_BUDGET_TASKS], defaults: { ...DEFAULT_AI_BUDGETS_USD }, max: MAX_AI_BUDGET_USD },
        providers: await Promise.all(AI_PROVIDERS.map(async (id) => ({ id, name: PROVIDER_NAMES[id], connected: await connected(ctx, brand.id, id) }))),
      };
    },
    save: (input) => writeAiSettings(ctx.registry, input),
    async useForAll(provider) {
      const current = await readAiSettings(ctx.registry);
      const tasks = Object.fromEntries(AI_TASKS.map((t) => [t, current.tasks[t].provider === provider ? current.tasks[t] : { provider }]));
      return writeAiSettings(ctx.registry, { tasks, ...(current.tone && { tone: current.tone }), ...(current.budgets && { budgets: current.budgets }) });
    },
    async test(provider) {
      try {
        // The provider module's own readiness (Claudio's /api/ready says when Claude is not signed in) or one cheap call, its failure in AiError's words
        const checked = await aiProviderCheck(ctx.deps.aiRunner, provider, { env: process.env, registry: ctx.registry, secrets: ctx.secrets, claudio: () => ctx.settings.claudio(), brand: () => ctx.brand() });
        return checked.ok ? { ok: true, detail: checked.detail } : { ok: false, problem: checked.problem };
      } catch (error) {
        return { ok: false, problem: message(error) };
      }
    },
    async prompts() {
      const history = await promptHistory(ctx.registry);
      const locked = lockedPrompts();
      return {
        prompts: PROMPT_IDS.map((id) => ({ id, default: DEFAULT_PROMPTS[id], versions: history[id] ?? [] })),
        variables: [...PROMPT_VARIABLES],
        locked: {
          launchRules: [...locked.launchRules],
          articleRules: [...locked.articleRules],
          replyRules: [...locked.replyRules],
          profileRules: [...locked.profileRules],
          assistantLaunchRules: [...locked.assistantLaunchRules],
          assistantArticleRules: [...locked.assistantArticleRules],
        },
      };
    },
    savePrompt: (id, text) => savePrompt(ctx.registry, id, text),
    restorePrompt: (id, savedAt) => restorePrompt(ctx.registry, id, savedAt),
    async preview(launchId) {
      const launch = await ctx.registry.launches.get(launchId);
      if (!launch) return undefined;
      const settings = await readAiSettings(ctx.registry);
      return previewPrompt(launch, await ctx.brand(), { github: ctx.github, launchesRepo: ctx.settings.launchesRepo() }, { prompts: await currentPrompts(ctx.registry), ...(settings.tone && { tone: settings.tone }) });
    },
  };
}
