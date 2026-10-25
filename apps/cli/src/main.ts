import { parseArgs } from 'node:util';
import {
  checkout,
  claimManual,
  Claudio,
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
import { Channel } from '@shipcast/schema';
import {
  buildServices,
  BY_HAND,
  ConfigError,
  createApiToken,
  InvalidScopes,
  KeychainStore,
  loadConfig,
  MIN_INTERVAL_SECONDS,
  parseScopes,
  publishOne,
  readAutomation,
  startWorking,
  WorkQueue,
  workHandlers,
  writeAutomation,
  type RoundDeps,
  type SecretStore,
} from '@shipcast/runtime';

const USAGE = `Usage: shipcast <command>

  launch <owner/repo> [--ref <tag>]   Draft the launch of a release (the latest one without --ref),
                                      after its pre-flight check passes
  preflight <owner/repo> [--ref <tag>]
                                      Check a repo is ready to launch: release, launch.yml, license,
                                      README and demo
  watch [--interval <seconds>]        Work Shipcast's job queue beside (or instead of) the app: rounds
                                      that claim releases, draft them and publish what is merged, and
                                      the numbers every 6 h, in the Automation settings' mode;
                                      --interval sets the seconds between rounds (at least 60)
  publish [--retry <channel>]         Publish every drafted launch whose pull request is merged, once;
                                      --retry gives a channel that failed for good another chance
  metrics                             Read the numbers of every published launch now
  status                              The latest launches and where they stand, and what is configured
  token create <name> --scopes <list> A token for the REST API (/api/v1), scopes read, write or both
                                      (read,write); printed once, only its hash is kept
  token list                          The API tokens, revoked ones too
  token revoke <id>                   Revoke an API token at once

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

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ref: { type: 'string' }, interval: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, retry: { type: 'string' }, scopes: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
        // A job of the queue, sent and worked here, so the app lists it like any other reading
        const brand = await loadBrand(github, config.launchesRepo);
        const queue = WorkQueue.postgres(config.databaseUrl, registry, { instanceName: 'cli', schedule: false, supervise: false, pollingIntervalSeconds: 0.5 });
        try {
          const id = await queue.send('metrics', { reason: BY_HAND }, { title: 'Reading the numbers, by hand', singletonKey: BY_HAND });
          if (!id) {
            console.error('A reading by hand is queued already.');
            return 1;
          }
          const { metrics } = workHandlers(queue, { env: process.env, registry, github, secrets, pipeline: deps, brand: async () => brand });
          await queue.work({ metrics });
          const done = await queue.wait(id, 30 * 60_000);
          for (const line of done?.log ?? []) console.log(line);
          if (!done) console.error('The reading did not end within 30 minutes.');
          return done?.state === 'completed' ? 0 : 1;
        } finally {
          await queue.stop();
        }
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
        const brand = await loadBrand(github, config.launchesRepo);
        const services = await buildServices({ env: process.env, brand, registry, github, secrets });
        // The cadence is the Automation setting, shared with the app: --interval changes it
        if (values.interval !== undefined) {
          const seconds = Number(values.interval);
          if (!Number.isFinite(seconds)) {
            console.error(`--interval needs a number of seconds, not "${values.interval}"`);
            return 2;
          }
          await writeAutomation(registry, { ...(await readAutomation(registry)), intervalSeconds: Math.max(MIN_INTERVAL_SECONDS, seconds) });
        }
        const automation = await readAutomation(registry);
        const queue = WorkQueue.postgres(config.databaseUrl, registry, { instanceName: 'watch' });
        // A worker of the same queue as the app: the same rounds and jobs, never one round twice
        await startWorking(queue, { env: process.env, registry, github, secrets, pipeline: deps, brand: async () => brand }, { firstRoundInSeconds: 0 });
        console.log(`Working Shipcast's job queue for ${brand.github}'s releases and ${config.launchesRepo}: ${automation.mode} mode, a round every ${automation.intervalSeconds} s. Ctrl+C to stop.`);
        if (automation.mode === 'off') console.log('Automation is off (in the app\'s Automation page): no rounds run until it is turned on; jobs sent by hand still do.');
        console.log(`Publishing to and reading from: ${services.configured.join(', ')}`);
        await new Promise<void>((resolve) => {
          const stop = () => {
            console.log('\nStopping: the running jobs get a while to finish.');
            resolve();
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        await queue.stop();
        return 0;
      }

      case 'token': {
        const [action, arg] = rest;
        if (action === 'create' && arg) {
          const scopes = parseScopes(values.scopes ?? '');
          const { token, record } = await createApiToken({ registry, secrets }, arg, scopes);
          console.error(`Token #${record.id} "${record.name}" (${record.scopes.join(', ')}). It is shown only now:`);
          console.log(token);
          return 0;
        }
        if (action === 'list') {
          const tokens = await registry.apiTokens();
          if (tokens.length === 0) console.log('No API tokens yet.');
          for (const t of tokens) {
            const state = t.revokedAt ? `revoked ${t.revokedAt.slice(0, 16)}` : t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 16)}` : 'never used';
            console.log(`#${t.id}  ${t.name}  ${t.scopes.join(',')}  ${state}`);
          }
          return 0;
        }
        if (action === 'revoke' && arg && /^\d+$/.test(arg)) {
          const revoked = await registry.revokeApiToken(Number(arg));
          if (!revoked) {
            console.error(`no token #${arg}`);
            return 1;
          }
          console.log(`Revoked #${revoked.id} ${revoked.name}`);
          return 0;
        }
        console.error('token create <name> --scopes read,write | token list | token revoke <id>');
        return 2;
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
    console.error(error instanceof ConfigError || error instanceof InvalidScopes ? error.message : error);
    process.exit(1);
  },
);
