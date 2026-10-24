import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkout,
  claimManual,
  Claudio,
  detect,
  draftLaunch,
  GitHubRest,
  loadBrand,
  Registry,
  type DraftResult,
  type PipelineDeps,
} from '@shipcast/engine';
import { ConfigError, loadConfig } from './config.ts';

const USAGE = `Usage: shipcast <command>

  launch <owner/repo> [--ref <tag>]   Draft the launch of a release (the latest one without --ref)
  watch [--interval <seconds>]        Watch the account's releases and draft each launch (default 300 s)
  status                              The latest launches and where they stand
`;

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

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ref: { type: 'string' }, interval: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
        console.log(`Watching ${brand.github}'s releases for ${config.launchesRepo}, every ${interval / 1000} s. Ctrl+C to stop.`);
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
