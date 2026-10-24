/** One request for structured work: a prompt run in a directory, answering with JSON of a schema. */
export interface GenerateRequest {
  prompt: string;
  /** Where the agent runs, as the provider sees it (claudio: a path under its `/workspace`) */
  cwd: string;
  /** The JSON Schema the answer must follow */
  jsonSchema: Record<string, unknown>;
  /** Tools the agent may use; anything else is denied, never asked about */
  allowedTools: string[];
  appendSystemPrompt?: string;
  model?: string;
  maxBudgetUsd?: number;
  maxTurns?: number;
}

export interface GenerateResult {
  /** The answer, as the model produced it: the caller validates it against its own schema */
  output: unknown;
  /** Where to read the whole conversation */
  chatId: string;
  costUsd: number | null;
}

/** An AI provider for Shipcast. claudio is the first; the Anthropic API and others come in phase 6. */
export interface AiProvider {
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

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
 * claudio as Shipcast's AI provider: one chat per generation, started with `jsonSchema`, read until
 * the model answers through Claude Code's `StructuredOutput` tool, then stopped. claudio keeps a
 * finished chat's process alive for a follow-up, so stopping it is what frees the slot.
 */
export class Claudio implements AiProvider {
  readonly #url: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClaudioOptions) {
    this.#url = options.url.replace(/\/+$/, '');
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#pollMs = options.pollMs ?? 3000;
    this.#timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  async generate(request: GenerateRequest): Promise<GenerateResult> {
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
