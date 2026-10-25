import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { SdkProvider, type AiProvider, type ObjectRequest, type ObjectResult, type TextRequest } from './ai.ts';

export class ClaudioError extends Error {
  readonly chatId: string | undefined;

  constructor(message: string, chatId?: string) {
    super(message);
    this.chatId = chatId;
  }
}

interface ChatBlock {
  type: string;
  name?: string;
  input?: unknown;
}

interface ChatView {
  chat: {
    id: string;
    state: 'working' | 'waiting' | 'idle';
    alive: boolean;
    executions: Array<{ outcome: 'completed' | 'failed' | 'stopped' | 'interrupted' | null; error: string | null; costUsd: number | null }>;
  };
  entries: Array<{ role: string; isSidechain?: boolean; blocks: ChatBlock[] }>;
}

export interface ClaudioOptions {
  /** claudio's base URL, e.g. http://localhost:8798 */
  url: string;
  token: string;
  fetch?: typeof fetch;
  /** How often to look at the chat while it works */
  pollMs?: number;
  /** How long a generation may take before it is stopped */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * claudio as Shipcast's AI provider. Structured work goes through claudio's own REST API: one chat
 * per generation, started in the checked-out repo with `jsonSchema` and read-only tools, read until
 * the model answers through Claude Code's `StructuredOutput` tool, then stopped (claudio keeps a
 * finished chat's process alive for a follow-up, so stopping it is what frees the slot). That path
 * is what lets Claude Code explore the repo itself. Streamed text, for the writing assistant, goes
 * through claudio's OpenAI-compatible surface at `/api/v1` (docs/decisions/ai-providers.md).
 */
export class Claudio implements AiProvider {
  readonly id = 'claudio' as const;
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #text: SdkProvider;

  constructor(options: ClaudioOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollMs = options.pollMs ?? 3000;
    this.#timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const openai = createOpenAICompatible({ name: 'claudio', baseURL: `${this.#url}/api/v1`, apiKey: this.#token, fetch: this.#fetch });
    // Without a model in the settings, claudio's own default: its model catalog names it `default`
    this.#text = new SdkProvider({ id: 'claudio', model: (id) => openai(id ?? 'default') });
  }

  streamText(request: TextRequest): AsyncIterable<string> {
    return this.#text.streamText(request);
  }

  async #call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.#fetch(`${this.#url}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ClaudioError(`claudio ${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
    }
    return response.json();
  }

  async generateObject(request: ObjectRequest): Promise<ObjectResult> {
    const started = (await this.#call('POST', '/chats', {
      prompt: request.prompt,
      cwd: request.cwd,
      jsonSchema: request.jsonSchema,
      allowedTools: request.allowedTools,
      // Denies whatever is not allowed instead of waiting for a person who is not there
      permissionMode: 'dontAsk',
      appendSystemPrompt: request.appendSystemPrompt,
      model: request.model,
      maxBudgetUsd: request.maxBudgetUsd,
      maxTurns: request.maxTurns,
    })) as { id: string };
    const chatId = started.id;

    try {
      const deadline = Date.now() + this.#timeoutMs;
      for (;;) {
        const view = (await this.#call('GET', `/chats/${chatId}?limit=50`)) as ChatView;
        const last = view.chat.executions.at(-1);
        if (last?.error) throw new ClaudioError(`claudio chat failed: ${last.error}`, chatId);
        if (last?.outcome === 'failed' || last?.outcome === 'interrupted') {
          throw new ClaudioError(`claudio chat ended ${last.outcome}`, chatId);
        }

        const output = structuredOutput(view);
        if (output !== undefined && view.chat.state === 'idle') {
          return { output, chatId, costUsd: last?.costUsd ?? null };
        }
        // Idle after the model has spoken, with no answer: the turn ended without one, and a chat
        // kept alive for a follow-up would otherwise only be noticed at the timeout
        const spoke = view.entries.some((e) => e.role === 'assistant' && !e.isSidechain);
        if (view.chat.state === 'idle' && (!view.chat.alive || last?.outcome || spoke)) {
          throw new ClaudioError('claudio chat ended without a structured answer', chatId);
        }
        if (Date.now() > deadline) throw new ClaudioError(`claudio chat took longer than ${this.#timeoutMs} ms`, chatId);
        await this.#sleep(this.#pollMs);
      }
    } finally {
      await this.#call('POST', `/chats/${chatId}/stop`).catch(() => undefined);
    }
  }
}

/** The input of the main agent's newest `StructuredOutput` call: the answer to the schema. */
function structuredOutput(view: ChatView): unknown {
  for (let i = view.entries.length - 1; i >= 0; i--) {
    const entry = view.entries[i]!;
    if (entry.role !== 'assistant' || entry.isSidechain) continue;
    const call = entry.blocks.findLast((b) => b.type === 'tool_use' && b.name === 'StructuredOutput');
    if (call) return call.input;
  }
  return undefined;
}
