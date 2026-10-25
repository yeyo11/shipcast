import {
  AI_PROVIDERS,
  AI_TASKS,
  currentPrompts,
  DEFAULT_PROMPTS,
  InvalidAiSettings,
  InvalidPrompt,
  lockedPrompts,
  LockedPrompt,
  previewPrompt,
  promptHistory,
  PROMPT_IDS,
  PROMPT_VARIABLES,
  readAiSettings,
  restorePrompt,
  savePrompt,
  writeAiSettings,
  type AiProviderId,
} from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { id, InvalidInput, object, text } from './input';

/** Errors the owner can act on come back as a message for the page, not a server error */
function asInput<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    if (error instanceof InvalidAiSettings || error instanceof InvalidPrompt || error instanceof LockedPrompt) throw new InvalidInput(error.message);
    throw error;
  });
}

const PROVIDER_NAMES: Record<AiProviderId, string> = { claudio: 'claudio', anthropic: 'Anthropic API', openaiCompatible: 'OpenAI-compatible server' };

export const getAiSettings = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const brand = await ctx.brand();
  const history = await promptHistory(ctx.registry);
  const providers = await Promise.all(
    AI_PROVIDERS.map(async (provider) => ({
      id: provider,
      name: PROVIDER_NAMES[provider],
      // claudio's address and token still come from .env; the others are connected accounts
      connected: provider === 'claudio' ? true : (await ctx.registry.primaryAccount(brand.id, provider)) !== undefined,
    })),
  );
  const locked = lockedPrompts();
  return {
    settings: await readAiSettings(ctx.registry),
    brandTone: brand.tone ?? null,
    tasks: [...AI_TASKS],
    providers,
    prompts: PROMPT_IDS.map((promptId) => ({
      id: promptId,
      default: DEFAULT_PROMPTS[promptId],
      versions: history[promptId] ?? [],
    })),
    variables: [...PROMPT_VARIABLES],
    locked: { launchRules: [...locked.launchRules], articleRules: [...locked.articleRules], packSchema: JSON.stringify(locked.packSchema, null, 2) },
    launches: (await ctx.registry.recent(50)).map((l) => ({ id: l.id, label: `${l.repo} ${l.ref.replace(/^article:/, '')} · ${l.status}` })),
  };
});

export const saveAiSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => object(input, 'input'))
  .handler(async ({ data }) => asInput(async () => writeAiSettings((await appContext()).registry, data)));

export const saveAiPrompt = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: text(o.id, 'id', 100), text: text(o.text, 'text', 20_000) };
  })
  .handler(async ({ data }) => asInput(async () => savePrompt((await appContext()).registry, data.id, data.text)));

export const restoreAiPrompt = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: text(o.id, 'id', 100), savedAt: text(o.savedAt, 'savedAt', 100) };
  })
  .handler(async ({ data }) => asInput(async () => restorePrompt((await appContext()).registry, data.id, data.savedAt)));

/** The final prompt a past launch would get with the saved prompts and tone: rendered here, no AI call */
export const previewAiPrompt = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(object(input, 'input').launchId, 'launchId'))
  .handler(async ({ data }) =>
    asInput(async () => {
      const ctx = await appContext();
      const launch = await ctx.registry.get(data);
      if (!launch) throw new InvalidInput(`no launch ${data}`);
      const settings = await readAiSettings(ctx.registry);
      return previewPrompt(launch, await ctx.brand(), { github: ctx.github, launchesRepo: ctx.config.launchesRepo }, { prompts: await currentPrompts(ctx.registry), tone: settings.tone });
    }),
  );
