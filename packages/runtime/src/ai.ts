import {
  aiProviderDefinition,
  AiTaskRunner,
  checkAiProvider,
  type AiProviderCheck,
  currentPrompts,
  readAiSettings,
  type AiProviderSettings,
  type AiRunSetup,
  type AiTelemetry,
  type RepoArchiveSource,
  type AiProviderId,
  type AiTask,
  type Repositories,
} from '@shipcast/engine';
// LEGACY (flag off): the old providers, until the AI task runner is the only path
import { anthropicProvider, Claudio, openAiCompatibleProvider, type AiProvider, type AiSetup } from '@shipcast/engine/legacy-ai';
import { AiError, type Brand } from '@shipcast/schema';
import { credentialsFor } from './services.ts';
import type { SecretStore } from './secrets.ts';
import { registerAiHost } from './telemetry/classify.ts';

/** What choosing a task's provider needs: the settings, the keychain, and claudio's address and token from the settings */
export interface AiDeps {
  env: NodeJS.ProcessEnv;
  registry: Pick<Repositories, 'accounts' | 'settings' | 'cursors'>;
  secrets: SecretStore;
  /** Read when claudio is chosen; throws SettingMissing when its URL or token is not set */
  claudio: () => { url: string; token: string };
  brand(): Promise<Brand>;
  fetch?: typeof fetch;
}

export class AiNotConnected extends Error {}

const NAMES: Record<AiProviderId, string> = { claudio: 'claudio', anthropic: 'Anthropic API', openaiCompatible: 'OpenAI-compatible' };

/** An AI provider's connected account, as the keychain and the registry hold it; claudio has none, its URL and token are settings */
async function connectedAccount(id: string, deps: AiDeps): Promise<{ settings: Record<string, string>; secrets: Record<string, string> } | undefined> {
  const found = await credentialsFor(id, { env: deps.env, brand: await deps.brand(), registry: deps.registry, secrets: deps.secrets });
  return found?.credentials;
}

/**
 * A provider by id. claudio's URL and token are settings (the token in the keychain); the Anthropic API and an
 * OpenAI-compatible server are connected accounts, their keys in the keychain like any network's.
 */
export async function providerFor(id: AiProviderId, deps: AiDeps): Promise<AiProvider> {
  if (id === 'claudio') {
    const claudio = deps.claudio();
    // Its calls are labelled by its host in the measurement; nothing else changes with this
    registerAiHost(claudio.url, 'claudio');
    return new Claudio({ ...claudio, fetch: deps.fetch });
  }
  const found = await connectedAccount(id, deps);
  if (!found) throw new AiNotConnected(`the ${NAMES[id]} is chosen in the AI settings but no account is connected: connect one on the Channels page`);
  const { settings, secrets } = found;
  if (id === 'anthropic') {
    if (!secrets.apiKey) throw new AiNotConnected('the Anthropic account has no API key: connect it again');
    return anthropicProvider({ apiKey: secrets.apiKey, fetch: deps.fetch });
  }
  if (!settings.baseUrl || !settings.model) throw new AiNotConnected('the OpenAI-compatible account needs a base URL and a model: connect it again');
  registerAiHost(settings.baseUrl, 'openai-compatible');
  return openAiCompatibleProvider({ baseUrl: settings.baseUrl, apiKey: secrets.apiKey, model: settings.model, fetch: deps.fetch });
}

/**
 * What the pipeline asks before each AI call: the task's provider and model, the owner's prompts and
 * tone, all read from the settings then, so a change in the app applies to the next draft.
 */
export function aiSetup(deps: AiDeps): (task: AiTask) => Promise<AiSetup> {
  return async (task) => {
    const settings = await readAiSettings(deps.registry);
    const choice = settings.tasks[task];
    return {
      provider: await providerFor(choice.provider, deps),
      model: choice.model,
      prompts: await currentPrompts(deps.registry),
      tone: settings.tone,
    };
  };
}

/**
 * A provider's settings for the AI task runner, by its definition's field keys, read where the old
 * providers read them: claudio's URL and token from the settings, every other provider's from its
 * connected account. The host of a provider at an address of its own is registered for the measurement.
 */
export async function aiProviderSettings(id: string, deps: AiDeps): Promise<AiProviderSettings> {
  if (id === 'claudio') {
    const claudio = deps.claudio();
    registerAiHost(claudio.url, 'claudio');
    return { url: claudio.url, token: claudio.token };
  }
  const found = await connectedAccount(id, deps);
  if (!found) throw new AiError('ai_not_connected', `the ${aiProviderDefinition(id)?.name ?? id} is chosen in the AI settings but no account is connected: connect one on the Channels page`, { provider: id });
  if (found.settings.baseUrl) registerAiHost(found.settings.baseUrl, 'openai-compatible');
  return { ...found.settings, ...found.secrets };
}

/** What the runner runs a task with: the task's provider, model and the owner's spend ceilings as the AI settings have them when it runs */
export function aiRunSetup(deps: AiDeps): (task: AiTask) => Promise<AiRunSetup> {
  return async (task) => {
    const ai = await readAiSettings(deps.registry);
    const choice = ai.tasks[task];
    const provider = aiProviderDefinition(choice.provider);
    if (!provider) throw new AiError('ai_not_connected', `the AI settings choose "${choice.provider}" for ${task}, which is not a provider`);
    return { provider, settings: await aiProviderSettings(choice.provider, deps), ...(choice.model && { model: choice.model }), ...(ai.budgets && { budgets: ai.budgets }) };
  };
}

/**
 * The AI task runner (`ai-runner` flag), on the same settings and keychain as the old providers: the
 * one place it is built, so every task (through the pipeline's deps) runs on the same one. `archives`
 * is the GitHub client, which gives Claudio's workspaces the repo's download URL and keeps its token
 * to itself.
 */
export function aiRunnerFor(deps: AiDeps & { archives: RepoArchiveSource; telemetry?: AiTelemetry }): AiTaskRunner {
  return new AiTaskRunner({
    resolve: aiRunSetup(deps),
    archives: deps.archives,
    ...(deps.telemetry && { telemetry: deps.telemetry }),
    ...(deps.fetch && { fetch: deps.fetch }),
  });
}

/**
 * Tests one provider for onboarding and the AI settings (`ai-runner`), whichever the settings choose
 * for the tasks: its connected account or settings read as a task would read them, then its
 * readiness or one cheap call (engine's checkAiProvider). A missing account is said, not thrown.
 */
export async function aiProviderCheck(runner: AiTaskRunner, id: string, deps: AiDeps): Promise<AiProviderCheck> {
  const provider = aiProviderDefinition(id);
  if (!provider) return { ok: false, code: 'ai_not_connected', problem: `"${id}" is not an AI provider` };
  let settings: AiProviderSettings;
  try {
    settings = await aiProviderSettings(id, deps);
  } catch (error) {
    if (error instanceof AiError) return { ok: false, code: error.code, problem: error.message };
    throw error;
  }
  return checkAiProvider(runner, { provider, settings }, deps.fetch ? { fetch: deps.fetch } : {});
}
