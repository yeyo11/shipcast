import {
  AssistantRefused,
  buildActionPrompt,
  buildChat,
  checkAgainstCode,
  isAdaptTarget,
  isAssistantAction,
  launchCodeRef,
  type AiSetup,
  type AssistantContext,
  type Checkout,
  type Launch,
  type AssistantRepository,
} from '@shipcast/engine';
import type { Brand } from '@shipcast/schema';
import type { AssistantEvent, AssistantRequest, ChatTurn } from '../components/assistant/protocol.ts';
import { splitProposals } from '../components/assistant/diff.ts';
import { id, InvalidInput, object, text } from './input.ts';

/*
 * The writing assistant's endpoint (`POST /api/assistant`, behind the session and the same-origin
 * check like every page request): one quick action or one chat turn, answered as NDJSON events while
 * the model writes. Written over its dependencies so the tests run it with a mock model.
 * See docs/decisions/writing-assistant.md
 */

export interface AssistantDeps {
  /** The `assistant` task's provider, model, prompts and tone, from the AI settings */
  setup(): Promise<AiSetup>;
  brand(): Promise<Brand>;
  launch(id: number): Promise<Launch | undefined>;
  /** What a launch's text is grounded in: its analysis, or nothing for an article */
  grounding(launch: Launch): Promise<Pick<AssistantContext, 'kind' | 'launch'>>;
  checkout(repo: string, ref: string): Promise<Checkout>;
  /** Where claudio's REST fallback works when there is no repo: its workspace root */
  aiWorkdir?: string;
  maxBudgetUsd?: number;
  /**
   * With `ai-runner`: queues the check against the code as a heavy job and gives its id, so no clone
   * nor agent runs inside this request; without it the check runs here, as before
   */
  startCheck?(launch: Launch, request: { text: string; lang?: string; channel?: string }): Promise<string>;
  /** Where chat turns are kept; without it the chat is not saved */
  sessions?: Pick<AssistantRepository, 'createAssistantSession' | 'assistantSession' | 'addAssistantMessage'>;
}

/** A session's title: the first question in a line, or the draft's name when it has no words */
export function sessionTitle(question: string, draftLabel: string | undefined): string {
  const line = question.replace(/\s+/g, ' ').trim();
  if (!line) return draftLabel || 'Untitled session';
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

const MAX_DOCUMENT = 200_000;

function turns(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) throw new InvalidInput('messages must be a list');
  if (value.length > 40) throw new InvalidInput('the conversation is too long: start a new one');
  return value.map((v, i) => {
    const o = object(v, `messages[${i}]`);
    if (o.role !== 'user' && o.role !== 'assistant') throw new InvalidInput(`messages[${i}].role is user or assistant`);
    return { role: o.role, content: text(o.content, `messages[${i}].content`, 20_000) };
  });
}

/** The request's shape, checked before anything is asked of the AI */
export function parseAssistantRequest(input: unknown): AssistantRequest {
  const o = object(input, 'request');
  const action = o.action;
  if (action !== 'chat' && !isAssistantAction(action)) throw new InvalidInput('action is improve, shorten, translate, titles, adapt, check or chat');
  const request: AssistantRequest = {
    action,
    selection: o.selection === undefined ? '' : text(o.selection, 'selection', MAX_DOCUMENT),
    document: text(o.document ?? '', 'document', MAX_DOCUMENT),
  };
  if (o.lang !== undefined && o.lang !== null) {
    if (o.lang !== 'en' && o.lang !== 'es') throw new InvalidInput('lang is en or es');
    request.lang = o.lang;
  }
  if (typeof o.channel === 'string' && o.channel) request.channel = text(o.channel, 'channel', 40);
  if (o.sessionId !== undefined && o.sessionId !== null) request.sessionId = id(o.sessionId, 'sessionId');
  if (typeof o.draftPath === 'string' && o.draftPath) request.draftPath = text(o.draftPath, 'draftPath', 300);
  if (typeof o.draftLabel === 'string' && o.draftLabel) request.draftLabel = text(o.draftLabel, 'draftLabel', 200);
  if (o.range !== undefined && o.range !== null) {
    const r = object(o.range, 'range');
    if (typeof r.start !== 'number' || typeof r.end !== 'number' || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 0 || r.end < r.start) {
      throw new InvalidInput('range must be two offsets into the text');
    }
    request.range = { start: r.start, end: r.end };
  }
  if (o.target !== undefined) {
    if (!isAdaptTarget(o.target)) throw new InvalidInput('target is a network the assistant can adapt to');
    request.target = o.target;
  }
  if (o.launchId !== undefined && o.launchId !== null) request.launchId = id(o.launchId, 'launchId');
  if (action === 'chat') {
    request.messages = turns(o.messages);
    if (request.messages.at(-1)?.role !== 'user') throw new InvalidInput('the conversation ends with your message');
  } else if (!(request.selection || request.document).trim()) {
    throw new InvalidInput('there is no text to work on: write or select some first');
  }
  return request;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The events for one request, in order: `whole` first when the provider cannot stream, the text as
 * it comes (or the check's result), and `done`; a failure is an `error` event, never a broken stream.
 */
export async function* assistantEvents(request: AssistantRequest, deps: AssistantDeps, signal?: AbortSignal): AsyncGenerator<AssistantEvent> {
  try {
    const launch = request.launchId === undefined ? undefined : await deps.launch(request.launchId);
    if (request.launchId !== undefined && !launch) throw new AssistantRefused(`there is no launch ${request.launchId}`);
    const grounding = launch ? await deps.grounding(launch) : { kind: 'article' as const };
    const context: AssistantContext = {
      kind: grounding.kind,
      document: request.document,
      ...(request.lang && { lang: request.lang }),
      ...(request.channel && { channel: request.channel }),
      ...(grounding.launch && { launch: grounding.launch }),
    };
    const [setup, brand] = await Promise.all([deps.setup(), deps.brand()]);
    const selection = request.selection.trim() ? request.selection : request.document;

    if (request.action === 'check') {
      if (!launch || context.kind !== 'launch') throw new AssistantRefused('an article has no code to check against: the article itself is the truth');
      yield { type: 'whole' };
      if (deps.startCheck) {
        yield { type: 'job', id: await deps.startCheck(launch, { text: selection, ...(context.lang && { lang: context.lang }), ...(context.channel && { channel: context.channel }) }) };
        return;
      }
      const checkout = await deps.checkout(launch.repo, launchCodeRef(launch));
      const answer = await checkAgainstCode(selection, context, { setup, brand, checkout, ...(deps.maxBudgetUsd !== undefined && { maxBudgetUsd: deps.maxBudgetUsd }) });
      yield { type: 'check', revised: answer.revised, findings: answer.findings };
      yield { type: 'done' };
      return;
    }

    // The chat is saved as it goes: the question first, so a session exists even if the answer fails
    const saving = request.action === 'chat' && deps.sessions ? await startSaving(request, launch, deps.sessions) : undefined;

    let whole = false;
    const common = { model: setup.model, cwd: deps.aiWorkdir ?? '/workspace', ...(signal && { abortSignal: signal }), onWhole: () => (whole = true) };
    const stream =
      request.action === 'chat'
        ? (() => {
            const chat = buildChat(request.messages ?? [], { ...context, selection: request.selection }, brand, { tone: setup.tone });
            return setup.provider.streamText({ ...common, system: chat.system, messages: chat.messages });
          })()
        : (() => {
            const prompt = buildActionPrompt(
              { action: request.action, selection, ...(request.target && isAdaptTarget(request.target) && { target: request.target }) },
              context,
              brand,
              { tone: setup.tone },
            );
            return setup.provider.streamText({ ...common, system: prompt.system, prompt: prompt.prompt });
          })();

    let told = false;
    let answer = '';
    let settled = false;
    try {
      for await (const chunk of stream) {
        if (whole && !told) {
          told = true;
          yield { type: 'whole' };
        }
        if (chunk) {
          answer += chunk;
          yield { type: 'text', text: chunk };
        }
      }
      settled = true;
      const saved = saving ? await saving.finish(answer) : undefined;
      if (saved) yield { type: 'saved', ...saved };
      yield { type: 'done' };
    } catch (error) {
      // A stopped answer is kept as far as it got; a failed one with why it stopped
      if (saving && !settled) {
        settled = true;
        await saving.finish(answer, signal?.aborted ? undefined : message(error));
      }
      throw error;
    } finally {
      // The reader went away mid-answer (the generator was returned): keep what was written
      if (saving && !settled) await saving.finish(answer);
    }
  } catch (error) {
    if (signal?.aborted) return;
    yield { type: 'error', message: message(error) };
  }
}

type Sessions = NonNullable<AssistantDeps['sessions']>;

/**
 * Saves the owner's question and returns what saves the answer. Saving never breaks the chat: a
 * database that fails costs the history, not the answer.
 */
async function startSaving(request: AssistantRequest, launch: Launch | undefined, sessions: Sessions) {
  const question = request.messages?.at(-1)?.content ?? '';
  try {
    let sessionId = request.sessionId;
    if (sessionId !== undefined && !(await sessions.assistantSession(sessionId))) sessionId = undefined;
    sessionId ??= (
      await sessions.createAssistantSession({
        title: sessionTitle(question, request.draftLabel),
        launchId: launch?.id ?? null,
        draftPath: request.draftPath ?? null,
        draftLabel: request.draftLabel ?? null,
      })
    ).id;
    const id = sessionId;
    const selection = request.range && request.selection ? { ...request.range, original: request.selection } : null;
    await sessions.addAssistantMessage(id, { role: 'user', content: question, selection });
    return {
      async finish(answer: string, problem?: string): Promise<{ sessionId: number; messageId: number } | undefined> {
        try {
          const proposals = splitProposals(answer).flatMap((p) => (p.type === 'proposal' && p.complete ? [{ text: p.text, state: 'open' as const }] : []));
          const row = await sessions.addAssistantMessage(id, { role: 'assistant', content: answer, proposals, selection, problem: problem ?? null });
          return row ? { sessionId: id, messageId: row.id } : undefined;
        } catch {
          return undefined;
        }
      },
    };
  } catch {
    return undefined;
  }
}

/** The endpoint: checks the request, then streams its events as NDJSON */
export async function handleAssistant(request: Request, deps: () => Promise<AssistantDeps>): Promise<Response> {
  let parsed: AssistantRequest;
  try {
    parsed = parseAssistantRequest(await request.json());
  } catch (error) {
    return Response.json({ error: error instanceof InvalidInput ? error.message : 'the request is not JSON' }, { status: 400 });
  }
  const resolved = await deps();
  const encoder = new TextEncoder();
  const events = assistantEvents(parsed, resolved, request.signal);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
    },
    async cancel() {
      await events.return(undefined);
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
