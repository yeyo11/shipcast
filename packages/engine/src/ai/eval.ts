import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AI_TASK_DEFINITIONS,
  channelName,
  COMMENT_CHANNELS,
  ContentPack,
  formatIssues,
  missingPieces,
  parseLaunchConfig,
  REPLY_LIMITS,
  resolvePack,
  type AiTaskDefinition,
  type Brand,
  type CommentChannelId,
  type LaunchConfig,
} from '@shipcast/schema';
import { z } from 'zod';
import { LAUNCH_CONFIG_PATH } from '../detect.ts';
import { buildPrompt, buildReplyPrompt, type ReplyPromptInput } from '../prompt.ts';
import type { Launch } from '../repositories/index.ts';
import { redact } from './errors.ts';
import type { AiProviderDefinition, AiProviderSettings, RepoAccess } from './providers/definition.ts';
import type { AiRunSetup, AiTaskRunner } from './runner.ts';

/*
 * The A/B evaluation of the AI layer: the same real cases (a release's content pack, a reply to a
 * comment) run through the AiTaskRunner with one provider and one way of reaching the repo, and
 * recorded with what a person needs to judge them side by side: the answer, the steps, every tool
 * call, the time and the tokens. The prompts are built by the functions production builds them with
 * (buildPrompt, buildReplyPrompt), so a case measures what a launch would get. Driven by
 * scripts/ai-eval.ts, which refuses to call a provider unless told to in so many words.
 */

const RepoName = z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'owner/name');
const AnalysisInput = z.strictObject({
  summary: z.string(),
  implemented: z.array(z.string()),
  planned: z.array(z.string()),
  documentedOnly: z.array(z.string()),
  limitations: z.array(z.string()),
});
type Analysis = z.infer<typeof AnalysisInput>;

const common = {
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'lowercase letters, digits, dots and hyphens: it names the output file'),
  repo: RepoName,
  ref: z.string().min(1),
  /** What a reader of the cases file should know about the case: where it comes from, what to replace */
  note: z.string().optional(),
};

export const EvalCase = z.discriminatedUnion('task', [
  z.strictObject({
    ...common,
    task: z.literal('pack'),
    /** The release before this one, for the pack's kind; none for a first launch */
    previous: z.string().optional(),
    /** launch.yml as the case wants it; the checkout's own when absent (an old one may not parse today) */
    launchYml: z.string().optional(),
  }),
  z.strictObject({
    ...common,
    task: z.literal('reply'),
    channel: z.enum(COMMENT_CHANNELS as readonly CommentChannelId[] as [CommentChannelId, ...CommentChannelId[]]),
    comment: z.strictObject({ author: z.string().min(1), text: z.string().min(1) }),
    thread: z.array(z.strictObject({ author: z.string(), text: z.string(), own: z.boolean() })).default([]),
    post: z.strictObject({ text: z.string().optional(), url: z.string().optional() }).default({}),
    /** The launch's analysis, as the registry would have it */
    analysis: AnalysisInput.optional(),
    /** Or the analysis of a pack case earlier in the same run, when that run answered it */
    analysisFrom: z.string().optional(),
  }),
]);
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalCases = z
  .strictObject({
    /** Where the brand's brand.yml is, read like the pipeline reads it */
    brand: z.strictObject({ repo: RepoName, ref: z.string().default('HEAD'), path: z.string().default('brand.yml') }),
    cases: z.array(EvalCase).min(1),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `${c.id} is used twice` });
      if (c.task === 'reply' && c.analysisFrom !== undefined && !value.cases.slice(0, i).some((p) => p.id === c.analysisFrom && p.task === 'pack')) {
        ctx.addIssue({ code: 'custom', path: ['cases', i, 'analysisFrom'], message: `${c.analysisFrom} is not a pack case before this one` });
      }
      seen.add(c.id);
    });
  });
export type EvalCases = z.infer<typeof EvalCases>;

/** The cases file, parsed, or an error naming every problem with its path */
export function loadEvalCases(text: string): EvalCases {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`the cases file is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = EvalCases.safeParse(json);
  if (!parsed.success) throw new Error(`the cases file is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'file'}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

/** One tool call as recorded: its name and a short form of its arguments */
export interface EvalToolCall {
  name: string;
  args: string;
}

export interface EvalUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What one case's run gave: written as `<case>.json` and listed in `summary.json` */
export interface EvalRecord {
  case: string;
  task: EvalCase['task'];
  repo: string;
  ref: string;
  provider: string;
  model: string;
  access: RepoAccess;
  ok: boolean;
  error?: string;
  output?: unknown;
  /** What production would refuse in a valid answer: a pack's missing pieces */
  problems: string[];
  steps: number;
  repaired: boolean;
  toolCalls: EvalToolCall[];
  wallMs: number;
  usage: EvalUsage;
}

const ARGS_CHARS = 300;

/** A tool call's arguments in a line: the paths and ranges of a read, the pattern of a search, else the JSON */
export function summarizeArgs(name: string, input: unknown): string {
  const files = z.object({ files: z.array(z.object({ path: z.string(), from: z.number().optional(), to: z.number().optional() })) }).safeParse(input);
  if (name === 'read_files' && files.success) {
    return files.data.files.map((f) => (f.from || f.to ? `${f.path}:${f.from ?? 1}-${f.to ?? ''}` : f.path)).join(', ').slice(0, ARGS_CHARS);
  }
  if (name === 'submit_answer') return '(the answer)';
  const json = JSON.stringify(input) ?? '';
  return json.length > ARGS_CHARS ? `${json.slice(0, ARGS_CHARS)}…` : json;
}

/** The provider as the case runs it: its own way of reaching the repo, or the one the evaluation compares */
export function withAccess(provider: AiProviderDefinition, access: RepoAccess | undefined): AiProviderDefinition {
  return access === undefined || access === provider.capabilities.repoAccess ? provider : { ...provider, capabilities: { ...provider.capabilities, repoAccess: access } };
}

/**
 * The provider's settings from the environment, never from the owner's keychain: a secret field takes
 * SHIPCAST_EVAL_PROVIDER_TOKEN, a URL field SHIPCAST_EVAL_PROVIDER_URL, a `model` field
 * SHIPCAST_EVAL_MODEL, and any field SHIPCAST_EVAL_PROVIDER_<KEY> (baseUrl → _BASE_URL).
 */
export function evalSettings(provider: AiProviderDefinition, env: Readonly<Record<string, string | undefined>>): AiProviderSettings {
  const settings: Record<string, string | undefined> = {};
  for (const field of provider.settings) {
    const own = env[`SHIPCAST_EVAL_PROVIDER_${field.key.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`];
    const shared = field.secret ? env.SHIPCAST_EVAL_PROVIDER_TOKEN : /url/i.test(field.key) ? env.SHIPCAST_EVAL_PROVIDER_URL : field.key === 'model' ? env.SHIPCAST_EVAL_MODEL : undefined;
    settings[field.key] = own ?? shared;
  }
  return settings;
}

/** What one case is asked with */
interface Asked {
  task: AiTaskDefinition<unknown>;
  system: string;
  prompt: string;
  /** For a pack: the launch.yml it is checked against */
  config?: LaunchConfig;
}

async function launchConfigOf(c: Extract<EvalCase, { task: 'pack' }>, checkoutDir: string): Promise<LaunchConfig> {
  const text = c.launchYml ?? (await readFile(join(checkoutDir, LAUNCH_CONFIG_PATH), 'utf8').catch(() => undefined));
  if (text === undefined) throw new Error(`${c.repo}@${c.ref} has no ${LAUNCH_CONFIG_PATH}: give the case a launchYml`);
  const parsed = parseLaunchConfig(text);
  if (!parsed.ok) throw new Error(`the launch.yml of ${c.id} is invalid:\n${formatIssues('launch.yml', parsed.issues)}`);
  return parsed.value;
}

/** The case's prompt, built by the functions production builds it with */
export async function askFor(c: EvalCase, brand: Brand, checkoutDir: string, analyses: ReadonlyMap<string, Analysis>): Promise<Asked> {
  if (c.task === 'pack') {
    const config = await launchConfigOf(c, checkoutDir);
    const now = new Date().toISOString();
    const launch: Launch = { id: 0, repo: c.repo, ref: c.ref, trigger: 'manual', kind: resolvePack(config, c.ref, c.previous), brand: brand.id, status: 'generating', detail: null, createdAt: now, updatedAt: now };
    return { task: AI_TASK_DEFINITIONS.pack as AiTaskDefinition<unknown>, config, ...buildPrompt(launch, config, brand) };
  }
  const analysis = c.analysis ?? (c.analysisFrom !== undefined ? analyses.get(c.analysisFrom) : undefined);
  const input: ReplyPromptInput = {
    network: channelName(c.channel),
    limit: REPLY_LIMITS[c.channel],
    comment: c.comment,
    thread: c.thread,
    post: { ...(c.post.text !== undefined && { text: c.post.text }), url: c.post.url ?? null },
    launch: { repo: c.repo, ref: c.ref, article: false },
    ...(analysis && { analysis }),
    hasCode: true,
  };
  return { task: AI_TASK_DEFINITIONS.replies as AiTaskDefinition<unknown>, ...buildReplyPrompt(input, brand) };
}

export interface EvalRunOptions {
  runner: AiTaskRunner;
  setup: AiRunSetup;
  brand: Brand;
  /** The case's checkout on this machine; called once per repo and ref */
  checkout(repo: string, ref: string): Promise<string>;
  /** Where the records go: one JSON per case and summary.json */
  outDir: string;
  /** Progress lines; never a setting */
  log?: (line: string) => void;
  clock?: () => number;
}

const NO_USAGE: EvalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Runs the cases one after another, records each as it ends, and returns the records */
export async function runEval(cases: readonly EvalCase[], options: EvalRunOptions): Promise<EvalRecord[]> {
  const { runner, setup, brand, outDir } = options;
  const clock = options.clock ?? (() => performance.now());
  const secrets = setup.provider.settings.filter((f) => f.secret).map((f) => setup.settings[f.key] ?? '');
  const checkouts = new Map<string, Promise<string>>();
  const analyses = new Map<string, Analysis>();
  const records: EvalRecord[] = [];
  await mkdir(outDir, { recursive: true });

  for (const c of cases) {
    options.log?.(`${c.id}: ${c.task} of ${c.repo}@${c.ref}`);
    const toolCalls: EvalToolCall[] = [];
    const usage: EvalUsage = { ...NO_USAGE };
    let modelCalls = 0;
    const record: EvalRecord = {
      case: c.id,
      task: c.task,
      repo: c.repo,
      ref: c.ref,
      provider: setup.provider.id,
      model: setup.model || setup.provider.defaultModel(setup.settings),
      access: setup.provider.capabilities.repoAccess,
      ok: false,
      problems: [],
      steps: 0,
      repaired: false,
      toolCalls,
      wallMs: 0,
      usage,
    };
    const started = clock();
    try {
      const key = `${c.repo}@${c.ref}`;
      if (!checkouts.has(key)) checkouts.set(key, options.checkout(c.repo, c.ref));
      const hostDir = await checkouts.get(key)!;
      const asked = await askFor(c, brand, hostDir, analyses);
      const result = await runner.run(
        asked.task,
        {
          system: asked.system,
          prompt: asked.prompt,
          repo: { name: c.repo, ref: c.ref, hostDir },
          observer: {
            toolCall: (call) => toolCalls.push({ name: call.name, args: summarizeArgs(call.name, call.input) }),
            step: (u) => {
              modelCalls++;
              usage.inputTokens += u.inputTokens ?? 0;
              usage.outputTokens += u.outputTokens ?? 0;
              usage.totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
              usage.cacheReadTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
              usage.cacheWriteTokens += u.inputTokenDetails?.cacheWriteTokens ?? 0;
            },
          },
        },
        setup,
      );
      record.ok = true;
      record.output = result.output;
      record.steps = result.steps;
      record.repaired = result.repaired;
      record.model = result.model;
      if (c.task === 'pack' && asked.config) {
        const pack = ContentPack.parse(result.output);
        analyses.set(c.id, pack.analysis);
        record.problems = missingPieces(pack, asked.config, brand);
      }
    } catch (error) {
      record.error = redact(error instanceof Error ? error.message : String(error), secrets);
      // A failed run returns no count: the model calls the observer saw
      record.steps = modelCalls;
    }
    record.wallMs = Math.round(clock() - started);
    records.push(record);
    await writeFile(join(outDir, `${c.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    options.log?.(`${c.id}: ${record.ok ? 'ok' : `failed: ${record.error}`} in ${(record.wallMs / 1000).toFixed(1)} s, ${record.steps} steps, ${toolCalls.length} tool calls, ${usage.totalTokens} tokens`);
  }
  await writeFile(join(outDir, 'summary.json'), `${JSON.stringify(records, null, 2)}\n`);
  return records;
}

const RecordFile = z.array(
  z.looseObject({
    case: z.string(),
    task: z.enum(['pack', 'reply']),
    provider: z.string(),
    model: z.string(),
    access: z.string(),
    ok: z.boolean(),
    error: z.string().optional(),
    output: z.unknown().optional(),
    problems: z.array(z.string()).default([]),
    steps: z.number(),
    toolCalls: z.array(z.object({ name: z.string(), args: z.string() })).default([]),
    wallMs: z.number(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number(), cacheReadTokens: z.number().default(0), cacheWriteTokens: z.number().default(0) }),
  }),
);
type Recorded = z.infer<typeof RecordFile>[number];

/** A run's records, from its summary.json */
export async function readEvalDir(dir: string): Promise<Recorded[]> {
  return RecordFile.parse(JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')));
}

const ANALYSIS_LISTS = ['implemented', 'planned', 'documentedOnly', 'limitations'] as const;
const PackOutput = z.looseObject({ analysis: AnalysisInput.partial().optional() });
const ReplyOutput = z.looseObject({ classification: z.string().optional(), dismiss: z.boolean().optional(), reply: z.string().optional() });

const key = (item: string) => item.trim().toLowerCase().replace(/\s+/g, ' ');

/** What B's list has that A's has not (+), and the reverse (-), as written */
export function listDiff(a: readonly string[], b: readonly string[]): { added: string[]; removed: string[] } {
  const inA = new Set(a.map(key));
  const inB = new Set(b.map(key));
  return { added: b.filter((i) => !inA.has(key(i))), removed: a.filter((i) => !inB.has(key(i))) };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const thousands = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

/**
 * Two runs side by side, for a person to judge: a table of steps, time and tokens per case, then
 * per pack the analysis items B added or dropped against A, and per reply both replies.
 */
export function compareEvals(a: readonly Recorded[], b: readonly Recorded[], labels: { a: string; b: string } = { a: 'A', b: 'B' }): string {
  const ids = [...new Set([...a.map((r) => r.case), ...b.map((r) => r.case)])];
  const byId = (records: readonly Recorded[], id: string) => records.find((r) => r.case === id);
  const cell = (r: Recorded | undefined, f: (r: Recorded) => string) => (r ? (r.ok ? f(r) : `failed`) : '—');
  const rows: string[][] = [['case', `steps ${labels.a}`, `steps ${labels.b}`, `tools ${labels.a}`, `tools ${labels.b}`, `time ${labels.a}`, `time ${labels.b}`, `tokens ${labels.a}`, `tokens ${labels.b}`, `cached ${labels.a}`, `cached ${labels.b}`]];
  for (const id of ids) {
    const ra = byId(a, id);
    const rb = byId(b, id);
    rows.push([
      id,
      cell(ra, (r) => String(r.steps)),
      cell(rb, (r) => String(r.steps)),
      ra ? String(ra.toolCalls.length) : '—',
      rb ? String(rb.toolCalls.length) : '—',
      ra ? seconds(ra.wallMs) : '—',
      rb ? seconds(rb.wallMs) : '—',
      ra ? thousands(ra.usage.totalTokens) : '—',
      rb ? thousands(rb.usage.totalTokens) : '—',
      ra ? thousands(ra.usage.cacheReadTokens) : '—',
      rb ? thousands(rb.usage.cacheReadTokens) : '—',
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  const out = [`${labels.a}: ${describe(a)}`, `${labels.b}: ${describe(b)}`, '', line(rows[0]!), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.slice(1).map(line)];

  for (const id of ids) {
    const ra = byId(a, id);
    const rb = byId(b, id);
    out.push('', `## ${id}`);
    for (const [label, r] of [[labels.a, ra], [labels.b, rb]] as const) if (r && !r.ok) out.push(`${label} failed: ${r.error ?? 'no answer'}`);
    if (!ra?.ok || !rb?.ok) continue;
    if (ra.task === 'pack') {
      const pa = PackOutput.parse(ra.output ?? {}).analysis ?? {};
      const pb = PackOutput.parse(rb.output ?? {}).analysis ?? {};
      if ((pa.summary ?? '') !== (pb.summary ?? '')) out.push(`summary ${labels.a}: ${pa.summary ?? ''}`, `summary ${labels.b}: ${pb.summary ?? ''}`);
      for (const list of ANALYSIS_LISTS) {
        const { added, removed } = listDiff(pa[list] ?? [], pb[list] ?? []);
        out.push(`${list}: ${(pa[list] ?? []).length} → ${(pb[list] ?? []).length}${added.length + removed.length === 0 ? ', the same items' : ''}`);
        for (const item of removed) out.push(`  - ${item}`);
        for (const item of added) out.push(`  + ${item}`);
      }
      for (const [label, r] of [[labels.a, ra], [labels.b, rb]] as const) if (r.problems.length > 0) out.push(`${label} problems: ${r.problems.join('; ')}`);
    } else {
      for (const [label, r] of [[labels.a, ra], [labels.b, rb]] as const) {
        const reply = ReplyOutput.parse(r.output ?? {});
        out.push(`${label} (${reply.classification ?? '?'}${reply.dismiss ? ', dismiss' : ''}): ${reply.reply ?? ''}`);
      }
    }
  }
  return out.join('\n');
}

function describe(records: readonly Recorded[]): string {
  const first = records[0];
  return first ? `${first.provider} ${first.model}, ${first.access}` : 'no records';
}
