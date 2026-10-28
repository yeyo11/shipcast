import type { LanguageModel, SystemModelMessage } from 'ai';

/*
 * What Shipcast knows about one AI provider, as one module per provider in this folder, listed once
 * in registry.ts: the shape the channels have (packages/schema/src/channels), so adding a provider is
 * its module and a line. A provider is only ever a model here: Shipcast runs the tool loop itself
 * (runner.ts), and a provider answers model calls. Unlike a channel the module is not split into a
 * pure half and an adapter half, since all it holds beyond data is the AI SDK model it builds, and
 * building it does no I/O until the runner calls it.
 */

/** A value the provider needs: public ones are settings, secret ones live in the keychain */
export interface AiSettingField {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
}

/**
 * How the provider answers with JSON of a schema. `native`: a response format with a JSON Schema,
 * even beside tools; `native-without-tools`: the same, but only on a call with no client tools;
 * `none`: never, so the answer comes as the input of a submit tool.
 */
export type StructuredOutputSupport = 'native' | 'native-without-tools' | 'none';

/**
 * How a task that reads a repository reaches it. `local-tools`: the runner gives the model read-only
 * tools over the job's checkout on this machine. `remote-workspace`: the provider is itself an agent
 * that reads the checkout where it is mounted on its side (claudio's Claude Code), told where by the
 * module's request headers; the runner passes no client tools then.
 */
export type RepoAccess = 'remote-workspace' | 'local-tools';

/** Provider options as the AI SDK takes them on a message or a call, nested values included */
export type AiMessageOptions = NonNullable<SystemModelMessage['providerOptions']>;

/**
 * How a provider caches the prompt's prefix, as AI SDK provider options. A local-tools run sends the
 * same tools, system prompt and growing history on every step; cached, a step pays for its new
 * messages only. `system` marks the system prompt (the tools come before it, so they are cached
 * with it); `call` goes on every call, for the provider's own breakpoint at the end of the history.
 */
export interface AiPromptCaching {
  system: AiMessageOptions;
  call: AiMessageOptions;
}

export interface AiCapabilities {
  streaming: boolean;
  /** Whether the provider takes client tools (function calling) */
  tools: boolean;
  structuredOutput: StructuredOutputSupport;
  repoAccess: RepoAccess;
  /** Applied by the runner to every run with the repo's tools; none for a provider that caches on its own or not at all */
  promptCaching?: AiPromptCaching;
}

/** A provider's settings, by its fields' keys; an empty value is as good as none */
export type AiProviderSettings = Readonly<Record<string, string | undefined>>;

/** What one model call is for, which a remote agent's headers are made of */
export interface AiRequestContext {
  /** The task's id (`pack`, `assistant-check`…) */
  task: string;
  /** Whether the task reads the repository */
  needsRepo: boolean;
  /**
   * Where a remote agent works, as it sees the path: the job's checkout for a task that reads the
   * repo, else a folder with nothing in it. Only set for a `remote-workspace` provider.
   */
  cwd?: string;
  /** The task's own ceilings, for a provider that can be told them; Shipcast enforces its timeout and output tokens itself */
  limits: { maxTurns?: number; maxBudgetUsd?: number };
}

/** What every provider's JSON options are, as the AI SDK takes them per call */
export type AiProviderOptions = Record<string, Record<string, string | number | boolean | null>>;

export interface AiProviderDefinition<Id extends string = string> {
  id: Id;
  /** Its name in the AI settings */
  name: string;
  /** Whether the AI settings offer it; the OpenAI API is only chosen by Action mode's variables */
  listed: boolean;
  settings: readonly AiSettingField[];
  capabilities: AiCapabilities;
  /** The model a task runs with when the settings name none */
  defaultModel(settings: AiProviderSettings): string;
  /**
   * The AI SDK model. Throws AiError (`ai_not_connected`) for a missing required setting, naming the
   * field and never its value. `fetch` is the process's, so its calls are counted like any other.
   */
  model(settings: AiProviderSettings, modelId: string | undefined, options?: { fetch?: typeof fetch }): LanguageModel;
  /** Headers for one call, from what the call is for: how a remote agent is told where and with what to work */
  requestHeaders?(settings: AiProviderSettings, context: AiRequestContext): Record<string, string>;
  /** Passed with every call */
  providerOptions?: AiProviderOptions;
}

/** A provider's definition, its literal types kept so the registry can derive its ids */
export function aiProvider<const D extends AiProviderDefinition>(definition: D): D {
  return definition;
}
