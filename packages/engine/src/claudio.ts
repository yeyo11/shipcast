import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { APICallError, type ModelMessage } from 'ai';
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
 * through claudio's OpenAI-compatible surface at `/api/v1` (docs/decisions/ai-providers.md); while
 * that surface does not exist, the same text comes through the REST API instead, whole
 * (docs/decisions/writing-assistant.md).
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

  /**
   * Streams through `/api/v1` when claudio has it. A claudio without it answers 404 before any text,
   * and then the answer comes through the REST API as one piece: a chat with no tools, whose answer
   * is a one-field structured output. A failure after text has arrived is never retried that way.
   */
  async *streamText(request: TextRequest): AsyncIterable<string> {
    let spoke = false;
    try {
      for await (const chunk of this.#text.streamText(request)) {
        spoke = true;
        yield chunk;
      }
      return;
    } catch (error) {
      if (spoke || !surfaceMissing(error)) throw error;
    }
    request.onWhole?.();
    yield await this.wholeText(request);
  }

  /** The assistant's answer through the REST API: not streamed, so it arrives at once */
  async wholeText(request: TextRequest): Promise<string> {
    const result = await this.#run(
      {
        prompt: transcript(request),
        ...(request.system && { appendSystemPrompt: request.system }),
        jsonSchema: WHOLE_TEXT_SCHEMA,
        cwd: request.cwd ?? '/workspace',
        // Nothing to read: the text to work on is in the prompt
        allowedTools: [],
        model: request.model,
        maxTurns: 3,
      },
      { pollMs: Math.min(this.#pollMs, 1000), signal: request.abortSignal },
    );
    const output = result.output as { text?: unknown } | null;
    if (typeof output?.text !== 'string') throw new ClaudioError('claudio answered without the text', result.chatId);
    return output.text;
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

  generateObject(request: ObjectRequest): Promise<ObjectResult> {
    return this.#run(request, { pollMs: this.#pollMs });
  }

  async #run(request: ObjectRequest, options: { pollMs: number; signal?: AbortSignal }): Promise<ObjectResult> {
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
        // Whoever asked has gone (the page was closed): the chat is stopped below instead of finishing for nobody
        if (options.signal?.aborted) throw new ClaudioError('the request was cancelled', chatId);
        await this.#sleep(options.pollMs);
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

/** The one field the REST fallback answers with */
const WHOLE_TEXT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', description: 'Your whole answer, exactly as it should be shown' } },
};

/** claudio without its OpenAI-compatible API: the route is not there, so nothing was sent to a model */
function surfaceMissing(error: unknown): boolean {
  return APICallError.isInstance(error) && [404, 405, 501].includes(error.statusCode ?? 0);
}

function textOf(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

/**
 * A chat turned into one prompt for the REST fallback, which takes one prompt per chat: the turns
 * so far, labelled, and the last request to answer.
 */
export function transcript(request: Pick<TextRequest, 'prompt' | 'messages'>): string {
  const messages = (request.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (messages.length === 0) return `${request.prompt ?? ''}\n\nPut your whole answer in \`text\`.`;
  const turns = messages.map((m) => `${m.role === 'user' ? 'The owner' : 'You'} wrote:\n${textOf(m.content).trim()}`);
  return ['The conversation so far, oldest first:', '', turns.join('\n\n'), '', 'Answer the owner’s last message. Put your whole answer in `text`.'].join('\n');
}
