import { parseArgs } from 'node:util';
import {
  checkout,
  claimManual,
  Claudio,
  collectMetrics,
  draftLaunch,
  GitHubRest,
  loadBrand,
  preflight,
  Registry,
  type Preflight,
  type DraftResult,
  type PipelineDeps,
  type PublishResult,
} from '@shipcast/engine';
import { Channel, type Brand } from '@shipcast/schema';
import {
  buildServices,
  ConfigError,
  KeychainStore,
  loadConfig,
  METRICS_AT_KEY,
  MIN_INTERVAL_SECONDS,
  publishOne,
  runRound,
  type RoundDeps,
  type SecretStore,
  type Services,
} from '@shipcast/runtime';

const USAGE = `Usage: shipcast <command>

  launch <owner/repo> [--ref <tag>]   Draft the launch of a release (the latest one without --ref),
                                      after its pre-flight check passes
  preflight <owner/repo> [--ref <tag>]
                                      Check a repo is ready to launch: release, launch.yml, license,
                                      README and demo
  watch [--interval <seconds>]        Watch the account's releases, draft each launch and publish it once
                                      its drafts are merged; read the numbers every 6 h (default 300 s)
  publish [--retry <channel>]         Publish every drafted launch whose pull request is merged, once;
                                      --retry gives a channel that failed for good another chance
  metrics                             Read the numbers of every published launch now
  status                              The latest launches and where they stand, and what is configured

The launches, their channels and numbers, drafts to review and articles to write are in the web
app: pnpm app (see docs/web-app.md).
`;

function report(result: DraftResult): void {
  if (result.ok) {
    console.log(`Drafted ${result.launch.repo} ${result.launch.ref}: ${result.pullRequest}`);
    if (result.costUsd !== null) console.log(`AI cost: $${result.costUsd.toFixed(2)}`);
  } else {
    console.error(`Launch of ${result.launch.repo} ${result.launch.ref} failed:\n${result.problems.map((p) => `  ${p}`).join('\n')}`);
  }
}

function reportPreflight(result: Preflight): void {
  for (const check of result.checks) console.log(`  ${check.ok ? 'ok  ' : check.required ? 'FAIL' : 'warn'}  ${check.detail}`);
}

function reportPublish(result: PublishResult): void {
  const name = `${result.launch.repo} ${result.launch.ref}`;
  if (result.state === 'waiting') return;
  if (result.state === 'skipped') {
    console.log(`${name}: its drafts pull request was closed without merging; not published`);
    return;
  }
  console.log(`${name} ${result.state}:${result.posted.map((p) => `\n  ${p.channel} ${p.url}`).join('')}`);
  for (const problem of result.problems) console.error(`  ${problem}`);
}

/** Publishes what is ready: each drafted launch whose pull request was merged and whose article is live. */
async function publishReady(round: RoundDeps): Promise<void> {
  const services = await buildServices({ env: round.env, brand: round.brand, registry: round.registry, github: round.github, secrets: round.secrets });
  for (const launch of (await round.registry.recent(100)).filter((l) => l.status === 'drafted')) reportPublish(await publishOne(launch, round, services));
}

async function readMetrics(brand: Brand, services: Services, registry: Registry): Promise<void> {
  const result = await collectMetrics(registry, brand, services.sources);
  await registry.setCursor(METRICS_AT_KEY, new Date().toISOString());
  console.log(`Metrics: ${result.readings} readings`);
  for (const problem of result.problems) console.error(`  ${problem}`);
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ref: { type: 'string' }, interval: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, retry: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const config = loadConfig();
  const secrets: SecretStore = new KeychainStore();
  const registry = await Registry.connect(config.databaseUrl);
  const github = new GitHubRest({ token: config.githubToken });
  const deps: PipelineDeps = {
    github,
    ai: new Claudio({ url: config.claudioUrl, token: config.claudioToken }),
    registry,
    launchesRepo: config.launchesRepo,
    checkout: (repo, ref) => checkout({ hostDir: config.workspaceHostDir, providerDir: config.workspaceProviderDir }, repo, ref),
    maxBudgetUsd: config.maxBudgetUsd,
  };

  try {
    switch (command) {
      case 'status': {
        const launches = await registry.recent();
        if (launches.length === 0) console.log('No launches yet.');
        for (const l of launches) {
          console.log(`${l.createdAt.slice(0, 16).replace('T', ' ')}  ${l.repo} ${l.ref}  ${l.kind}  ${l.status}${l.detail ? `  ${l.detail.split('\n')[0]}` : ''}`);
        }
        const brand = await loadBrand(github, config.launchesRepo);
        const services = await buildServices({ env: process.env, brand, registry, github, secrets });
        console.log(`\nConfigured: ${services.configured.join(', ')}`);
        return 0;
      }

      case 'publish': {
        if (values.retry) {
          const channel = Channel.safeParse(values.retry);
          if (!channel.success) {
            console.error(`--retry needs a channel, not "${values.retry}"`);
            return 2;
          }
          for (const l of await registry.retryChannel(channel.data)) console.log(`Retrying ${channel.data} for ${l.repo} ${l.ref}`);
        }
        const brand = await loadBrand(github, config.launchesRepo);
        await publishReady({ env: process.env, registry, github, secrets, brand, pipeline: deps });
        return 0;
      }

      case 'metrics': {
        const brand = await loadBrand(github, config.launchesRepo);
        await readMetrics(brand, await buildServices({ env: process.env, brand, registry, github, secrets }), registry);
        return 0;
      }

      case 'dashboard': {
        console.error('The dashboard is now the web app: pnpm app');
        return 2;
      }

      case 'launch': {
        const repo = rest[0];
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          console.error('launch needs a repo as owner/name');
          return 2;
        }
        const check = await preflight(repo, values.ref, { github });
        reportPreflight(check);
        if (!check.ok) {
          console.error(`${repo} is not ready to launch: fix the checks marked FAIL`);
          return 1;
        }
        const brand = await loadBrand(github, config.launchesRepo);
        const claim = await claimManual(repo, values.ref, brand, deps);
        if ('error' in claim) {
          console.error(claim.error);
          return 1;
        }
        if (!claim.claimed) {
          console.error(`${repo} ${claim.launch.ref} was launched already (${claim.launch.status}${claim.launch.detail ? `: ${claim.launch.detail.split('\n')[0]}` : ''})`);
          return 1;
        }
        console.log(`Drafting ${repo} ${claim.launch.ref} (${claim.launch.kind} pack); the analysis takes a few minutes...`);
        const result = await draftLaunch(claim.launch, brand, deps);
        report(result);
        return result.ok ? 0 : 1;
      }

      case 'preflight': {
        const repo = rest[0];
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          console.error('preflight needs a repo as owner/name');
          return 2;
        }
        const check = await preflight(repo, values.ref, { github });
        console.log(`${repo} ${check.ok ? 'is ready to launch' : 'is not ready to launch'}`);
        reportPreflight(check);
        return check.ok ? 0 : 1;
      }

      case 'watch': {
        const interval = Math.max(MIN_INTERVAL_SECONDS, Number(values.interval ?? 300)) * 1000;
        const brand = await loadBrand(github, config.launchesRepo);
        const services = await buildServices({ env: process.env, brand, registry, github, secrets });
        console.log(`Watching ${brand.github}'s releases for ${config.launchesRepo}, every ${interval / 1000} s. Ctrl+C to stop.`);
        console.log(`Publishing to and reading from: ${services.configured.join(', ')}`);
        let stopping = false;
        process.once('SIGINT', () => {
          stopping = true;
          console.log('\nStopping after the current round.');
        });
        // The same round the web app runs: detect, publish, refresh tokens, metrics every 6 hours
        while (!stopping) {
          await runRound({ env: process.env, registry, github, secrets, brand, pipeline: deps, log: (line) => console.log(line) }, { detect: true });
          await new Promise((r) => setTimeout(r, interval));
        }
        return 0;
      }

      default:
        console.error(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await registry.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  },
);
