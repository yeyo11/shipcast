import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, Output, stepCountIs, streamText, type JSONSchema7, type LanguageModel, type ModelMessage } from 'ai';
import { DEFAULT_ANTHROPIC_MODEL } from './ai/providers/anthropic.ts';
import { DEFAULT_OPENAI_MODEL } from './ai/providers/openai.ts';
import { repoTools } from './ai/repo-tools.ts';
import type { AiProviderId } from './ai/providers/registry.ts';
import type { PromptTexts } from './prompt.ts';

/*
 * LEGACY: the AI layer before the AI task runner (packages/engine/src/ai/), still what every task
 * runs on with the `ai-runner` flag off. Reached only through `@shipcast/engine/legacy-ai`, and only
 * from the files .dependency-cruiser.cjs lists (rule `legacy-ai-layer-only-in-legacy-files`), so its
 * removal is a delete of those files' old branches and of this file.
 */

/** One request for structured work: a prompt answered with JSON of a schema, maybe after reading a repo. */
export interface ObjectRequest {
  prompt: string;
  /** The standing rules, appended to the provider's own system prompt */
  appendSystemPrompt?: string;
  /** The JSON Schema the answer must follow: the contract, whatever the provider */
  jsonSchema: Record<string, unknown>;
  /** The checked-out repo as the provider sees it (claudio: a path under its `/workspace`) */
  cwd: string;
  /** The same checkout on this machine, for providers whose tools run here; none when there is no repo to read */
  hostDir?: string;
  /** Claude Code tools the agent may use (claudio); anything else is denied, never asked about */
  allowedTools: string[];
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

export interface ObjectResult {
  /** The answer, as the model produced it: the caller validates it against its own schema */
  output: unknown;
  /** Where to read the whole conversation, when the provider keeps one (a claudio chat) */
  chatId?: string;
  /** Kept for the records only: AI cost is never shown in the UI */
  costUsd: number | null;
}

/** A turn of the writing assistant: text in, text streamed back */
export interface TextRequest {
  system?: string;
  prompt?: string;
  messages?: ModelMessage[];
  model?: string;
  abortSignal?: AbortSignal;
  /**
   * Where a provider that runs an agent (claudio's REST fallback) works when there is no repo to read:
   * a folder with nothing in it worth reading, its workspace root
   */
  cwd?: string;
  /**
   * Called before the first text when the provider cannot stream and the whole answer will arrive at
   * once (claudio until its OpenAI-compatible API exists), so the page can say so
   */
  onWhole?: () => void;
}

/**
 * Shipcast's AI provider, whichever is behind it: structured answers for the content pack and the
 * article's distribution, and streamed text for the writing assistant.
 */
export interface AiProvider {
  /** `openai` and `test` are only built outside the AI settings: Action mode's OpenAI API, and fakes */
  readonly id: AiProviderId | 'openai' | 'test';
  generateObject(request: ObjectRequest): Promise<ObjectResult>;
  streamText(request: TextRequest): AsyncIterable<string>;
}

/** What one task runs with, as the AI settings chose it: the provider, its model, and the owner's prompts */
export interface AiSetup {
  provider: AiProvider;
  model?: string;
  prompts: PromptTexts;
  /** The brand's tone as the settings override it; brand.yml's without one */
  tone?: string;
}


/** How many tool rounds an SDK provider may take reading a repo before it must answer */
const MAX_STEPS = 40;
/** Room for a whole content pack, every language and channel, in one answer */
const MAX_OUTPUT_TOKENS = 32_000;

/** What `generateText` takes as provider options: a JSON object per provider */
type ProviderOptions = Record<string, Record<string, string | number | boolean | null>>;

export interface SdkProviderOptions {
  id: AiProviderId | 'openai' | 'test';
  /** The model for an id, or the default one without */
  model: (id: string | undefined) => LanguageModel;
  /** Passed with every structured request */
  providerOptions?: ProviderOptions;
}

/**
 * A provider on the Vercel AI SDK (the Anthropic API, any OpenAI-compatible server, or a mock in
 * tests). It has no agent of its own, so when there is a repo to read it gets read-only tools over the
 * checkout on this machine, the same reach claudio's Claude Code has with Read, Grep and git log.
 */
export class SdkProvider implements AiProvider {
  readonly id: AiProviderId | 'openai' | 'test';
  readonly #model: (id: string | undefined) => LanguageModel;
  readonly #providerOptions: ProviderOptions | undefined;

  constructor(options: SdkProviderOptions) {
    this.id = options.id;
    this.#model = options.model;
    this.#providerOptions = options.providerOptions;
  }

  async generateObject(request: ObjectRequest): Promise<ObjectResult> {
    const tools = request.hostDir ? repoTools(request.hostDir) : undefined;
    const result = await generateText({
      model: this.#model(request.model),
      system: request.appendSystemPrompt,
      prompt: request.prompt,
      output: Output.object({ schema: jsonSchema(request.jsonSchema as JSONSchema7), name: 'content_pack' }),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(this.#providerOptions && { providerOptions: this.#providerOptions }),
      ...(tools ? { tools, stopWhen: stepCountIs(request.maxTurns ?? MAX_STEPS) } : {}),
    });
    return { output: result.output, costUsd: null };
  }

  async *streamText(request: TextRequest): AsyncIterable<string> {
    // streamText reports a failed call to onError and ends the stream quietly; the caller must hear of it
    let failure: { error: unknown } | undefined;
    const onError = ({ error }: { error: unknown }) => {
      failure = { error };
    };
    const common = { model: this.#model(request.model), system: request.system, abortSignal: request.abortSignal, onError };
    const result = request.messages ? streamText({ ...common, messages: request.messages }) : streamText({ ...common, prompt: request.prompt ?? '' });
    yield* result.textStream;
    if (failure) throw failure.error instanceof Error ? failure.error : new Error(String(failure.error));
  }
}

export function anthropicProvider(options: { apiKey: string; fetch?: typeof fetch }): SdkProvider {
  const anthropic = createAnthropic({ apiKey: options.apiKey, fetch: options.fetch });
  return new SdkProvider({ id: 'anthropic', model: (id) => anthropic(id ?? DEFAULT_ANTHROPIC_MODEL) });
}

/**
 * The OpenAI API itself, through its own SDK provider: its current models refuse the `max_tokens`
 * that Chat Completions servers take, and the Responses API speaks their parameters. Strict JSON
 * Schema is off because the pack's schema has optional fields, which strict mode refuses.
 */
export function openAiProvider(options: { apiKey: string; fetch?: typeof fetch }): SdkProvider {
  const openai = createOpenAI({ apiKey: options.apiKey, fetch: options.fetch });
  return new SdkProvider({ id: 'openai', model: (id) => openai(id ?? DEFAULT_OPENAI_MODEL), providerOptions: { openai: { strictJsonSchema: false } } });
}

export function openAiCompatibleProvider(options: { baseUrl: string; apiKey?: string; model: string; fetch?: typeof fetch }): SdkProvider {
  const provider = createOpenAICompatible({
    name: 'openaiCompatible',
    baseURL: options.baseUrl.replace(/\/+$/, ''),
    apiKey: options.apiKey || undefined,
    fetch: options.fetch,
    // response_format with a JSON Schema: most local servers (llama.cpp, vLLM, Ollama) honour it
    supportsStructuredOutputs: true,
  });
  return new SdkProvider({ id: 'openaiCompatible', model: (id) => provider(id ?? options.model) });
}
