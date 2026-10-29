import { runCi } from './ci.ts';
import { runInit } from './init.ts';
import { isShipcastCheckout, runSetup } from './setup.ts';
import { readFileSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { resolve } from 'node:path';
import { checkStdioOptions, McpSetupError, serveShipcastStdio } from '@shipcast/mcp';
import { connectRepositories, draftLaunch, LaunchRefused, SecretRows, LaunchService, preflight, retryChannelEverywhere, TelemetryStore, type DraftResult, type Launch, type Preflight, type PublishResult } from '@shipcast/engine';
import { Channel } from '@shipcast/schema';
import { jobQueue } from '@shipcast/runtime/queue-factory';
import { processState, RedisLock } from '@shipcast/runtime/redis';
import {
  attachTelemetryStore,
  buildServices,
  fakeNetworks,
  previewDatabase,
  BY_HAND,
  ConfigError,
  createApiToken,
  createRuntime,
  Flags,
  installTelemetry,
  InvalidScopes,
  MIN_INTERVAL_SECONDS,
  parseScopes,
  publishOne,
  readAutomation,
  SettingMissing,
  settingDefinition,
  poolOptions,
  queuePoolMax,
  roleFromEnv,
  runsTheClock,
  split,
  startMaintenance,
  startWorking,
  workHandlers,
  writeAutomation,
  importYouTubeAccount,
  loadConfig,
  migrateSecrets,
  migrationLines,
  secretStoreFor,
  TableStore,
  YouTubeImportRefused,
  type RoundDeps,
} from '@shipcast/runtime';

/** What the CLI still does on a preview's database: nothing that builds a network's connector */
const PREVIEW_COMMANDS: ReadonlySet<string> = new Set(['token']);

/**
 * The repo's root, where `.env` is: three folders up from this file in Shipcast's checkout. Installed
 * from npm the CLI is a bundle in node_modules, with no checkout around it (IN_CHECKOUT false).
 */
const SOURCE_ROOT = resolve(import.meta.dirname, '../../..');
const IN_CHECKOUT = isShipcastCheckout(SOURCE_ROOT);
const ROOT = IN_CHECKOUT ? SOURCE_ROOT : process.cwd();

/** The package's version, set by the npm build; the checkout's is its package.json's */
declare const SHIPCAST_VERSION: string | undefined;
const VERSION = typeof SHIPCAST_VERSION === 'string' ? SHIPCAST_VERSION : (JSON.parse(readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')) as { version: string }).version;

/** What the npm package offers a developer outside Shipcast's checkout */
const PACKAGE_USAGE = `Usage: shipcast <command>   (npx @yeyo11/shipcast <command>)

Shipcast launches your GitHub projects: on each release it reads the code, writes the launch
content (article, posts) with the AI you choose and opens a drafts pull request in your launches
repo; merging it publishes everything, once.

  init                    Set up the GitHub Action in this repo: launch.yml, brand.yml, the two
                          workflows, and the secrets to set (shipcast init --help)
  ci <launch|publish|round> [flags]
                          What the Action runs, configured by the environment (shipcast ci --help)
  mcp [--url <url>] [--token <token>]
                          The MCP server over stdio, for a Shipcast app you run
  --version               This version

Guide: https://github.com/yeyo11/shipcast/blob/main/docs/getting-started.md
`;

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
  youtube import <file>               Connect YouTube once from a JSON file with your OAuth client and a
                                      refresh token (client_id, client_secret, refresh_token), through
                                      the same path as the sign-in; then delete the file
  token list                          The API tokens, revoked ones too
  secrets migrate [--from keychain|file]
                                      Copy every secret of the current store into the registry's
                                      encrypted table (SHIPCAST_SECRETS_KEY), each read back; prints
                                      key names and counts only, and leaves the source as it was
  token revoke <id>                   Revoke an API token at once
  init [--public-url <https://host>] [--login <login>]
                                      Set up a local install in this checkout: the bootstrap .env,
                                      Postgres, and your GitHub App from a manifest (docs/install.md);
                                      init --action sets up the GitHub Action in another repo instead
                                      (docs/getting-started.md)
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
  for (const launch of (await round.registry.launches.recent(100)).filter((l) => l.status === 'drafted')) reportPublish(await publishOne(launch, round, services));
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

/**
 * `shipcast secrets migrate [--from keychain|file]`: copies the install's secrets into the registry's
 * encrypted table, each read back. The source is the store SHIPCAST_SECRET_STORE names (or --from,
 * once that already says `table`), opened read-only in effect: nothing here writes to it. Only key
 * names and counts are printed.
 */
async function migrateCommand(args: string[], from: string | undefined): Promise<number> {
  if (args[0] !== 'migrate') {
    console.error('secrets migrate [--from keychain|file]');
    return 2;
  }
  const config = loadConfig(process.env, ROOT);
  const current = process.env.SHIPCAST_SECRET_STORE?.trim() || 'keychain';
  const source = from ?? (current === 'table' ? undefined : current);
  if (source !== 'keychain' && source !== 'file') {
    console.error(source === undefined ? 'SHIPCAST_SECRET_STORE is table already: name the store to copy from with --from keychain or --from file' : `--from is keychain or file, not "${source}"`);
    return 2;
  }
  const key = process.env.SHIPCAST_SECRETS_KEY?.trim();
  if (!key) {
    console.error('the table is sealed with SHIPCAST_SECRETS_KEY: set it first (openssl rand -base64 32)');
    return 2;
  }
  // The migrator's session lock must not go through PgBouncer: SHIPCAST_DATABASE_MIGRATE_URL is the direct address
  const registry = await connectRepositories(config.databaseUrl, poolOptions(process.env));
  try {
    const result = await migrateSecrets(secretStoreFor(config, { ...process.env, SHIPCAST_SECRET_STORE: source }), new TableStore(new SecretRows(registry.database), Buffer.from(key, 'base64')));
    for (const line of migrationLines(result)) console.log(line);
    return result.conflicts.length > 0 ? 1 : 0;
  } finally {
    await registry.close();
  }
}

async function main(argv: string[]): Promise<number> {
  // Action mode: its own flags and configuration (the environment only, no .env, no keychain), so it
  // is routed before the local install's arguments and runtime (docs/decisions/action-mode.md)
  if (argv[0] === 'ci') return runCi(argv.slice(1));
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(VERSION);
    return 0;
  }
  // Before there is an install to load. In Shipcast's own checkout it is the local install (it writes
  // the .env the runtime reads); anywhere else, the GitHub Action setup of a developer's own repo
  // (docs/decisions/github-action.md). --local and --action choose explicitly.
  if (argv[0] === 'init') {
    const rest = argv.slice(1);
    const local = rest.includes('--local') || (IN_CHECKOUT && !rest.includes('--action'));
    return local ? runInit(rest.filter((a) => a !== '--local'), ROOT) : runSetup(rest, process.cwd());
  }

  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { from: { type: 'string' }, ref: { type: 'string' }, interval: { type: 'string' }, url: { type: 'string' }, token: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, retry: { type: 'string' }, scopes: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(IN_CHECKOUT ? USAGE : PACKAGE_USAGE);
    return values.help ? 0 : 1;
  }
  // Outside the checkout there is no local install: no .env, no Postgres, no keychain
  if (!IN_CHECKOUT && command !== 'mcp') {
    console.error(`"${command}" is a command of the local install, run from Shipcast's own checkout.\n\n${PACKAGE_USAGE}`);
    return 2;
  }

  // Before the runtime: the MCP server needs no database or keychain, only the app's URL and a token
  if (command === 'mcp') return mcp(values.url, values.token);

  // Before the runtime, which imports .env settings into the current store at start: the migration's
  // source must be only read
  if (command === 'secrets') return migrateCommand(rest, values.from);

  // A preview's database (…_preview) only runs in the app, whose networks are fake there: the CLI builds
  // real connectors, so on a preview it only mints, lists and revokes API tokens
  if ((previewDatabase(process.env.SHIPCAST_DATABASE_URL) || fakeNetworks(process.env)) && !PREVIEW_COMMANDS.has(command)) {
    console.error(`"${command}" reaches the networks for real: on a preview with fake networks the CLI only runs ${[...PREVIEW_COMMANDS].join(', ')}`);
    return 2;
  }

  // Before the runtime, whose clients take the global fetch when they are built: every call is counted
  const telemetry = installTelemetry(command === 'watch' ? 'watch' : 'cli');
  const runtime = await createRuntime({ root: ROOT, log: (line) => console.error(line) });
  const { config, registry, github, secrets, settings, pipeline: deps } = runtime;
  attachTelemetryStore(new TelemetryStore(registry.database));
  const loadBrandNow = () => runtime.brand();
  // A queue sent to and worked here, on whichever backend the app's processes use (the bullmq flag)
  const cliQueue = () =>
    jobQueue({
      flags: Flags.fromEnv(process.env),
      registry,
      databaseUrl: config.databaseUrl,
      redis: processState(process.env, 'cli').redis,
      options: { instanceName: 'cli', schedule: false, supervise: false, pollingIntervalSeconds: 0.5, telemetry, reconcileAtStart: !split(roleFromEnv(process.env)) },
    });

  try {
    switch (command) {
      case 'status': {
        const launches = await registry.launches.recent();
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
          console.log(`Settings still to set in the app's Settings page: ${missing.map((n) => settingDefinition(n).label).join(', ')}`);
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
          for (const l of await retryChannelEverywhere(registry, channel.data, registry.attempts)) console.log(`Retrying ${channel.data} for ${l.repo} ${l.ref}`);
        }
        const brand = await loadBrandNow();
        await publishReady({ env: process.env, registry, github, secrets, brand, pipeline: deps });
        return 0;
      }

      case 'metrics': {
        // A job of the queue, sent and worked here, so the app lists it like any other reading
        const brand = await loadBrandNow();
        const queue = cliQueue();
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
        const queue = cliQueue();
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
        let claimed: Launch;
        try {
          ({ launch: claimed } = await new LaunchService({ launches: registry.launches, claims: deps, github }).claimManual(repo, values.ref, loadBrandNow, reportPreflight));
        } catch (error) {
          if (!(error instanceof LaunchRefused)) throw error;
          const found = error.launch;
          if (error.reason === 'not_ready') console.error(`${repo} is not ready to launch: fix the checks marked FAIL`);
          else if (error.reason === 'launched' && found) console.error(`${repo} ${found.ref} was launched already (${found.status}${found.detail ? `: ${found.detail.split('\n')[0]}` : ''})`);
          else console.error(error.message);
          return 1;
        }
        const brand = await loadBrandNow();
        console.log(`Drafting ${repo} ${claimed.ref} (${claimed.kind} pack); the analysis takes a few minutes...`);
        const result = await draftLaunch(claimed, brand, deps);
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
        const flags = Flags.fromEnv(process.env);
        // SHIPCAST_ROLE: a worker or a heavy worker works its own queues only; `all` (unset) every one but the web app's probe
        const role = roleFromEnv(process.env);
        if (role === 'web') {
          console.error('watch works queues: SHIPCAST_ROLE=web never does (worker, heavy or all)');
          return 2;
        }
        const proc = processState(process.env, `watch-${role}`);
        const queue = jobQueue({ flags, registry, databaseUrl: config.databaseUrl, redis: proc.redis, options: { instanceName: 'watch', telemetry, schedule: runsTheClock(role), supervise: runsTheClock(role), reconcileAtStart: !split(role), poolMax: queuePoolMax(process.env) } });
        // A worker of the same queue as the app: the same rounds and jobs, never one round twice
        await startWorking(queue, { env: process.env, registry, github, secrets, pipeline: deps, brand: loadBrandNow, refresh: runtime.refresh, flags, ...(runtime.drafts && { drafts: runtime.drafts }) }, { firstRoundInSeconds: 0, role });
        const stopMaintenance = runsTheClock(role) && (split(role) || flags.on('bullmq')) ? startMaintenance({ queue, lock: proc.redis ? new RedisLock(proc.redis.queue) : proc.shared.lock, reconcileRows: split(role) }) : undefined;
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
        stopMaintenance?.();
        await queue.stop();
        await proc.close();
        return 0;
      }

      case 'youtube': {
        const [action, file] = rest;
        if (action !== 'import' || !file) {
          console.error('youtube import <file>');
          return 2;
        }
        const brand = await loadBrandNow();
        let text: string;
        try {
          text = readFileSync(resolve(file), 'utf8');
        } catch {
          console.error(`Cannot read ${file}`);
          return 1;
        }
        try {
          // Only the outcome is printed, never a value of the file
          const result = await importYouTubeAccount({ registry, secrets, brands: new Map([[brand.id, brand]]) }, { text, brand: brand.id });
          if (!result.ok) {
            console.error(`YouTube refused the credentials: ${result.problem}`);
            return 1;
          }
          console.log(`Connected YouTube ${result.account.identity ?? result.account.label} (account ${result.account.id}); its secrets are in the ${secrets.kind}.`);
          console.log(`Delete ${file} now: Shipcast no longer needs it.`);
          return 0;
        } catch (error) {
          if (error instanceof YouTubeImportRefused) {
            console.error(`Not imported: ${error.message}`);
            return 1;
          }
          throw error;
        }
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
          const tokens = await registry.apiTokens.apiTokens();
          if (tokens.length === 0) console.log('No API tokens yet.');
          for (const t of tokens) {
            const state = t.revokedAt ? `revoked ${t.revokedAt.slice(0, 16)}` : t.lastUsedAt ? `last used ${t.lastUsedAt.slice(0, 16)}` : 'never used';
            console.log(`#${t.id}  ${t.name}  ${t.scopes.join(',')}  ${state}`);
          }
          return 0;
        }
        if (action === 'revoke' && arg && /^\d+$/.test(arg)) {
          const revoked = await registry.apiTokens.revokeApiToken(Number(arg));
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
    await telemetry.stop();
    await processState().close();
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
