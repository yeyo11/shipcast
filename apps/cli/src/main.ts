import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkout,
  claimManual,
  Claudio,
  collectMetrics,
  detect,
  draftLaunch,
  GitHubRest,
  loadBrand,
  publishLaunch,
  Registry,
  type DraftResult,
  type PipelineDeps,
  type PublishResult,
} from '@shipcast/engine';
import { Channel, type Brand } from '@shipcast/schema';
import { ConfigError, loadConfig } from './config.ts';
import { serveDashboard } from './dashboard.ts';
import { buildServices, refreshInstagramToken, type Services } from './services.ts';

const USAGE = `Usage: shipcast <command>

  launch <owner/repo> [--ref <tag>]   Draft the launch of a release (the latest one without --ref)
  watch [--interval <seconds>]        Watch the account's releases, draft each launch and publish it once
                                      its drafts are merged; read the numbers every 6 h (default 300 s)
  publish [--retry <channel>]         Publish every drafted launch whose pull request is merged, once;
                                      --retry gives a channel that failed for good another chance
  metrics                             Read the numbers of every published launch now
  dashboard [--port <port>] [--host <address>]
                                      The launches and their numbers on http://127.0.0.1:<port> (default 4321);
                                      --host 0.0.0.0 opens it to the local network, which it trusts (no login)
  status                              The latest launches and where they stand, and what is configured
`;

const METRICS_EVERY_MS = 6 * 3600 * 1000;
const METRICS_AT_KEY = 'metrics-collected-at';

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** GitHub asks pollers of the events API not to come back sooner than this (x-poll-interval). */
const MIN_INTERVAL_S = 60;

function report(result: DraftResult): void {
  if (result.ok) {
    console.log(`Drafted ${result.launch.repo} ${result.launch.ref}: ${result.pullRequest}`);
    if (result.costUsd !== null) console.log(`AI cost: $${result.costUsd.toFixed(2)}`);
  } else {
    console.error(`Launch of ${result.launch.repo} ${result.launch.ref} failed:\n${result.problems.map((p) => `  ${p}`).join('\n')}`);
  }
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
async function publishReady(brand: Brand, services: Services, deps: PipelineDeps): Promise<void> {
  for (const launch of deps.registry.recent(100).filter((l) => l.status === 'drafted')) {
    reportPublish(await publishLaunch(launch, brand, { github: deps.github, registry: deps.registry, launchesRepo: deps.launchesRepo, publishers: services.publishers }));
  }
}

async function readMetrics(brand: Brand, services: Services, registry: Registry): Promise<void> {
  const result = await collectMetrics(registry, brand, services.sources);
  registry.setCursor(METRICS_AT_KEY, new Date().toISOString());
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
  mkdirSync(config.dataDir, { recursive: true });
  const registry = new Registry(join(config.dataDir, 'shipcast.db'));
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
        const launches = registry.recent();
        if (launches.length === 0) console.log('No launches yet.');
        for (const l of launches) {
          console.log(`${l.createdAt.slice(0, 16).replace('T', ' ')}  ${l.repo} ${l.ref}  ${l.kind}  ${l.status}${l.detail ? `  ${l.detail.split('\n')[0]}` : ''}`);
        }
        const brand = await loadBrand(github, config.launchesRepo);
        console.log(`\nConfigured: ${buildServices(process.env, brand, registry, github).configured.join(', ')}`);
        return 0;
      }

      case 'publish': {
        if (values.retry) {
          const channel = Channel.safeParse(values.retry);
          if (!channel.success) {
            console.error(`--retry needs a channel, not "${values.retry}"`);
            return 2;
          }
          for (const l of registry.retryChannel(channel.data)) console.log(`Retrying ${channel.data} for ${l.repo} ${l.ref}`);
        }
        const brand = await loadBrand(github, config.launchesRepo);
        await publishReady(brand, buildServices(process.env, brand, registry, github), deps);
        return 0;
      }

      case 'metrics': {
        const brand = await loadBrand(github, config.launchesRepo);
        await readMetrics(brand, buildServices(process.env, brand, registry, github), registry);
        return 0;
      }

      case 'dashboard': {
        const port = Number(values.port ?? 4321);
        const host = values.host ?? '127.0.0.1';
        const server = serveDashboard(registry, port, host);
        console.log(`Dashboard on http://${host}:${port} (Ctrl+C to stop)`);
        await new Promise<void>((r) => process.once('SIGINT', () => server.close(() => r())));
        return 0;
      }

      case 'launch': {
        const repo = rest[0];
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          console.error('launch needs a repo as owner/name');
          return 2;
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

      case 'watch': {
        const interval = Math.max(MIN_INTERVAL_S, Number(values.interval ?? 300)) * 1000;
        const brand = await loadBrand(github, config.launchesRepo);
        let services = buildServices(process.env, brand, registry, github);
        console.log(`Watching ${brand.github}'s releases for ${config.launchesRepo}, every ${interval / 1000} s. Ctrl+C to stop.`);
        console.log(`Publishing to and reading from: ${services.configured.join(', ')}`);
        let stopping = false;
        process.once('SIGINT', () => {
          stopping = true;
          console.log('\nStopping after the current step.');
        });
        while (!stopping) {
          try {
            for (const outcome of await detect({ github, registry, brand })) {
              if (outcome.result === 'claimed') report(await draftLaunch(outcome.launch, brand, deps));
              else if (outcome.result === 'invalid-config') console.error(`${outcome.event.repo}: ${outcome.launch.detail}`);
            }
          } catch (error) {
            // A failed poll (network, GitHub hiccup) is logged and retried on the next round
            console.error(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          // Each step on its own: one failing must not keep the others from running this round
          await step('publish', () => publishReady(brand, services, deps));
          await step('Instagram token', async () => {
            const refreshed = await refreshInstagramToken(services, registry);
            if (refreshed) {
              console.log(refreshed);
              services = buildServices(process.env, brand, registry, github);
            }
          });
          const lastMetrics = Date.parse(registry.cursor(METRICS_AT_KEY) ?? '') || 0;
          if (Date.now() - lastMetrics >= METRICS_EVERY_MS) await step('metrics', () => readMetrics(brand, services, registry));
          await new Promise((r) => setTimeout(r, interval));
        }
        return 0;
      }

      default:
        console.error(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    registry.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  },
);
