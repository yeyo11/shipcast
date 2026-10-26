import { runCi } from './ci.ts';
import { runInit } from './init.ts';
import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { checkStdioOptions, McpSetupError, serveShipcastStdio } from '@shipcast/mcp';
import { claimManual, draftLaunch, preflight, type DraftResult, type Preflight, type PublishResult } from '@shipcast/engine';
import { Channel } from '@shipcast/schema';
import {
  buildServices,
  BY_HAND,
  ConfigError,
  createApiToken,
  createRuntime,
  InvalidScopes,
  MIN_INTERVAL_SECONDS,
  parseScopes,
  publishOne,
  readAutomation,
  SettingMissing,
  SETTINGS,
  startWorking,
  WorkQueue,
  workHandlers,
  writeAutomation,
  type RoundDeps,
} from '@shipcast/runtime';

/** The repo's root, where `.env` is: two folders up from this file */
const ROOT = resolve(import.meta.dirname, '../../..');

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
  sync [<account id>]                 Check every connected account (or one) and record today's
                                      followers, following and posts where its network counts them
  status                              The latest launches and where they stand, and what is configured
  token create <name> --scopes <list> A token for the REST API (/api/v1), scopes read, write or both
                                      (read,write); printed once, only its hash is kept
  token list                          The API tokens, revoked ones too
  token revoke <id>                   Revoke an API token at once
  init [--public-url <https://host>] [--login <login>]
                                      Set up a local install in this checkout: the bootstrap .env,
                                      Postgres, and your GitHub App from a manifest (docs/install.md)
  ci <launch|publish|round> [flags]   Action mode: the same work in GitHub Actions, configured by the
                                      environment, the registry kept on the launches repo's
                                      shipcast-state branch (shipcast ci --help, docs/decisions/action-mode.md)
  mcp [--url <url>] [--token <token>] The MCP server over stdio, for Claude Code and other clients:
                                      calls the app's REST API at SHIPCAST_API_URL (this checkout's
                                      SHIPCAST_PUBLIC_URL by default) with SHIPCAST_API_TOKEN, a
                                      read,write token (see docs/mcp.md)

The launches, their channels and numbers, drafts to review and articles to write are in the web
app: pnpm app (see docs/web-app.md).
`;

function report(result: DraftResult): void {
  if (result.ok) {
    console.log(`Drafted ${result.launch.repo} ${result.launch.ref}: ${result.pullRequest}`);
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
  for (const waiting of result.scheduled) console.log(`  ${waiting.channel} scheduled for ${waiting.at}`);
}

/** Publishes what is ready: each drafted launch whose pull request was merged and whose article is live. */
async function publishReady(round: RoundDeps): Promise<void> {
  const services = await buildServices({ env: round.env, brand: round.brand, registry: round.registry, github: round.github, secrets: round.secrets });
  for (const launch of (await round.registry.recent(100)).filter((l) => l.status === 'drafted')) reportPublish(await publishOne(launch, round, services));
}

/**
 * The app's public URL from this checkout's .env, when there is one: `shipcast mcp` on the machine the
 * app runs on then needs only the token. Read alone, so the MCP process never loads the other secrets.
 */
function localPublicUrl(): string | undefined {
  try {
    return parseEnv(readFileSync(resolve(ROOT, '.env'), 'utf8')).SHIPCAST_PUBLIC_URL;
  } catch {
    return undefined;
  }
}

/** Serves MCP over stdio until the client closes it; stdout is the protocol, so nothing else is printed there */
async function mcp(url: string | undefined, token: string | undefined): Promise<number> {
  const options = checkStdioOptions({ url: url ?? process.env.SHIPCAST_API_URL ?? localPublicUrl(), token: token ?? process.env.SHIPCAST_API_TOKEN });
  const handle = serveShipcastStdio(options);
  console.error(`shipcast mcp: serving over stdio, calling ${options.url}/api/v1`);
  await new Promise<void>((done) => {
    process.stdin.once('end', done);
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await handle.close();
  return 0;
}

async function main(argv: string[]): Promise<number> {
  // Action mode: its own flags and configuration (the environment only, no .env, no keychain), so it
  // is routed before the local install's arguments and runtime (docs/decisions/action-mode.md)
  if (argv[0] === 'ci') return runCi(argv.slice(1));
  // Before there is an install to load: it writes the .env the runtime reads
  if (argv[0] === 'init') return runInit(argv.slice(1), ROOT);

  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { ref: { type: 'string' }, interval: { type: 'string' }, url: { type: 'string' }, token: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, retry: { type: 'string' }, scopes: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  // Before the runtime: the MCP server needs no database or keychain, only the app's URL and a token
  if (command === 'mcp') return mcp(values.url, values.token);

  const runtime = await createRuntime({ root: ROOT, log: (line) => console.error(line) });
  const { config, registry, github, secrets, settings, pipeline: deps } = runtime;
  const loadBrandNow = () => runtime.brand();

  try {
    switch (command) {
      case 'status': {
        const launches = await registry.recent();
        if (launches.length === 0) console.log('No launches yet.');
        for (const l of launches) {
          console.log(`${l.createdAt.slice(0, 16).replace('T', ' ')}  ${l.repo} ${l.ref}  ${l.kind}  ${l.status}${l.detail ? `  ${l.detail.split('\n')[0]}` : ''}`);
        }
        const access = runtime.access;
        if (access.kind === 'app') {
          const installation = await runtime.githubApp!.installation().then(
            (i) => `installed on ${i.account} (${i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'})`,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
          console.log(`\nGitHub: the App${access.slug ? ` ${access.slug}` : ''}, ${installation}; commits by ${access.bot ?? 'its bot'}`);
          const user = (await runtime.userTokens!.token()) ? await runtime.userTokens!.stored() : undefined;
          console.log(`GitHub user token: ${user ? `@${user.login}${user.expiresAt ? `, valid until ${user.expiresAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` : 'none yet (it is kept when the owner signs in to the app)'}`);
        } else {
          console.log('\nGitHub: GITHUB_TOKEN_PERSONAL (no GitHub App in .env)');
        }
        const missing = settings.missing();
        if (missing.length > 0) {
          console.log(`Settings still to set in the app's Settings page: ${missing.map((n) => SETTINGS[n].label).join(', ')}`);
          return 0;
        }
        const brand = await loadBrandNow();
        const services = await buildServices({ env: process.env, brand, registry, github, secrets });
        console.log(`Configured: ${services.configured.join(', ')}`);
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
        const brand = await loadBrandNow();
        await publishReady({ env: process.env, registry, github, secrets, brand, pipeline: deps });
        return 0;
      }

      case 'metrics': {
        // A job of the queue, sent and worked here, so the app lists it like any other reading
        const brand = await loadBrandNow();
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

      case 'sync': {
        // The snapshots job, sent and worked here like `metrics`: every account, or the one named
        const accountId = rest[0] === undefined ? undefined : Number(rest[0]);
        if (accountId !== undefined && !Number.isInteger(accountId)) {
          console.error(`sync takes an account id, not "${rest[0]}"`);
          return 2;
        }
        const brand = await loadBrandNow();
        const queue = WorkQueue.postgres(config.databaseUrl, registry, { instanceName: 'cli', schedule: false, supervise: false, pollingIntervalSeconds: 0.5 });
        try {
          const id = await queue.send(
            'snapshots',
            { reason: BY_HAND, ...(accountId !== undefined && { accountId }) },
            { title: 'Syncing the accounts, by hand', singletonKey: accountId === undefined ? BY_HAND : `account:${accountId}` },
          );
          if (!id) {
            console.error('A sync by hand is queued already.');
            return 1;
          }
          const { snapshots } = workHandlers(queue, { env: process.env, registry, github, secrets, pipeline: deps, brand: async () => brand });
          await queue.work({ snapshots });
          const done = await queue.wait(id, 10 * 60_000);
          for (const line of done?.log ?? []) console.log(line);
          if (!done) console.error('The sync did not end within 10 minutes.');
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
        const brand = await loadBrandNow();
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
        const brand = await loadBrandNow();
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
        await startWorking(queue, { env: process.env, registry, github, secrets, pipeline: deps, brand: loadBrandNow, refresh: runtime.refresh }, { firstRoundInSeconds: 0 });
        console.log(`Working Shipcast's job queue for ${brand.github}'s releases and ${deps.launchesRepo}: ${automation.mode} mode, a round every ${automation.intervalSeconds} s. Ctrl+C to stop.`);
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
    console.error(error instanceof ConfigError || error instanceof InvalidScopes || error instanceof SettingMissing || error instanceof McpSetupError ? error.message : error);
    process.exit(1);
  },
);
