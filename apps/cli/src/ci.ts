import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  anthropicProvider,
  checkout,
  currentPrompts,
  draftLaunch,
  GitHubApp,
  GitHubRest,
  loadBrand,
  openAiCompatibleProvider,
  readAiSettings,
  Registry,
  type AiProvider,
  type PipelineDeps,
} from '@shipcast/engine';
import {
  BranchState,
  buildServices,
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
const noAi: AiProvider = {
  id: 'anthropic',
  generateObject() {
    throw new Error('no AI provider is configured (ANTHROPIC_API_KEY, or SHIPCAST_AI_BASE_URL with SHIPCAST_AI_MODEL)');
  },
  streamText() {
    throw new Error('no AI provider is configured (ANTHROPIC_API_KEY, or SHIPCAST_AI_BASE_URL with SHIPCAST_AI_MODEL)');
  },
};

export function aiProviderOf(ai: CiAi | undefined): AiProvider {
  if (!ai) return noAi;
  return ai.kind === 'anthropic' ? anthropicProvider({ apiKey: ai.apiKey }) : openAiCompatibleProvider({ baseUrl: ai.baseUrl, apiKey: ai.apiKey, model: ai.model });
}

export function aiLabelOf(ai: CiAi | undefined): string {
  if (!ai) return 'the AI (none configured)';
  return ai.kind === 'anthropic' ? `the Anthropic API${ai.model ? ` (${ai.model})` : ''}` : `${ai.baseUrl} (${ai.model})`;
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
  if (config.state.kind === 'postgres') state = new PostgresState(await Registry.connect(config.state.url));
  else {
    const store = new GitStateStore({ remote: config.state.remote, branch: config.state.branch, token });
    state = new BranchState(store, { holder: config.holder, leaseMs: config.leaseMs, waitMs: config.waitMs, dryRun: options.dryRun, log: options.log });
  }

  mkdirSync(config.workDir, { recursive: true });
  const provider = aiProviderOf(config.ai);
  const brand = () => loadBrand(github, config.launchesRepo);
  const pipelineFor = (registry: Registry): PipelineDeps => ({
    github,
    ai: provider,
    // The edited prompts and the tone override live in the registry; the provider is always CI's own
    aiSetup: async () => ({ provider, ...(config.ai?.model && { model: config.ai.model }), prompts: await currentPrompts(registry), tone: (await readAiSettings(registry)).tone }),
    registry,
    launchesRepo: config.launchesRepo,
    checkout: authenticatedCheckout(token, join(config.workDir, 'workspace')),
  });

  return {
    launchesRepo: config.launchesRepo,
    github,
    state,
    brand,
    aiLabel: aiLabelOf(config.ai),
    dryRun: options.dryRun,
    log: options.log,
    async draft(launch, brandOf, registry) {
      return draftLaunch(launch, brandOf, pipelineFor(registry));
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
