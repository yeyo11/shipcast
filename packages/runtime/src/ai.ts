import {
  aiProviderDefinition,
  AiTaskRunner,
  checkAiProvider,
  type AiProviderCheck,
  readAiSettings,
  type AiProviderSettings,
  type AiRunSetup,
  type AiTelemetry,
  type RepoArchiveSource,
  type AiTask,
  type Repositories,
} from '@shipcast/engine';
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

/** An AI provider's connected account, as the keychain and the registry hold it; claudio has none, its URL and token are settings */
async function connectedAccount(id: string, deps: AiDeps): Promise<{ settings: Record<string, string>; secrets: Record<string, string> } | undefined> {
  const found = await credentialsFor(id, { env: deps.env, brand: await deps.brand(), registry: deps.registry, secrets: deps.secrets });
  return found?.credentials;
}

/**
 * A provider's settings for the AI task runner, by its definition's field keys: claudio's URL and
 * token from the settings, every other provider's from its connected account. The host of a provider
 * at an address of its own is registered for the measurement.
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

/** What the runner runs a task with: the task's provider and model as the AI settings have them when it runs */
export function aiRunSetup(deps: AiDeps): (task: AiTask) => Promise<AiRunSetup> {
  return async (task) => {
    const choice = (await readAiSettings(deps.registry)).tasks[task];
    const provider = aiProviderDefinition(choice.provider);
    if (!provider) throw new AiError('ai_not_connected', `the AI settings choose "${choice.provider}" for ${task}, which is not a provider`);
    return { provider, settings: await aiProviderSettings(choice.provider, deps), ...(choice.model && { model: choice.model }) };
  };
}

/**
 * The AI task runner, on the AI settings and the keychain: the one place it is built, so every task
 * (through the pipeline's deps) runs on the same one. `archives`
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
 * Tests one provider for onboarding and the AI settings, whichever the settings choose
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
