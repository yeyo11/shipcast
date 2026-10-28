import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  checkout,
  currentPrompts,
  draftLaunch,
  GitHubApp,
  GitHubRest,
  launchConfigOf,
  loadBrand,
  readAiSettings,
  connectRepositories,
  type Repositories,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_MODEL,
  type Launch,
  type PipelineDeps,
} from '@shipcast/engine';
// LEGACY: Action mode still builds the old providers; it moves to the AI task runner before the old layer is removed
import { anthropicProvider, fakePackProvider, openAiCompatibleProvider, openAiProvider, type AiProvider } from '@shipcast/engine/legacy-ai';
import type { Brand } from '@shipcast/schema';
import {
  BranchState,
  buildServices,
  channelPlan,
  ciLaunch,
  ciPublish,
  ciRound,
  GitStateStore,
  launchTarget,
  loadCiConfig,
  networkEnv,
  PostgresState,
  publishOne,
  publishTarget,
  type CiAi,
  type CiConfig,
  type CiDeps,
  type CiResult,
  type CiState,
  type SecretStore,
} from '@shipcast/runtime';
import { join } from 'node:path';

export const CI_USAGE = `Usage: shipcast ci <command> [flags]

Runs headless, for GitHub Actions: configuration only from the environment, the registry kept on the
launches repo's shipcast-state branch (docs/decisions/action-mode.md).

  ci launch [--repo <owner/repo>] [--ref <tag>]
                         Claim a release and draft it. Without flags it reads the workflow's event
                         (release, public or workflow_dispatch); --repo and --ref launch by hand
  ci publish [--pull-request <url>] [--wait <minutes>]
                         Publish the launch of a merged drafts pull request (the workflow's
                         pull_request event, or --pull-request), waiting up to --wait minutes (20)
                         for the blog to deploy; without either, every drafted launch that is ready
  ci round [--detect]    Publish whatever is ready; with --detect also poll the brand's public events
                         for releases no workflow claimed

  --dry-run              Print what would be done: nothing is saved, asked of the AI, opened or posted
`;

/** A secret store that lives as long as the process: CI has no keychain, its secrets are the environment */
class MemorySecrets implements SecretStore {
  readonly kind = 'memory';
  readonly #values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.#values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.#values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.#values.delete(key);
  }
}

/** Stands in where a dry run asks for an AI: it never gets one, so an accidental call is loud */
const NO_AI = 'no AI provider is configured (SHIPCAST_AI_PROVIDER, anthropic or openai, with ANTHROPIC_API_KEY or OPENAI_API_KEY)';
const noAi: AiProvider = {
  id: 'anthropic',
  generateObject() {
    throw new Error(NO_AI);
  },
  streamText() {
    throw new Error(NO_AI);
  },
};

/**
 * The provider a launch is drafted with. The fake one is built per launch, since its placeholder pack
 * names the launch it was asked for.
 */
export function aiProviderOf(ai: CiAi | undefined, launch?: { launch: Launch; brand: Brand }): AiProvider {
  if (!ai) return noAi;
  switch (ai.kind) {
    case 'anthropic':
      return anthropicProvider({ apiKey: ai.apiKey });
    case 'openai':
      return openAiProvider({ apiKey: ai.apiKey });
    case 'openaiCompatible':
      return openAiCompatibleProvider({ baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model });
    case 'fake':
      return launch ? fakePackProvider(launch.launch, launch.brand) : noAi;
  }
}

export function aiLabelOf(ai: CiAi | undefined): string {
  if (!ai) return 'the AI (none configured)';
  switch (ai.kind) {
    case 'anthropic':
      return `the Anthropic API (${ai.model ?? DEFAULT_ANTHROPIC_MODEL})`;
    case 'openai':
      return `the OpenAI API (${ai.model ?? DEFAULT_OPENAI_MODEL})`;
    case 'openaiCompatible':
      return `${ai.baseUrl} (${ai.model})`;
    case 'fake':
      return 'the fake AI provider (a placeholder pack, for tests: no model reads the code)';
  }
}

/** Writes the action's outputs, when GitHub gave a file for them */
export function writeOutputs(outputs: Record<string, string>, file: string | undefined): void {
  if (!file) return;
  for (const [name, value] of Object.entries(outputs)) appendFileSync(file, `${name}=${value.replace(/\r?\n/g, ' ')}\n`);
}

export interface CiArgs {
  command: 'launch' | 'publish' | 'round';
  dryRun: boolean;
  repo: string | undefined;
  ref: string | undefined;
  pullRequest: string | undefined;
  waitMinutes: number;
  detect: boolean;
}

/** The flags of `shipcast ci`, or the message to print; the environment's own are the action's inputs */
export function parseCiArgs(argv: string[]): CiArgs | { error: string } {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { 'dry-run': { type: 'boolean' }, repo: { type: 'string' }, ref: { type: 'string' }, 'pull-request': { type: 'string' }, wait: { type: 'string' }, detect: { type: 'boolean' } },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  const [command, ...extra] = parsed.positionals;
  if (command !== 'launch' && command !== 'publish' && command !== 'round') return { error: `ci takes launch, publish or round, not "${command ?? ''}"` };
  if (extra.length > 0) return { error: `unexpected argument "${extra[0]}"` };
  const wait = parsed.values.wait === undefined ? 20 : Number(parsed.values.wait);
  if (!Number.isFinite(wait) || wait < 0) return { error: `--wait needs a number of minutes, not "${parsed.values.wait}"` };
  const blank = (v: string | undefined) => v?.trim() || undefined;
  return {
    command,
    dryRun: parsed.values['dry-run'] ?? false,
    repo: blank(parsed.values.repo),
    ref: blank(parsed.values.ref),
    pullRequest: blank(parsed.values['pull-request']),
    waitMinutes: wait,
    detect: parsed.values.detect ?? false,
  };
}

function readEvent(env: NodeJS.ProcessEnv): unknown {
  const path = env.GITHUB_EVENT_PATH;
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * A clone is authenticated like actions/checkout does: a header for github.com in git's environment,
 * set only around the clone. The engine's checkout reads the process environment, so it is set there.
 */
function authenticatedCheckout(token: () => Promise<string>, workspaceDir: string): PipelineDeps['checkout'] {
  return async (repo, ref) => {
    const value = await token();
    const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    process.env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${value}`).toString('base64')}`;
    try {
      // The SDK providers read the clone on this machine, so the provider's view is the host's
      return await checkout({ hostDir: workspaceDir, providerDir: workspaceDir }, repo, ref);
    } finally {
      for (const [name, v] of [['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_KEY_0', saved.key], ['GIT_CONFIG_VALUE_0', saved.value]] as const) {
        if (v === undefined) delete process.env[name];
        else process.env[name] = v;
      }
    }
  };
}

/** Everything a `ci` command needs, built from the environment */
export async function buildCiDeps(config: CiConfig, env: NodeJS.ProcessEnv, options: { dryRun: boolean; log: (line: string) => void }): Promise<CiDeps> {
  const auth = config.github.kind === 'app' ? new GitHubApp({ appId: config.github.appId, ...(config.github.clientId && { clientId: config.github.clientId }), privateKey: config.github.privateKey, account: () => config.launchesRepo }) : undefined;
  const staticToken = config.github.kind === 'token' ? config.github.token : undefined;
  const token = async () => (auth ? auth.token() : staticToken!);
  const github = new GitHubRest({ token: auth ?? staticToken! });

  let state: CiState;
  if (config.state.kind === 'postgres') state = new PostgresState(await connectRepositories(config.state.url));
  else {
    const store = new GitStateStore({ remote: config.state.remote, branch: config.state.branch, token });
    state = new BranchState(store, { holder: config.holder, leaseMs: config.leaseMs, waitMs: config.waitMs, dryRun: options.dryRun, log: options.log });
  }

  mkdirSync(config.workDir, { recursive: true });
  const brand = () => loadBrand(github, config.launchesRepo);
  const model = config.ai && 'model' in config.ai ? config.ai.model : undefined;
  const pipelineFor = (registry: Repositories, launch?: { launch: Launch; brand: Brand }): PipelineDeps => {
    const provider = aiProviderOf(config.ai, launch);
    return {
    github,
    ai: provider,
    // The edited prompts and the tone override live in the registry; the provider is always CI's own
    aiSetup: async () => ({ provider, ...(model && { model }), prompts: await currentPrompts(registry), tone: (await readAiSettings(registry)).tone }),
    registry,
    launchesRepo: config.launchesRepo,
    checkout: authenticatedCheckout(token, join(config.workDir, 'workspace')),
    };
  };

  return {
    launchesRepo: config.launchesRepo,
    github,
    state,
    brand,
    aiLabel: aiLabelOf(config.ai),
    async plan(launch) {
      const launchConfig = await launchConfigOf(github, config.launchesRepo, launch);
      if (!launchConfig) return [`launch.yml of ${launch.repo} at ${launch.ref} cannot be read`];
      return channelPlan(launchConfig, env).map((p) => `${p.channel} (${p.mode}): ${p.ready ? (p.mode === 'auto' ? 'would publish at once' : 'would publish') : 'skipped'}; ${p.note}`);
    },
    dryRun: options.dryRun,
    log: options.log,
    async draft(launch, brandOf, registry) {
      return draftLaunch(launch, brandOf, pipelineFor(registry, { launch, brand: brandOf }));
    },
    async publish(launch, brandOf, registry) {
      const services = await buildServices({
        env: networkEnv(env, brandOf.id, config.workDir, (path, content) => writeFileSync(path, content, { mode: 0o600 })),
        brand: brandOf,
        registry,
        github,
        secrets: new MemorySecrets(),
      });
      return publishOne(launch, { env, registry, github, secrets: new MemorySecrets(), brand: brandOf, pipeline: pipelineFor(registry), log: options.log }, services);
    },
  };
}

/** `shipcast ci ...`: the exit code */
export async function runCi(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(CI_USAGE);
    return 0;
  }
  const args = parseCiArgs(argv);
  if ('error' in args) {
    console.error(`${args.error}\n\n${CI_USAGE}`);
    return 2;
  }
  const log = (line: string) => console.error(line);
  // A dry run asks no AI, and publishing or a round without detection never does
  const config = loadCiConfig(env, { needAi: !args.dryRun && (args.command === 'launch' || (args.command === 'round' && args.detect)) });
  const deps = await buildCiDeps(config, env, { dryRun: args.dryRun, log });
  const event = readEvent(env);
  let result: CiResult;
  try {
    if (args.command === 'launch') {
      result = await ciLaunch(deps, launchTarget({ eventName: env.GITHUB_EVENT_NAME, payload: event, repo: args.repo, ref: args.ref, currentRepo: config.currentRepo }));
    } else if (args.command === 'publish') {
      const fromEvent = args.pullRequest ? undefined : publishTarget({ eventName: env.GITHUB_EVENT_NAME, payload: event, launchesRepo: config.launchesRepo });
      if (fromEvent && 'ignore' in fromEvent) {
        log(`Nothing to publish: ${fromEvent.ignore}`);
        result = { code: 0, outputs: { status: 'ignored' } };
      } else {
        result = await ciPublish(deps, { pullRequest: args.pullRequest ?? fromEvent?.pullRequest, waitMs: args.waitMinutes * 60_000 });
      }
    } else {
      result = await ciRound(deps, { detect: args.detect });
    }
  } finally {
    await deps.state.close();
  }
  writeOutputs(result.outputs, env.GITHUB_OUTPUT);
  return result.code;
}
