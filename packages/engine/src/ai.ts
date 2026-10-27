import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, jsonSchema, Output, stepCountIs, streamText, tool, type JSONSchema7, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { PromptTexts } from './prompt.ts';

/** What Shipcast asks an AI for; each one has its own provider and model in the AI settings */
export const AI_TASKS = ['pack', 'article', 'assistant', 'replies'] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const AI_PROVIDERS = ['claudio', 'anthropic', 'openaiCompatible'] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

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

/** Anthropic's current Opus, the default when the Anthropic API is chosen without a model */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** The OpenAI API's default in Action mode, where a developer picks OpenAI by a variable */
export const DEFAULT_OPENAI_MODEL = 'gpt-5.5';

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

const execFileAsync = promisify(execFile);
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'target', 'vendor']);
const MAX_FILE_BYTES = 200_000;
const MAX_LIST = 1000;
const MAX_MATCHES = 200;

/** Thrown for a path that leaves the checkout: the tools read the repo and nothing else on the machine */
export class OutsideRepo extends Error {}

/** A path inside the checkout, resolved through symlinks so a link cannot lead out of it */
async function inside(root: string, path: string): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(resolve(realRoot, path || '.'));
  const rel = relative(realRoot, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(realRoot, rel) !== target) throw new OutsideRepo(`${path} is outside the repository`);
  return target;
}

async function walk(root: string, dir: string, out: string[], limit: number): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (out.length >= limit) return;
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, full, out, limit);
    else if (entry.isFile()) out.push(relative(root, full));
  }
}

/**
 * Read-only tools over a checkout: list, read, search and the git history. Nothing writes, runs code
 * or reaches outside the repository; errors are returned to the model as text so it can try again.
 */
export function repoTools(root: string): ToolSet {
  const guard = async <T>(run: () => Promise<T>): Promise<T | string> => {
    try {
      return await run();
    } catch (error) {
      return `error: ${error instanceof Error ? error.message : String(error)}`;
    }
  };
  return {
    list_files: tool({
      description: 'Lists the files under a directory of the repository, recursively (dependencies and build output skipped).',
      inputSchema: z.object({ dir: z.string().describe('A directory relative to the repository root; "" for the root') }),
      execute: ({ dir }) =>
        guard(async () => {
          const base = await inside(root, dir);
          const files: string[] = [];
          await walk(await realpath(root), base, files, MAX_LIST);
          return files.join('\n') + (files.length >= MAX_LIST ? `\n(first ${MAX_LIST} files only)` : '');
        }),
    }),
    read_file: tool({
      description: 'Reads a text file of the repository.',
      inputSchema: z.object({ path: z.string().describe('A file path relative to the repository root') }),
      execute: ({ path }) =>
        guard(async () => {
          const file = await inside(root, path);
          const size = (await stat(file)).size;
          const text = (await readFile(file, 'utf8')).slice(0, MAX_FILE_BYTES);
          return size > MAX_FILE_BYTES ? `${text}\n(truncated: the file has ${size} bytes)` : text;
        }),
    }),
    search: tool({
      description: 'Finds the lines of the repository matching a regular expression, as path:line: text.',
      inputSchema: z.object({ pattern: z.string(), dir: z.string().optional().describe('Where to search, relative to the root; the whole repo by default') }),
      execute: ({ pattern, dir }) =>
        guard(async () => {
          const regex = new RegExp(pattern);
          const realRoot = await realpath(root);
          const files: string[] = [];
          await walk(realRoot, await inside(root, dir ?? ''), files, 5000);
          const matches: string[] = [];
          for (const file of files) {
            const full = join(realRoot, file);
            if ((await stat(full)).size > MAX_FILE_BYTES) continue;
            const lines = (await readFile(full, 'utf8')).split('\n');
            lines.forEach((line, i) => {
              if (matches.length < MAX_MATCHES && regex.test(line)) matches.push(`${file}:${i + 1}: ${line.slice(0, 300)}`);
            });
            if (matches.length >= MAX_MATCHES) break;
          }
          return matches.length > 0 ? matches.join('\n') : 'no matches';
        }),
    }),
    git_log: tool({
      description: 'The latest commits of the checked-out ref, one line each, with their tags.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
      execute: ({ limit }) =>
        guard(async () => (await execFileAsync('git', ['log', '--oneline', '--decorate', '-n', String(limit ?? 50)], { cwd: root })).stdout),
    }),
  };
}
