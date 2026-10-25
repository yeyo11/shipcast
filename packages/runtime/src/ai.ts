import {
  anthropicProvider,
  Claudio,
  currentPrompts,
  openAiCompatibleProvider,
  readAiSettings,
  type AiProvider,
  type AiProviderId,
  type AiSetup,
  type AiTask,
  type Registry,
} from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import { credentialsFor } from './services.ts';
import type { SecretStore } from './secrets.ts';

/** What choosing a task's provider needs: the settings, the keychain, and claudio's address from `.env` */
export interface AiDeps {
  env: NodeJS.ProcessEnv;
  registry: Registry;
  secrets: SecretStore;
  claudio: { url: string; token: string };
  brand(): Promise<Brand>;
  fetch?: typeof fetch;
}

export class AiNotConnected extends Error {}

const NAMES: Record<AiProviderId, string> = { claudio: 'claudio', anthropic: 'Anthropic API', openaiCompatible: 'OpenAI-compatible' };

/**
 * A provider by id. claudio keeps its URL and token in `.env` for now; the Anthropic API and an
 * OpenAI-compatible server are connected accounts, their keys in the keychain like any network's.
 */
export async function providerFor(id: AiProviderId, deps: AiDeps): Promise<AiProvider> {
  if (id === 'claudio') return new Claudio({ url: deps.claudio.url, token: deps.claudio.token, fetch: deps.fetch });
  const found = await credentialsFor(id, { env: deps.env, brand: await deps.brand(), registry: deps.registry, secrets: deps.secrets });
  if (!found) throw new AiNotConnected(`the ${NAMES[id]} is chosen in the AI settings but no account is connected: connect one on the Channels page`);
  const { settings, secrets } = found.credentials;
  if (id === 'anthropic') {
    if (!secrets.apiKey) throw new AiNotConnected('the Anthropic account has no API key: connect it again');
    return anthropicProvider({ apiKey: secrets.apiKey, fetch: deps.fetch });
  }
  if (!settings.baseUrl || !settings.model) throw new AiNotConnected('the OpenAI-compatible account needs a base URL and a model: connect it again');
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
