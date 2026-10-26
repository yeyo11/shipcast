import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

/*
 * `shipcast init`: a local install from a fresh clone, in one command. It writes the bootstrap `.env`
 * (the only settings the app needs before anyone signs in, docs/decisions/github-app.md), starts the
 * registry's Postgres, and creates the owner's GitHub App from a manifest, so the next step is the
 * web app's onboarding. Everything else is set there, not here.
 */

export const INIT_USAGE = `Usage: shipcast init [flags]

Sets up a local install in this checkout: the bootstrap .env, the registry's Postgres
(docker compose), and your GitHub App, created from a manifest on GitHub. Then start the app
(pnpm app) and finish in its onboarding.

  --public-url <https://host>   The app's address (GitHub signs you in there). Without one, the app
                                runs on this machine over plain HTTP and you sign in with the
                                one-time link it prints
  --login <github login>        The GitHub account allowed to sign in (the owner)
  --skip-docker                 Do not start Postgres (you run your own: set SHIPCAST_DATABASE_URL)
  --skip-github-app             Do not create the GitHub App now
  --yes                         Ask nothing: take the flags and the defaults
`;

export interface InitOptions {
  publicUrl: string | undefined;
  login: string;
  /** The Postgres password docker compose creates the database with */
  postgresPassword: string;
  /** claudio's token: docker-compose.yml refuses to start any service without it */
  claudioToken: string;
}

/** The address the app is reached at when the owner gives none: this machine, plain HTTP */
export const LOCAL_URL = 'http://127.0.0.1:8744';

/**
 * The bootstrap `.env`: what the app reads before anyone signs in. The GitHub App's lines are added
 * once the App exists; every other setting is made in the onboarding.
 */
export function bootstrapEnv(options: InitOptions): string {
  const tls = options.publicUrl !== undefined;
  const lines = [
    '# Written by `shipcast init`: the settings Shipcast needs before anyone signs in.',
    '# Everything else is set in the web app (onboarding and Settings). See .env.example.',
    '',
    '# The registry: the Postgres of docker-compose.yml, on this machine only',
    `POSTGRES_PASSWORD=${options.postgresPassword}`,
    `SHIPCAST_DATABASE_URL=postgres://shipcast:${options.postgresPassword}@127.0.0.1:5433/shipcast`,
    '',
    '# claudio, the AI provider of docker-compose.yml (optional: `docker compose up -d claudio`)',
    `SHIPCAST_CLAUDIO_TOKEN=${options.claudioToken}`,
    '',
    '# Who may sign in',
    `SHIPCAST_ALLOWED_GITHUB=${options.login}`,
    '',
  ];
  if (tls) {
    lines.push(
      '# The app at its own https address; its certificate comes from Let’s Encrypt through',
      '# Cloudflare DNS: set the token below, or serve it behind your own TLS and set SHIPCAST_APP_TLS=off',
      `SHIPCAST_PUBLIC_URL=${options.publicUrl}`,
      'SHIPCAST_TLS_CLOUDFLARE_TOKEN=',
    );
  } else {
    lines.push(
      '# The app on this machine over plain HTTP; sign in with the one-time link it prints at start.',
      '# GitHub sign-in needs an https address: set SHIPCAST_PUBLIC_URL when you have one.',
      'SHIPCAST_PUBLIC_URL=https://shipcast.localhost',
      'SHIPCAST_APP_TLS=off',
      'SHIPCAST_APP_HOST=127.0.0.1',
      'SHIPCAST_APP_PORT=8744',
      'SHIPCAST_APP_TAILSCALE=off',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The GitHub App's manifest (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest):
 * the permissions the engine uses, the events it acts on, and where GitHub sends the owner back.
 */
export function appManifest(options: { login: string; baseUrl: string; redirectUrl: string }): Record<string, unknown> {
  return {
    name: `Shipcast ${options.login}`.slice(0, 34),
    url: 'https://github.com/yeyo11/shipcast',
    description: `Shipcast for ${options.login}: reads the repos' releases, traffic and the launches repo, opens drafts pull requests and posts launch discussions.`,
    public: false,
    redirect_url: options.redirectUrl,
    callback_urls: [`${options.baseUrl}/auth/github/callback`],
    setup_url: `${options.baseUrl}/`,
    request_oauth_on_install: false,
    // A machine nobody can reach takes no webhooks: Shipcast polls until it has a public address
    hook_attributes: { url: `${options.baseUrl}/api/github/webhook`, active: options.baseUrl.startsWith('https://') && !options.baseUrl.endsWith('.localhost') },
    default_events: ['release', 'pull_request', 'repository', 'push'],
    // Administration: read is only for a repo's traffic (views and unique visitors), which GitHub keeps behind it
    default_permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', discussions: 'write', administration: 'read' },
  };
}

/** The `.env` lines of the App GitHub returned from the manifest's conversion */
export function appEnvLines(app: { id: number; slug: string; client_id: string; client_secret: string; webhook_secret: string | null }, keyFile: string): string {
  return [
    '',
    `# Your GitHub App (${app.slug}), created by \`shipcast init\``,
    `SHIPCAST_GITHUB_APP_ID=${app.id}`,
    `SHIPCAST_GITHUB_APP_SLUG=${app.slug}`,
    `SHIPCAST_GITHUB_APP_CLIENT_ID=${app.client_id}`,
    `SHIPCAST_GITHUB_APP_CLIENT_SECRET=${app.client_secret}`,
    `SHIPCAST_GITHUB_APP_WEBHOOK_SECRET=${app.webhook_secret ?? ''}`,
    `SHIPCAST_GITHUB_APP_PRIVATE_KEY_FILE=${keyFile}`,
    '',
  ].join('\n');
}

/** An existing install is never overwritten: its .env holds the owner's keys */
export function refuseExisting(envPath: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const text = readFileSync(envPath, 'utf8');
  return /^SHIPCAST_(GITHUB_APP_ID|DATABASE_URL)=.+$/m.test(text)
    ? `${envPath} exists and holds an install's settings; shipcast init never overwrites it. Move it aside to start again.`
    : undefined;
}

interface InitArgs {
  publicUrl: string | undefined;
  login: string | undefined;
  skipDocker: boolean;
  skipGitHubApp: boolean;
  yes: boolean;
}

export function parseInitArgs(argv: string[]): InitArgs | { error: string } {
  const args: InitArgs = { publicUrl: undefined, login: undefined, skipDocker: false, skipGitHubApp: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === '--public-url') args.publicUrl = value();
    else if (flag === '--login') args.login = value();
    else if (flag === '--skip-docker') args.skipDocker = true;
    else if (flag === '--skip-github-app') args.skipGitHubApp = true;
    else if (flag === '--yes' || flag === '-y') args.yes = true;
    else return { error: `unknown flag ${flag}` };
  }
  if (args.publicUrl !== undefined) {
    args.publicUrl = args.publicUrl.replace(/\/+$/, '');
    if (!/^https:\/\/[^/]+$/.test(args.publicUrl)) return { error: `--public-url must be https://host, not "${args.publicUrl}"` };
  }
  if (args.login !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(args.login)) return { error: `--login must be a GitHub login, not "${args.login}"` };
  return args;
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): boolean {
  return spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } }).status === 0;
}

/** Creates the App: a page on this machine posts the manifest to GitHub, which sends the owner back with a code */
async function createGitHubApp(root: string, login: string, baseUrl: string, log: (line: string) => void): Promise<boolean> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const manifest = appManifest({ login, baseUrl, redirectUrl: `http://127.0.0.1:${port}/created` });
  const escaped = JSON.stringify(manifest).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
  const page = `<!doctype html><meta charset=utf-8><title>Create Shipcast's GitHub App</title><body style="font:16px system-ui;max-width:640px;margin:60px auto">
<h1>Your GitHub App for Shipcast</h1><p>GitHub shows you the App before creating it; press <b>Create</b> there and come back here on your own.</p>
<form action="https://github.com/settings/apps/new" method="post"><input type="hidden" name="manifest" value='${escaped}'><button style="font-size:18px;padding:10px 18px">Create it on GitHub</button></form>`;
  const done = new Promise<boolean>((resolve) => {
    server.on('request', async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(page);
        return;
      }
      if (url.pathname !== '/created') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code') ?? '';
      const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST', headers: { accept: 'application/vnd.github+json' } });
      if (!response.ok) {
        res.writeHead(502).end(`GitHub refused the conversion (${response.status}). Run shipcast init again.`);
        resolve(false);
        return;
      }
      const app = (await response.json()) as { id: number; slug: string; client_id: string; client_secret: string; webhook_secret: string | null; pem: string };
      const keyFile = 'data/github-app.pem';
      mkdirSync(join(root, 'data'), { recursive: true });
      writeFileSync(join(root, keyFile), app.pem, { mode: 0o600 });
      chmodSync(join(root, keyFile), 0o600);
      writeFileSync(join(root, '.env'), appEnvLines(app, keyFile), { flag: 'a' });
      log(`GitHub App ${app.slug} created; its key is in ${keyFile}.`);
      // Straight on to installing it on the repos Shipcast should see
      res.writeHead(302, { location: `https://github.com/apps/${app.slug}/installations/new` }).end();
      resolve(true);
    });
  });
  log(`Open http://127.0.0.1:${port}/ in a browser on this machine to create your GitHub App.`);
  const created = await done;
  server.close();
  return created;
}

/** `shipcast init`: the exit code */
export async function runInit(argv: string[], root: string, log: (line: string) => void = console.log): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(INIT_USAGE);
    return 0;
  }
  const parsed = parseInitArgs(argv);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${INIT_USAGE}`);
    return 2;
  }
  const envPath = join(root, '.env');
  const refused = refuseExisting(envPath);
  if (refused) {
    console.error(refused);
    return 1;
  }

  const prompt = parsed.yes ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (question: string, fallback: string | undefined) =>
      prompt ? (await prompt.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback : fallback;
    const login = parsed.login ?? (await ask('Your GitHub login (the account allowed to sign in)', undefined));
    if (!login || !/^[A-Za-z0-9-]{1,39}$/.test(login)) {
      console.error('A GitHub login is needed: --login <login>.');
      return 2;
    }
    const answer = parsed.publicUrl ?? (await ask('The app’s https address, if you have one (empty: this machine only)', undefined));
    const publicUrl = answer ? answer.replace(/\/+$/, '') : undefined;
    if (publicUrl !== undefined && !/^https:\/\/[^/]+$/.test(publicUrl)) {
      console.error(`The address must be https://host, not "${publicUrl}".`);
      return 2;
    }

    writeFileSync(envPath, bootstrapEnv({ publicUrl, login, postgresPassword: randomBytes(24).toString('hex'), claudioToken: randomBytes(32).toString('hex') }), { mode: 0o600 });
    log(`Wrote ${envPath}.`);

    if (!parsed.skipDocker) {
      log('Starting the registry’s Postgres (docker compose up -d postgres)…');
      if (!run('docker', ['compose', 'up', '-d', '--wait', 'postgres'], root)) {
        console.error('docker compose could not start Postgres. Start it yourself, or point SHIPCAST_DATABASE_URL at your own.');
        return 1;
      }
    }

    if (!parsed.skipGitHubApp) {
      const created = await createGitHubApp(root, login, publicUrl ?? LOCAL_URL, log);
      if (!created) return 1;
    }

    log(
      [
        '',
        'Done. Next:',
        '  pnpm app        start the app, then open it and finish in its onboarding',
        publicUrl ? `                  (${publicUrl}; set SHIPCAST_TLS_CLOUDFLARE_TOKEN in .env for its certificate)` : `                  (${LOCAL_URL}, signed in with the one-time link it prints)`,
        '  docs/install.md for what each step did and the GitHub Action mode',
      ].join('\n'),
    );
    return 0;
  } finally {
    prompt?.close();
  }
}
