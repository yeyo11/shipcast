import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import { InvalidArgumentError, wrapLanguageModel, type LanguageModelMiddleware, type ProviderMetadata } from 'ai';
import { z } from 'zod';

/*
 * Claudio as an AI SDK provider: a language model over Claudio's OpenAI-compatible `/api/v1`, whose
 * own features are asked for the SDK's way, as `providerOptions.claudio` on a call, and come back the
 * SDK's way, as `providerMetadata.claudio` on its result. The chat model itself is the SDK's
 * OpenAI-compatible one; this wraps it with a middleware that turns the options into Claudio's
 * request headers (the only way its /v1 takes them) and reads its response header back.
 */

/**
 * Claudio's wire names, in one place. There is no header for a new chat: a request whose history has
 * no assistant message always starts one (retries included), and the workspace, allowed tools and
 * ceilings are part of the chat's key, so continuing a chat with other values is refused (409).
 */
export const CLAUDIO_WIRE = {
  workspace: 'X-Claudio-Workspace',
  maxTurns: 'X-Claudio-Max-Turns',
  maxBudgetUsd: 'X-Claudio-Max-Budget-Usd',
  allowedTools: 'X-Claudio-Allowed-Tools',
  toolPreset: 'X-Claudio-Tool-Preset',
  /** Response header: the chat Claudio ran the call in */
  chatId: 'x-claudio-chat-id',
} as const;

/**
 * `providerOptions.claudio`: where Claude Code works (a workspace's id, from ClaudioWorkspaces), what
 * it may run there (Claude Code permission rules, or the name of one of Claudio's presets, never
 * both), and its own ceilings. Without a budget Claudio applies its own default (1 USD), so a caller
 * that knows its ceiling sends it.
 */
export const ClaudioCallOptions = z
  .strictObject({
    workspace: z.string().min(1).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    toolPreset: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
  })
  .refine((o) => !(o.allowedTools && o.toolPreset), { message: 'allowedTools and toolPreset are exclusive: Claudio refuses both together', path: ['toolPreset'] });
export type ClaudioCallOptions = z.infer<typeof ClaudioCallOptions>;

/** What Claudio reports back on a call, as `providerMetadata.claudio` */
export interface ClaudioCallMetadata {
  chatId?: string;
  /** What the call cost on the subscription's meter, when Claudio says */
  costUsd?: number;
}

const OWN_KEYS = Object.keys(ClaudioCallOptions.shape) as ReadonlyArray<keyof ClaudioCallOptions>;

/** Claudio's request headers for a call's options */
export function claudioHeaders(options: ClaudioCallOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.workspace !== undefined) headers[CLAUDIO_WIRE.workspace] = options.workspace;
  if (options.allowedTools !== undefined) headers[CLAUDIO_WIRE.allowedTools] = JSON.stringify(options.allowedTools);
  if (options.toolPreset !== undefined) headers[CLAUDIO_WIRE.toolPreset] = options.toolPreset;
  if (options.maxTurns !== undefined) headers[CLAUDIO_WIRE.maxTurns] = String(options.maxTurns);
  if (options.maxBudgetUsd !== undefined) {
    // Claudio refuses a budget with more than 6 decimals; float arithmetic can produce one
    headers[CLAUDIO_WIRE.maxBudgetUsd] = String(Number(options.maxBudgetUsd.toFixed(6)));
  }
  return headers;
}

type Params = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];

/**
 * A call's `claudio` options split from the rest. Only Claudio's own keys are taken out: the
 * OpenAI-compatible model sends any other key under `claudio` in the request body (and reads
 * `user`, `strictJsonSchema`…), which must keep working, while Claudio's must never reach the body.
 */
function takeOptions(params: Params): { options: ClaudioCallOptions; params: Params } {
  const given = params.providerOptions?.claudio;
  if (!given) return { options: {}, params };
  const own: Record<string, unknown> = {};
  const rest: Record<string, (typeof given)[string]> = {};
  for (const [key, value] of Object.entries(given)) {
    if ((OWN_KEYS as readonly string[]).includes(key)) own[key] = value;
    else rest[key] = value;
  }
  const parsed = ClaudioCallOptions.safeParse(own);
  if (!parsed.success) {
    throw new InvalidArgumentError({ parameter: 'providerOptions.claudio', value: own, message: parsed.error.issues.map((i) => `${i.path.join('.') || 'claudio'}: ${i.message}`).join('; ') });
  }
  const { claudio: _taken, ...others } = params.providerOptions ?? {};
  const providerOptions = Object.keys(rest).length > 0 ? { ...others, claudio: rest } : others;
  return { options: parsed.data, params: { ...params, providerOptions } };
}

function withCallMetadata(metadata: ProviderMetadata | undefined, headers: Readonly<Record<string, string | undefined>> | undefined): ProviderMetadata | undefined {
  const chatId = headers?.[CLAUDIO_WIRE.chatId];
  if (!chatId) return metadata;
  return { ...metadata, claudio: { ...metadata?.claudio, chatId } };
}

/**
 * The turn's own cost Claudio reports in `usage.cost_usd` (Claudio's headless contract): on a whole
 * response, and on a streamed answer's final usage chunk, which is only sent with `include_usage`.
 * Not Claude Code's `total_cost_usd`, which is the process's running total.
 */
function costOf(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || !('usage' in body)) return undefined;
  const usage = body.usage;
  if (typeof usage !== 'object' || usage === null || !('cost_usd' in usage)) return undefined;
  return typeof usage.cost_usd === 'number' ? usage.cost_usd : undefined;
}

const costMetadata = (cost: number | undefined) => (cost === undefined ? undefined : { claudio: { costUsd: cost } });

const costExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => costMetadata(costOf(parsedBody)),
  createStreamExtractor: () => {
    let cost: number | undefined;
    return {
      processChunk: (chunk) => {
        cost = costOf(chunk) ?? cost;
      },
      buildMetadata: () => costMetadata(cost),
    };
  },
};

const claudioMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => {
    const { options, params: rest } = takeOptions(params);
    return { ...rest, headers: { ...rest.headers, ...claudioHeaders(options) } };
  },
  wrapGenerate: async ({ doGenerate }) => {
    const result = await doGenerate();
    const providerMetadata = withCallMetadata(result.providerMetadata, result.response?.headers);
    return { ...result, ...(providerMetadata && { providerMetadata }) };
  },
  wrapStream: async ({ doStream }) => {
    const result = await doStream();
    const headers = result.response?.headers;
    if (!headers?.[CLAUDIO_WIRE.chatId]) return result;
    type Part = typeof result.stream extends ReadableStream<infer P> ? P : never;
    // The chat id is known from the headers, before any chunk; it rides on the finish part, where the SDK reads metadata
    const stream = result.stream.pipeThrough(
      new TransformStream<Part, Part>({
        transform(part, controller) {
          if (part.type === 'finish') {
            const providerMetadata = withCallMetadata(part.providerMetadata, headers);
            controller.enqueue({ ...part, ...(providerMetadata && { providerMetadata }) });
          } else controller.enqueue(part);
        },
      }),
    );
    return { ...result, stream };
  },
};

export interface ClaudioProviderSettings {
  /** Claudio's address, without `/api/v1` */
  baseURL: string;
  /** Claudio's API token, sent as a Bearer token */
  token: string;
  fetch?: typeof fetch;
}

/** A Claudio model, as the AI SDK takes it */
export type ClaudioLanguageModel = ReturnType<typeof wrapLanguageModel>;

export interface ClaudioProvider {
  (modelId?: string): ClaudioLanguageModel;
  languageModel(modelId?: string): ClaudioLanguageModel;
}

/** Its model catalog names its own default `default` */
export const CLAUDIO_DEFAULT_MODEL = 'default';

/**
 * Claudio as an AI SDK provider. Its chat completions take a response format with a JSON Schema
 * even while Claude Code uses its own tools (only client tools beside a response format are refused).
 */
export function createClaudio(settings: ClaudioProviderSettings): ClaudioProvider {
  const openai = createOpenAICompatible({
    name: 'claudio',
    baseURL: `${settings.baseURL.replace(/\/+$/, '')}/api/v1`,
    apiKey: settings.token,
    supportsStructuredOutputs: true,
    // stream_options.include_usage: the final chunk carries the tokens and the turn's cost
    includeUsage: true,
    metadataExtractor: costExtractor,
    ...(settings.fetch && { fetch: settings.fetch }),
  });
  const languageModel = (modelId?: string): ClaudioLanguageModel =>
    wrapLanguageModel({ model: openai.chatModel(modelId || CLAUDIO_DEFAULT_MODEL), middleware: claudioMiddleware });
  return Object.assign(languageModel, { languageModel });
}
