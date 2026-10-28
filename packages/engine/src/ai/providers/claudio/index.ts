import type { LanguageModel } from 'ai';
import { aiProvider, type AiProviderSettings } from '../definition.ts';
import { need } from '../settings.ts';
import { CLAUDIO_ERRORS } from './errors.ts';
import { CLAUDIO_DEFAULT_MODEL, createClaudio, type ClaudioCallOptions } from './model.ts';
import { claudioReady, ClaudioWorkspaces } from './workspaces.ts';
export * from './errors.ts';
export * from './model.ts';
export * from './workspaces.ts';

const fields = [
  { key: 'url', label: 'URL', secret: false },
  { key: 'token', label: 'token', secret: true },
] as const;

// What `need` names in its errors, apart from the definition so the module does not refer to itself
const self = { id: 'claudio', name: 'Claudio', settings: fields } as const;

const NAME = 'Claude Code — your subscription (via Claudio)';
/** Whose failure a workspace's or readiness's error names */
const named = { id: self.id, name: NAME, errors: CLAUDIO_ERRORS };

/**
 * Claude Code on the owner's subscription, through Claudio's OpenAI-compatible API (createClaudio).
 * Claudio is itself an agent: for a task that reads the repo it downloads the repository into a
 * workspace of its own (from the codeload URL the runner gets from GitHub), Claude Code explores it
 * with the declared read-only rules, and the answer comes in the response format; no client tools
 * (Claudio refuses them beside a response format), no folder shared with this machine. Every call
 * carries the task's turn and budget ceilings; a run's history has no assistant message, so Claudio
 * starts a chat of its own for it.
 */
export const claudioAiProvider = aiProvider({
  ...self,
  name: NAME,
  listed: true,
  errors: CLAUDIO_ERRORS,
  capabilities: { streaming: true, tools: false, structuredOutput: 'native-without-tools', repoAccess: 'remote-workspace' },
  // Its model catalog names its own default `default`
  defaultModel: () => CLAUDIO_DEFAULT_MODEL,
  model(settings: AiProviderSettings, modelId: string | undefined, options: { fetch?: typeof fetch } = {}): LanguageModel {
    return createClaudio({ baseURL: need(self, settings, 'url'), token: need(self, settings, 'token'), ...(options.fetch && { fetch: options.fetch }) })(modelId);
  },
  workspaces(settings, options = {}) {
    const client = new ClaudioWorkspaces({ baseURL: need(self, settings, 'url'), token: need(self, settings, 'token'), provider: named, ...(options.fetch && { fetch: options.fetch }) });
    return {
      prepare: async (source, signal) => ({ id: (await client.create(source, signal)).id }),
      release: (id) => client.delete(id),
    };
  },
  ready: (settings, options = {}) => claudioReady({ baseURL: need(self, settings, 'url'), provider: named, ...(options.fetch && { fetch: options.fetch }) }),
  callOptions(context) {
    const options: ClaudioCallOptions = {
      ...(context.workspace && { workspace: context.workspace.id, allowedTools: [...context.workspace.allowedTools] }),
      ...(context.limits.maxTurns !== undefined && { maxTurns: context.limits.maxTurns }),
      maxBudgetUsd: context.limits.maxBudgetUsd,
    };
    return { claudio: options };
  },
});
