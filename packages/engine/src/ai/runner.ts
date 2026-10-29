import { AI_BUDGET_TASKS, AiError, ANALYSIS_RULES, type AiBudgetTask, type AiTask, type AiTaskDefinition, type AiTaskLimits } from '@shipcast/schema';
import { hasToolCall, jsonSchema, Output, stepCountIs, streamText, tool, type JSONSchema7, type LanguageModelUsage, type ModelMessage, type OutputInterface, type ProviderMetadata, type StopCondition, type SystemModelMessage, type ToolSet } from 'ai';
import type { z } from 'zod';
import type { TimingKind, TimingOutcome } from '../telemetry/store.ts';
import { toAiError } from './errors.ts';
import type { RepoArchiveSource } from '../github.ts';
import type { AiCallContext, AiMessageOptions, AiProviderDefinition, AiProviderSettings } from './providers/definition.ts';
import { repoTools } from './repo-tools.ts';

/*
 * Shipcast is the agent: the AI task runner runs every task, whatever the provider, with the AI SDK.
 * A provider only answers model calls; the tool loop over the job's own checkout, the structured
 * answer, its validation and its one repair, the deadline, the errors and the counting are all here,
 * once. The exception is a provider that is itself an agent (Claudio's Claude Code, `repoAccess:
 * 'remote-workspace'`): it reads the repository with its own tools in a workspace on its side, which
 * the runner prepares from the repo's archive URL and releases at the end of the run, so the runner
 * gives it no tools and asks for the answer in the response format.
 */

/** The tool a model answers through when the answer cannot come as a response format */
export const SUBMIT_TOOL = 'submit_answer';

/**
 * How the model is told to finish. Forcing the call (`tool_choice` any/tool, the SDK's 'required')
 * is refused with a 400 by current Claude models (Opus 5.5, Sonnet 5.5, Fable 5.1) and is not
 * portable anyway, so every provider gets `auto` with this instruction, and the submit tool is strict
 * so its input follows the schema where the provider supports strict tools.
 */
const SUBMIT_INSTRUCTION = `When you have the answer, call the ${SUBMIT_TOOL} tool exactly once with the whole answer. Do not write the answer as text: only what ${SUBMIT_TOOL} receives is read.`;

/** What one task runs with: as the AI settings chose it, or as a caller passes it */
export interface AiRunSetup {
  provider: AiProviderDefinition;
  settings: AiProviderSettings;
  /** Empty for the provider's own default */
  model?: string;
  /**
   * The spend ceilings the owner set in the AI settings, by task id (`assistant-check` apart from
   * `assistant`); a task left out runs with its definition's default.
   */
  budgets?: Partial<Record<AiBudgetTask, number>>;
}

/** Where the runner reports how long each task took; the telemetry recorder is one */
export interface AiTelemetry {
  timing(sample: { kind: TimingKind; name: string; outcome: TimingOutcome; ms: number }): void;
}

export interface AiTaskRunnerDeps {
  /** The provider, its settings and model for one of the AI settings' tasks, read when the task runs */
  resolve(task: AiTask): Promise<AiRunSetup>;
  /** Where a remote agent's workspace downloads the repo from; needed only by a `remote-workspace` provider */
  archives?: RepoArchiveSource;
  telemetry?: AiTelemetry;
  /** The process's fetch, so the calls are counted like any other */
  fetch?: typeof fetch;
}

export interface AiRunInput {
  system?: string;
  /** The request, or the conversation so far */
  prompt?: string;
  messages?: ModelMessage[];
  /**
   * The repo a task reads, at its ref. A `local-tools` provider reads the job's checkout on this
   * machine (`hostDir`); a `remote-workspace` one, a workspace made from the repo's archive, so it
   * needs no checkout.
   */
  repo?: { name: string; ref: string; hostDir?: string };
  abortSignal?: AbortSignal;
  /**
   * This run's own ceilings over the task's, for an evaluation or a test. A spend ceiling the owner
   * set for the task in the AI settings still wins; there is no other budget (the single runtime
   * one, SHIPCAST_MAX_BUDGET_USD, is gone).
   */
  limits?: Partial<AiTaskLimits>;
  /** Told of every tool call and every model call as they happen: how an evaluation sees a run */
  observer?: AiRunObserver;
}

/** What a run did, step by step */
export interface AiRunObserver {
  toolCall?(call: { name: string; input: unknown }): void;
  /** One model call's tokens, the cached ones included */
  step?(usage: LanguageModelUsage): void;
}

/** Tokens over every model call of a run, the repair included */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiRunResult<T> {
  /** The answer, validated against the task's schema */
  output: T;
  usage: AiUsage;
  /** Model calls made, tool rounds and the repair included */
  steps: number;
  /** Whether the first answer was invalid and the repair's was used */
  repaired: boolean;
  provider: string;
  model: string;
  /** What the provider reported on its last call (Claudio's chat id and cost, under `claudio`) */
  providerMetadata?: ProviderMetadata;
}

export interface AiTextStream {
  /** The text as it comes; ends with an AiError when the call fails */
  textStream: AsyncIterable<string>;
  /** Settles once the stream has been read to its end */
  result: Promise<{ text: string; usage: AiUsage; provider: string; model: string }>;
}

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

function add(sum: AiUsage, usage: LanguageModelUsage | undefined): AiUsage {
  const input = usage?.inputTokens ?? 0;
  const output = usage?.outputTokens ?? 0;
  return { inputTokens: sum.inputTokens + input, outputTokens: sum.outputTokens + output, totalTokens: sum.totalTokens + (usage?.totalTokens ?? input + output) };
}

const problemsOf = (issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string =>
  issues.map((i) => `${i.path.map(String).join('.') || 'answer'}: ${i.message}`).join('; ');

/** One prepared run: everything a model call needs, decided once from the task, the provider and the input */
interface Plan {
  task: AiTaskDefinition<unknown>;
  setup: AiRunSetup;
  modelId: string;
  limits: AiTaskLimits;
  tools: ToolSet;
  /** The repo a remote agent reads in a workspace of its own, prepared for the run */
  remoteRepo: { name: string; ref: string } | undefined;
  /** What the provider's call options are made of, but the workspace, which is known once it is prepared */
  call: AiCallContext;
  /** A message rather than a string when the provider caches it */
  system: string | SystemModelMessage | undefined;
  messages: ModelMessage[];
  /** The provider's own, its cache breakpoint on a run with tools, and its call options once the workspace is known */
  providerOptions: AiMessageOptions | undefined;
  observer: AiRunObserver | undefined;
  signal: AbortSignal;
  /** The run's own deadline, to tell it from the caller's abort */
  deadline: AbortSignal;
  secrets: string[];
}

/** What one streamed call gave */
interface Called {
  text: string;
  steps: number;
  usage: LanguageModelUsage | undefined;
  /** The assistant's and the tools' messages, to continue the conversation with */
  responseMessages: ModelMessage[];
  /** The submit tool's call, when the model made one */
  submitted?: { toolCallId: string; input: unknown };
  providerMetadata: ProviderMetadata | undefined;
}

export class AiTaskRunner {
  readonly #deps: AiTaskRunnerDeps;

  constructor(deps: AiTaskRunnerDeps) {
    this.#deps = deps;
  }

  /**
   * Runs a task with a structured answer and returns it validated. With client tools (the repo's, on
   * a `local-tools` provider) or a provider with no response format, the answer is the input of the
   * submit tool, and the loop stops at that call or at the task's step ceiling; otherwise it is the
   * response format's JSON. An invalid answer is sent back once with what is wrong.
   */
  async run<T>(task: AiTaskDefinition<T>, input: AiRunInput, setup?: AiRunSetup): Promise<AiRunResult<T>> {
    const output = task.output;
    if (!output) throw new Error(`${task.id} answers with text: stream it`);
    const plan = await this.#plan(task as AiTaskDefinition<unknown>, input, setup);
    return this.#timed(plan, () => this.#prepared(plan, async (plan) => {
      const submit = Object.keys(plan.tools).length > 0 || plan.setup.provider.capabilities.structuredOutput === 'none';
      let usage = NO_USAGE;
      let steps = 0;

      const first = submit ? await this.#submitCall(plan, plan.messages, false) : await this.#nativeCall(plan, plan.messages);
      usage = add(usage, first.usage);
      steps += first.steps;
      let last = first.providerMetadata;
      // The conversation is worth reading when the answer is what failed: the error carries where it is
      const chat = () => chatIdIn(last, plan.setup.provider.id);
      if (submit && !first.submitted && first.steps >= plan.limits.maxSteps) {
        throw new AiError('ai_no_answer', `the ${plan.setup.provider.name} used all ${plan.limits.maxSteps} steps of ${task.id} without answering`, { provider: plan.setup.provider.id, ...withChat(chat()) });
      }
      const checked = check(output.schema, submit ? first.submitted?.input : parseJson(first.text));
      const done = (value: T, repaired: boolean): AiRunResult<T> => ({ output: value, usage, steps, repaired, provider: plan.setup.provider.id, model: plan.modelId, ...(last && { providerMetadata: last }) });
      if (checked.ok) return done(checked.value, false);

      // One repair: the answer goes back with what is wrong with it, and only the answer may follow
      const why = first.submitted || !submit ? `That answer is not valid: ${checked.problems}. Answer again, the whole answer, following the schema.` : `You ended without calling ${SUBMIT_TOOL}. Call it now with the whole answer.`;
      const conversation: ModelMessage[] = [...plan.messages, ...first.responseMessages];
      if (first.submitted) conversation.push({ role: 'tool', content: [{ type: 'tool-result', toolCallId: first.submitted.toolCallId, toolName: SUBMIT_TOOL, output: { type: 'error-text', value: why } }] });
      else conversation.push({ role: 'user', content: why });
      const second = submit ? await this.#submitCall(plan, conversation, true) : await this.#nativeCall(plan, conversation);
      usage = add(usage, second.usage);
      steps += second.steps;
      last = second.providerMetadata ?? last;
      const again = check(output.schema, submit ? second.submitted?.input : parseJson(second.text));
      if (again.ok) return done(again.value, true);
      throw new AiError('ai_invalid_output', `the ${plan.setup.provider.name}'s answer to ${task.id} is not valid, even after a repair: ${again.problems}`.slice(0, 2000), { provider: plan.setup.provider.id, ...withChat(chat()) });
    }));
  }

  /** Runs a task that answers with text, streamed as it comes */
  stream(task: AiTaskDefinition<unknown>, input: AiRunInput, setup?: AiRunSetup): AiTextStream {
    let settle!: { resolve: (value: Awaited<AiTextStream['result']>) => void; reject: (error: unknown) => void };
    const result = new Promise<Awaited<AiTextStream['result']>>((resolve, reject) => (settle = { resolve, reject }));
    // Read only through the stream: an unread result must not be an unhandled rejection
    result.catch(() => undefined);
    const runner = this;
    async function* text(): AsyncGenerator<string> {
      const chunks: string[] = [];
      try {
        const plan = await runner.#plan(task, input, setup);
        const queue: string[] = [];
        let wake: (() => void) | undefined;
        let finished = false;
        const call = runner
          .#timed(plan, () =>
            runner.#prepared(plan, (prepared) =>
              runner.#call(prepared, prepared.messages, { stopWhen: stepCountIs(1) }, (delta) => {
                queue.push(delta);
                wake?.();
              }),
            ),
          )
          .finally(() => {
            finished = true;
            wake?.();
          });
        // The text is yielded while the call runs; the call's own failure is thrown after what came
        call.catch(() => undefined);
        while (!finished || queue.length > 0) {
          if (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          while (queue.length > 0) {
            const delta = queue.shift()!;
            chunks.push(delta);
            yield delta;
          }
        }
        const called = await call;
        settle.resolve({ text: chunks.join(''), usage: add(NO_USAGE, called.usage), provider: plan.setup.provider.id, model: plan.modelId });
      } catch (error) {
        settle.reject(error);
        throw error;
      }
    }
    return { textStream: text(), result };
  }

  async #plan(task: AiTaskDefinition<unknown>, input: AiRunInput, given?: AiRunSetup): Promise<Plan> {
    if (task.needsRepo === 'always' && !input.repo) throw new Error(`${task.id} reads the repository: its checkout is missing`);
    const setup = given ?? (await this.#deps.resolve(task.settingsTask));
    const { provider, settings } = setup;
    const budget = budgetOf(task.id, setup.budgets);
    const limits: AiTaskLimits = { ...task.limits, ...input.limits, ...(budget !== undefined && { maxBudgetUsd: budget }) };
    const repo = task.needsRepo === 'never' ? undefined : input.repo;
    const remote = provider.capabilities.repoAccess === 'remote-workspace';
    if (repo && !remote && !repo.hostDir) throw new Error(`${task.id} reads the repository with the ${provider.name}'s tools: its checkout is missing`);
    // A remote agent reads the repo in a workspace of its own, prepared when the run starts; the others get tools here
    const tools: ToolSet = repo?.hostDir && !remote ? repoTools(repo.hostDir) : {};
    // The budget reaches only a provider that can be told one (callOptions: Claudio's maxBudgetUsd). The
    // others (the Anthropic API, OpenAI, OpenAI-compatible servers) bill per token and take no spend
    // ceiling on a call, so nothing is sent to them: their run is bounded by the steps, output
    // tokens and timeout Shipcast enforces itself.
    const call: AiCallContext = {
      task: task.id,
      limits: { ...(limits.maxTurns !== undefined && { maxTurns: limits.maxTurns }), maxBudgetUsd: limits.maxBudgetUsd },
    };
    const deadline = AbortSignal.timeout(limits.timeoutMs);
    const messages: ModelMessage[] = input.messages ?? [{ role: 'user', content: input.prompt ?? '' }];
    const secrets = provider.settings.filter((f) => f.secret).map((f) => settings[f.key] ?? '').filter(Boolean);
    // A tool loop resends the same tools, system prompt and history on every step: cached, a step pays for what it adds
    const caching = Object.keys(tools).length > 0 ? provider.capabilities.promptCaching : undefined;
    const system = caching && input.system !== undefined ? { role: 'system' as const, content: input.system, providerOptions: caching.system } : input.system;
    const providerOptions = caching ? mergeOptions(provider.providerOptions, caching.call) : provider.providerOptions;
    return {
      task,
      setup,
      modelId: setup.model || provider.defaultModel(settings),
      limits,
      tools,
      remoteRepo: repo && remote ? { name: repo.name, ref: repo.ref } : undefined,
      call,
      system,
      messages,
      providerOptions,
      observer: input.observer,
      signal: input.abortSignal ? AbortSignal.any([deadline, input.abortSignal]) : deadline,
      deadline,
      secrets,
    };
  }

  /**
   * The run with the provider's call options, in a workspace of its own for a remote agent that reads
   * the repo: made from the repo's archive URL (GitHub's codeload, so no GitHub token reaches the
   * provider) and released however the run ends. A release that fails is left to the workspace's
   * own expiry: it must not hide the run's outcome.
   */
  async #prepared<R>(plan: Plan, work: (plan: Plan) => Promise<R>): Promise<R> {
    const { provider, settings } = plan.setup;
    const withCall = (workspace?: AiCallContext['workspace']): Plan => {
      const own = provider.callOptions?.({ ...plan.call, ...(workspace && { workspace }) });
      return { ...plan, providerOptions: own ? mergeOptions(plan.providerOptions, own) : plan.providerOptions };
    };
    if (!plan.remoteRepo) return work(withCall());
    const workspaces = provider.workspaces?.(settings, this.#deps.fetch ? { fetch: this.#deps.fetch } : {});
    if (!workspaces) throw new Error(`the ${provider.name} reads the repository on its side but has no workspaces`);
    if (!this.#deps.archives) throw new Error(`the ${provider.name} reads the repository from its archive: the runner has no archive source`);
    const url = await this.#deps.archives.tarballUrl(plan.remoteRepo.name, plan.remoteRepo.ref);
    const { id } = await workspaces.prepare({ url }, plan.signal);
    try {
      return await work(withCall({ id, allowedTools: ANALYSIS_RULES }));
    } finally {
      await workspaces.release(id).catch(() => undefined);
    }
  }

  /** Times the run under its task and provider, and turns its failure into an AiError */
  async #timed<R>(plan: Plan, work: () => Promise<R>): Promise<R> {
    const started = performance.now();
    const name = `ai:${plan.task.id}:${plan.setup.provider.id}`;
    try {
      const result = await work();
      this.#deps.telemetry?.timing({ kind: 'fn', name, outcome: 'ok', ms: performance.now() - started });
      return result;
    } catch (raw) {
      const error = toAiError(raw, {
        provider: plan.setup.provider,
        secrets: plan.secrets,
        ...(plan.deadline.aborted && { timedOut: { ms: plan.limits.timeoutMs } }),
        aborted: plan.signal.aborted,
      });
      this.#deps.telemetry?.timing({ kind: 'fn', name, outcome: error instanceof AiError && error.retryable ? 'retry' : 'error', ms: performance.now() - started });
      throw error;
    }
  }

  /** The answer in the response format: no client tools, one step */
  #nativeCall(plan: Plan, messages: ModelMessage[]): Promise<Called> {
    const output = plan.task.output!;
    return this.#call(plan, messages, {
      output: Output.object({ schema: jsonSchema(output.jsonSchema() as JSONSchema7), name: output.name }),
      stopWhen: stepCountIs(1),
    });
  }

  /** The answer as the submit tool's input, after as many tool rounds as the task allows; a repair may only submit */
  #submitCall(plan: Plan, messages: ModelMessage[], repair: boolean): Promise<Called> {
    const output = plan.task.output!;
    const submit = tool({
      description: 'Submit the final answer. Call it once, with the whole answer, when you are done; nothing after it is read.',
      inputSchema: jsonSchema(output.jsonSchema() as JSONSchema7),
      strict: true,
    });
    const tools: ToolSet = repair ? { [SUBMIT_TOOL]: submit } : { ...plan.tools, [SUBMIT_TOOL]: submit };
    return this.#call(plan, messages, {
      tools,
      toolChoice: 'auto',
      instruction: SUBMIT_INSTRUCTION,
      stopWhen: repair ? stepCountIs(1) : [hasToolCall(SUBMIT_TOOL), stepCountIs(plan.limits.maxSteps)],
    });
  }

  /**
   * One streamed call. Always streamed, even for a structured answer: a long turn sends nothing for
   * minutes otherwise, and Node's fetch gives up on headers after 300 s. No retries of the SDK's own:
   * the job queue retries a retryable AiError.
   */
  async #call(
    plan: Plan,
    messages: ModelMessage[],
    options: { tools?: ToolSet; toolChoice?: 'auto'; instruction?: string; stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>; output?: OutputInterface },
    onText?: (delta: string) => void,
  ): Promise<Called> {
    const { provider, settings } = plan.setup;
    const model = provider.model(settings, plan.setup.model, this.#deps.fetch ? { fetch: this.#deps.fetch } : {});
    const result = streamText({
      model,
      ...(withInstruction(plan.system, options.instruction) !== undefined && { system: withInstruction(plan.system, options.instruction)! }),
      messages,
      maxOutputTokens: plan.limits.maxOutputTokens,
      maxRetries: 0,
      abortSignal: plan.signal,
      stopWhen: options.stopWhen,
      ...(options.tools && { tools: options.tools }),
      ...(options.toolChoice && { toolChoice: options.toolChoice }),
      ...(options.output && { output: options.output }),
      ...(plan.providerOptions && { providerOptions: plan.providerOptions }),
      // The failure is read from the stream below; the default handler would only log it
      onError: () => undefined,
    });
    let failure: { error: unknown } | undefined;
    let submitted: Called['submitted'];
    let text = '';
    for await (const part of result.fullStream) {
      if (part.type === 'error') failure = { error: part.error };
      else if (part.type === 'text-delta') {
        text += part.text;
        onText?.(part.text);
      } else if (part.type === 'tool-call') {
        plan.observer?.toolCall?.({ name: part.toolName, input: part.input });
        if (part.toolName === SUBMIT_TOOL) submitted = { toolCallId: part.toolCallId, input: part.input };
      } else if (part.type === 'finish-step') plan.observer?.step?.(part.usage);
    }
    if (plan.signal.aborted) throw plan.signal.reason ?? new Error('aborted');
    if (failure) throw failure.error;
    const [steps, usage, response, providerMetadata] = await Promise.all([result.steps, result.totalUsage, result.response, result.providerMetadata]);
    return { text, steps: steps.length, usage, responseMessages: response.messages, providerMetadata, ...(submitted && { submitted }) };
  }
}

/** The owner's ceiling for a task, when the task is one the AI settings budget and the owner set one */
function budgetOf(taskId: string, budgets: AiRunSetup['budgets']): number | undefined {
  return (AI_BUDGET_TASKS as readonly string[]).includes(taskId) ? budgets?.[taskId as AiBudgetTask] : undefined;
}

/** A provider's conversation id in a call's metadata, under the provider's own key (`providerMetadata.claudio.chatId`) */
function chatIdIn(metadata: ProviderMetadata | undefined, provider: string): string | undefined {
  const chatId = metadata?.[provider]?.chatId;
  return typeof chatId === 'string' && chatId ? chatId : undefined;
}

const withChat = (chatId: string | undefined) => (chatId ? { chatId } : {});

/**
 * Where to read a run's whole conversation, when its provider keeps one (Claudio's chat): from the
 * result of a run, or from the AiError of one whose answer was what failed. What the old path
 * recorded as `claudio chat: <id>` beside a failed launch's problems.
 */
export function chatIdOf(outcome: Pick<AiRunResult<unknown>, 'provider' | 'providerMetadata'> | unknown): string | undefined {
  if (outcome instanceof AiError) return outcome.chatId;
  if (typeof outcome !== 'object' || outcome === null || !('provider' in outcome) || typeof outcome.provider !== 'string') return undefined;
  const metadata = 'providerMetadata' in outcome ? (outcome.providerMetadata as ProviderMetadata | undefined) : undefined;
  return chatIdIn(metadata, outcome.provider);
}

/**
 * What a run cost, when its provider says (Claudio's turn cost, `providerMetadata.claudio.costUsd`):
 * the old path's `costUsd`, kept for the records only and never shown. Null when the provider does not say.
 */
export function costOf(result: Pick<AiRunResult<unknown>, 'provider' | 'providerMetadata'>): number | null {
  const cost = result.providerMetadata?.[result.provider]?.costUsd;
  return typeof cost === 'number' ? cost : null;
}

/** Two sets of provider options as one, per provider: a cache breakpoint beside the provider's own options */
function mergeOptions(a: AiMessageOptions | undefined, b: AiMessageOptions): AiMessageOptions {
  const out: AiMessageOptions = { ...a };
  for (const [provider, options] of Object.entries(b)) out[provider] = { ...out[provider], ...options };
  return out;
}

function parseJson(text: string): unknown {
  // A model may fence its JSON even when asked for the response format
  const trimmed = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1');
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function check<T>(schema: z.ZodType<T>, value: unknown): { ok: true; value: T } | { ok: false; problems: string } {
  if (value === undefined) return { ok: false, problems: 'no JSON answer' };
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, problems: problemsOf(parsed.error.issues) };
}

/**
 * The task's system prompt with a standing instruction after it; kept a constant suffix, so a cached
 * system prompt stays a stable prefix. The SDK takes system text only here, never inside `messages`.
 */
function withInstruction(system: string | SystemModelMessage | undefined, instruction: string | undefined): string | SystemModelMessage | undefined {
  if (!instruction) return system;
  if (system === undefined) return instruction;
  if (typeof system === 'string') return `${system}\n\n${instruction}`;
  return { ...system, content: `${system.content}\n\n${instruction}` };
}
