import { AI_PROVIDERS, type AiProviderId, type AiSettings, type AiTask, type Prompt, type PromptId, type PromptVersion } from '@shipcast/engine';
import type { AiBudgetTask } from '@shipcast/schema';
import type { ApiRoute } from './api.ts';
import { InvalidInput, object, text } from './input.ts';

/*
 * The AI routes of the REST API: which provider and model each task uses, its budget, the prompts
 * and their history, and a prompt previewed for a past launch (the AI page's server functions,
 * ai.functions.ts). Provider credentials are never served: they are connected accounts.
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts, so the two modules never need each other at load time. A route and the server
 * function it mirrors call the same service. See docs/decisions/mcp-parity.md
 */

type JsonSchema = Record<string, unknown>;

export interface AiProviderView {
  id: AiProviderId;
  name: string;
  /** Whether its credential is set (claudio's address and token; the others' connected account), never the credential */
  connected: boolean;
}

export interface AiSettingsView {
  settings: AiSettings;
  /** brand.yml's tone, which the settings' tone replaces when set */
  brandTone: string | null;
  tasks: AiTask[];
  /** Ceilings only: what a run may spend, never what one did */
  budgets: { tasks: AiBudgetTask[]; defaults: Record<AiBudgetTask, number>; max: number };
  providers: AiProviderView[];
}

export interface AiPromptsView {
  prompts: Array<{ id: PromptId; default: string; versions: PromptVersion[] }>;
  variables: string[];
  /** The locked rules; the content pack's JSON Schema, also locked, is the app's to show */
  locked: {
    launchRules: string[];
    articleRules: string[];
    replyRules: string[];
    profileRules: string[];
    assistantLaunchRules: string[];
    assistantArticleRules: string[];
  };
}

export type ProviderCheck = { ok: true; detail: string } | { ok: false; problem: string };

/**
 * What the routes run in the app's process, built per request by aiApi in ai.server.ts; left out
 * where it is not wired (the tests of other routes), so a route answers a refusal without it
 */
export interface AiApi {
  settings(): Promise<AiSettingsView>;
  /** The whole settings, as writeAiSettings takes them */
  save(input: unknown): Promise<AiSettings>;
  /** One provider for every task, the tone and the budgets kept */
  useForAll(provider: AiProviderId): Promise<AiSettings>;
  /** The provider's readiness where it has one, or one cheap call */
  test(provider: AiProviderId): Promise<ProviderCheck>;
  prompts(): Promise<AiPromptsView>;
  savePrompt(id: string, text: string): Promise<PromptVersion[]>;
  restorePrompt(id: string, savedAt: string): Promise<PromptVersion[]>;
  /** Undefined when there is no such launch */
  preview(launchId: number): Promise<(Prompt & { task: AiTask }) | undefined>;
}

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });
const unavailable = () => failure(409, 'refused', 'the AI settings are not available in this process');

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new InvalidInput('send JSON, with content-type: application/json');
  const body = await request.text();
  // A prompt is at most 20,000 characters, escaped
  if (body.length > 100_000) throw new InvalidInput('the body is too large');
  try {
    return object(JSON.parse(body) as unknown, 'the body');
  } catch (error) {
    if (error instanceof InvalidInput) throw error;
    throw new InvalidInput('the body is not valid JSON');
  }
}

const CREDENTIAL = /key|token|secret|password|credential/i;

/**
 * Refuses a body that carries anything named like a credential, at any depth: the strict schema
 * would refuse it too, but this says why, and where the key goes instead.
 */
export function refuseCredentials(value: unknown, path = ''): void {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, inner] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    if (CREDENTIAL.test(key)) throw new InvalidInput(`${at}: a provider's key or token never comes through the API; connect its account in the app (Channels), or set claudio's token in its Settings`);
    refuseCredentials(inner, at);
  }
}

function providerId(value: string | undefined): AiProviderId {
  if (!(AI_PROVIDERS as readonly unknown[]).includes(value)) throw new InvalidInput(`the provider is one of ${AI_PROVIDERS.join(', ')}`);
  return value as AiProviderId;
}

function launchId(value: string | undefined): number {
  const n = /^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN;
  if (!Number.isInteger(n) || n <= 0) throw new InvalidInput('the launch id must be a positive integer');
  return n;
}

const promptId = (value: string | undefined) => text(value, 'the prompt id', 100);

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const versionsAnswer = { type: 'object', required: ['id', 'versions'], properties: { id: { type: 'string' }, versions: { type: 'array', items: ref('AiPromptVersion') } } };

export const AI_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/ai/settings',
    scope: 'read',
    operationId: 'getAiSettings',
    summary: 'Each AI task’s provider, model and spend ceiling (USD), the tone override, and whether each provider’s credential is set (never the credential)',
    response: { status: 200, description: 'The AI settings', schema: ref('AiSettingsView') },
    async handle(deps) {
      if (!deps.ai) return unavailable();
      return answer(200, await deps.ai.settings());
    },
  },
  {
    method: 'PUT',
    path: '/ai/settings',
    scope: 'write',
    operationId: 'setAiSettings',
    summary:
      'Replace the AI settings: every task’s provider and model, the tone (left out: brand.yml’s), the budgets overridden (left out: kept; a task left out of them: its default). Applies to every run from the next one. A key or token is refused: credentials are set in the app',
    body: ref('AiSettings'),
    response: { status: 200, description: 'The settings, saved', schema: { type: 'object', required: ['settings'], properties: { settings: ref('AiSettings') } } },
    async handle(deps, { request }) {
      const body = await readBody(request);
      refuseCredentials(body);
      if (!deps.ai) return unavailable();
      return answer(200, { settings: await deps.ai.save(body) });
    },
  },
  {
    method: 'POST',
    path: '/ai/providers/{provider}/use-for-all',
    scope: 'write',
    operationId: 'useAiProviderForAll',
    summary: 'Use one provider for every AI task; a task already on it keeps its model, the others take the provider’s default; the tone and budgets are kept',
    response: { status: 200, description: 'The settings, saved', schema: { type: 'object', required: ['settings'], properties: { settings: ref('AiSettings') } } },
    async handle(deps, { params }) {
      const provider = providerId(params.provider);
      if (!deps.ai) return unavailable();
      return answer(200, { settings: await deps.ai.useForAll(provider) });
    },
  },
  {
    method: 'POST',
    path: '/ai/providers/{provider}/test',
    scope: 'write',
    operationId: 'testAiProvider',
    summary: 'Check a provider works: its readiness where it has one (claudio’s proves the address, the token and the Claude sign-in), else one cheap model call',
    response: {
      status: 200,
      description: 'Whether it works: its detail, or the problem in the provider’s words',
      schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' }, problem: { type: 'string' } } },
    },
    async handle(deps, { params }) {
      const provider = providerId(params.provider);
      if (!deps.ai) return unavailable();
      return answer(200, await deps.ai.test(provider));
    },
  },
  {
    method: 'GET',
    path: '/ai/prompts',
    scope: 'read',
    operationId: 'listAiPrompts',
    summary:
      'The editable prompts: each one’s default and saved versions (oldest first, the last in use), the variables a prompt may use, and the locked rules appended after them (the content pack’s JSON Schema left out)',
    response: { status: 200, description: 'The prompts', schema: ref('AiPrompts') },
    async handle(deps) {
      if (!deps.ai) return unavailable();
      return answer(200, await deps.ai.prompts());
    },
  },
  {
    method: 'PUT',
    path: '/ai/prompts/{promptId}',
    scope: 'write',
    operationId: 'saveAiPrompt',
    summary: 'Save a prompt’s text as its new version, in use from the next run; the earlier ones are kept. The same text as the one in use saves nothing; a locked part is refused',
    body: { type: 'object', required: ['text'], properties: { text: { type: 'string', maxLength: 20000, description: 'The template; {{variable}} only from the variables GET /ai/prompts lists' } } },
    response: { status: 200, description: 'The prompt’s versions, the last in use', schema: versionsAnswer },
    async handle(deps, { params, request }) {
      const id = promptId(params.promptId);
      const body = await readBody(request);
      const value = text(body.text, 'text', 20_000);
      if (!deps.ai) return unavailable();
      return answer(200, { id, versions: await deps.ai.savePrompt(id, value) });
    },
  },
  {
    method: 'POST',
    path: '/ai/prompts/{promptId}/restore',
    scope: 'write',
    operationId: 'restoreAiPrompt',
    summary: 'Put an earlier version of a prompt back in use, as a new version (the history only grows); `default` restores the code’s',
    body: { type: 'object', required: ['savedAt'], properties: { savedAt: { type: 'string', description: 'The version’s savedAt, as GET /ai/prompts lists it, or `default`' } } },
    response: { status: 200, description: 'The prompt’s versions, the last in use', schema: versionsAnswer },
    async handle(deps, { params, request }) {
      const id = promptId(params.promptId);
      const body = await readBody(request);
      const savedAt = text(body.savedAt, 'savedAt', 100);
      if (!deps.ai) return unavailable();
      return answer(200, { id, versions: await deps.ai.restorePrompt(id, savedAt) });
    },
  },
  {
    method: 'GET',
    path: '/launches/{id}/prompt-preview',
    scope: 'read',
    operationId: 'previewAiPrompt',
    summary: 'The final prompt a past launch would get today with the saved prompts and tone: rendered only, no AI call (a release reads its launch.yml at the ref on GitHub)',
    response: {
      status: 200,
      description: 'The task it runs, its prompt and its system prompt',
      schema: { type: 'object', required: ['task', 'prompt', 'system'], properties: { task: { type: 'string' }, prompt: { type: 'string' }, system: { type: 'string' } } },
    },
    async handle(deps, { params }) {
      const id = launchId(params.id);
      if (!deps.ai) return unavailable();
      const preview = await deps.ai.preview(id);
      return preview ? answer(200, preview) : failure(404, 'not_found', 'no such launch');
    },
  },
];

const budgetMap: JsonSchema = { type: 'object', additionalProperties: { type: 'number' }, description: 'USD by budget task' };
const taskChoice: JsonSchema = {
  type: 'object',
  required: ['provider'],
  additionalProperties: false,
  properties: { provider: { type: 'string', enum: [...AI_PROVIDERS] }, model: { type: 'string', maxLength: 200, description: 'Left out: the provider’s default' } },
};

/** The components the AI routes' responses name, merged into the OpenAPI document's */
export const AI_SCHEMAS: Record<string, JsonSchema> = {
  AiSettings: {
    type: 'object',
    required: ['tasks'],
    additionalProperties: false,
    properties: {
      tasks: { type: 'object', additionalProperties: taskChoice, description: 'Each AI task’s provider and model: pack, article and assistant always, replies and profile kept when left out' },
      tone: { type: 'string', maxLength: 2000, description: 'Replaces brand.yml’s tone in every prompt' },
      budgets: { ...budgetMap, description: 'The ceilings overridden, USD per run of the task; a task left out runs with its default' },
    },
  },
  AiSettingsView: {
    type: 'object',
    required: ['settings', 'brandTone', 'tasks', 'budgets', 'providers'],
    properties: {
      settings: ref('AiSettings'),
      brandTone: { type: ['string', 'null'], description: 'brand.yml’s tone, used when the settings set none' },
      tasks: { type: 'array', items: { type: 'string' } },
      budgets: {
        type: 'object',
        description: 'Spend ceilings in USD per run, never what a run spent',
        properties: { tasks: { type: 'array', items: { type: 'string' } }, defaults: budgetMap, max: { type: 'number' } },
      },
      providers: {
        type: 'array',
        items: { type: 'object', required: ['id', 'name', 'connected'], properties: { id: { type: 'string' }, name: { type: 'string' }, connected: { type: 'boolean', description: 'Whether its credential is set; never the credential' } } },
      },
    },
  },
  AiPromptVersion: { type: 'object', required: ['text', 'savedAt'], properties: { text: { type: 'string' }, savedAt: { type: 'string', description: 'ISO 8601, or `default` for the code’s' } } },
  AiPrompts: {
    type: 'object',
    required: ['prompts', 'variables', 'locked'],
    properties: {
      prompts: {
        type: 'array',
        items: { type: 'object', required: ['id', 'default', 'versions'], properties: { id: { type: 'string' }, default: { type: 'string' }, versions: { type: 'array', items: ref('AiPromptVersion') } } },
      },
      variables: { type: 'array', items: { type: 'string' } },
      locked: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'The rules appended after the prompts, never editable' },
    },
  },
};
