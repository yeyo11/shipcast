import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ACTION_VARIABLES } from '@shipcast/runtime';
import { Brand, CHANNELS, parseBrand, parseLaunchConfig, type Channel, type Language } from '@shipcast/schema';

/*
 * `shipcast init` in a developer's own project repo: the GitHub Action setup in one command
 * (docs/decisions/github-action.md). It writes launch.yml and the launch workflow in the project,
 * brand.yml and the publish workflow in the launches repo's checkout, and prints the secrets to set,
 * each with where to get it. It never writes a secret, and never overwrites a file without --force.
 */

/** The Action every workflow uses; its major tag moves with compatible releases */
export const ACTION = 'yeyo11/shipcast-action@v1';

/**
 * The channels Action mode publishes (the runtime's ACTION_VARIABLES) that `init` sets up: Instagram
 * and the newsletter read secrets too but need more setup than it asks for (docs/getting-started.md),
 * so they are turned on by hand.
 */
const SET_UP_BY_HAND: readonly Channel[] = ['instagram', 'newsletter'];
export const ACTION_CHANNELS = CHANNELS.filter((c) => ACTION_VARIABLES[c] !== undefined && !SET_UP_BY_HAND.includes(c));
export type ActionChannel = Channel;
export const DEFAULT_CHANNELS: ActionChannel[] = ['blog', 'devto', 'bluesky', 'mastodon', 'githubDiscussions'];

export const SETUP_USAGE =`Usage: npx @yeyo11/shipcast init [flags]

Sets up Shipcast's GitHub Action for this repo: on each release it reads the code, writes the launch
content with the AI you choose and opens a drafts pull request in your launches repo (your blog);
merging it publishes the article and every channel you turned on.

  --repo <owner/name>            This project (default: the origin remote)
  --launches-repo <owner/name>   Your launches repo, where drafts arrive (default: <owner>/launches)
  --launches-dir <path>          Its local checkout, to write brand.yml and the publish workflow in
                                 (default: ../<name> when it is that repo, else ./shipcast-launches)
  --brand <id>                   The brand's id (default: your login, lowercase)
  --name <display name>          Who the launches speak for (default: git's user.name)
  --site <https://…>             Your blog's address, where articles are published
  --languages <en|es|en,es>      The blog's languages (default: en)
  --ai <anthropic|openai>        The AI the content is written with (default: anthropic)
  --channels <list>              Comma-separated, from ${ACTION_CHANNELS.join(', ')}
                                 (default: ${DEFAULT_CHANNELS.join(', ')})
  --force                        Overwrite files that exist
  --yes                          Ask nothing: take the flags and the defaults
`;

export type SetupAi = 'anthropic' | 'openai';

export interface SetupOptions {
  repo: string;
  launchesRepo: string;
  brand: { id: string; displayName: string; site: string; github: string; languages: Language[] };
  ai: SetupAi;
  channels: ActionChannel[];
}

/** One secret or variable to set, where, and how to get its value */
export interface SecretToSet {
  name: string;
  repo: string;
  kind: 'secret' | 'variable';
  why: string;
  /** Where to get it; a variable's value when it is known */
  how: string;
  value?: string;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;

/** A YAML scalar that is always read back as the same string */
function q(text: string): string {
  return JSON.stringify(text);
}

export function renderLaunchYml(options: SetupOptions): string {
  const on = new Set<Channel>(options.channels);
  const lines = [
    '# Shipcast: whether and how this project is launched (https://github.com/yeyo11/shipcast/blob/main/docs/launch-yml.md).',
    '# Each channel is auto (published without review), approval (published when you merge the drafts',
    '# pull request) or off. A channel publishes only once its secrets are set in the launches repo.',
    'enabled: true',
    `brand: ${options.brand.id}`,
    'language: en',
    '',
    'triggers:',
    '  release: true      # a published release',
    '  manual: true       # the workflow run by hand',
    '',
    'publishing:',
    ...CHANNELS.map((channel) => `  ${channel}: ${on.has(channel) ? 'approval' : 'off'}`),
    '',
    '# A demo makes the launch: a GIF in the repo, or the deployed project to record one from',
    '# assets:',
    '#   demo: docs/demo.gif',
    '#   site: https://your-project.example',
    '',
  ];
  return lines.join('\n');
}

export function renderBrandYml(options: SetupOptions): string {
  const b = options.brand;
  return [
    '# Shipcast: who the launches in this repo speak for (https://github.com/yeyo11/shipcast/blob/main/docs/brands.md).',
    '# Public information only: tokens are repository secrets, never here.',
    `id: ${b.id}`,
    `displayName: ${q(b.displayName)}`,
    `site: ${b.site}`,
    `github: ${b.github}`,
    'languages:',
    `  blog: [${b.languages.join(', ')}]`,
    '# How the AI writes for you, in a few sentences',
    'tone: ""',
    'handles: {}',
    '# handles:',
    '#   bluesky: https://bsky.app/profile/you.bsky.social',
    '#   mastodon: https://mastodon.social/@you',
    '#   devto: https://dev.to/you',
    '',
  ].join('\n');
}

const AI_SECRET: Record<SetupAi, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' };

export function renderReleaseWorkflow(options: Pick<SetupOptions, 'launchesRepo' | 'ai'>): string {
  return `# Shipcast, in a project repo (written by \`npx @yeyo11/shipcast init\`).
#
# On a published release, or run by hand with a tag, Shipcast reads the code at that tag, writes the
# launch content and opens a drafts pull request in your launches repo. Nothing is published until you
# merge it. .github/launch.yml decides what is launched; a release is launched once, whatever re-runs.
#
# Secrets: SHIPCAST_GITHUB_TOKEN, and ${AI_SECRET.anthropic} or ${AI_SECRET.openai}.
# Variables (optional): SHIPCAST_AI_PROVIDER (anthropic or openai), SHIPCAST_AI_MODEL, SHIPCAST_DRY_RUN.
name: Shipcast launch

on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag:
        description: The release's tag to launch (the latest release if empty)
        required: false
        type: string
      dry-run:
        description: Print what would be done; nothing is saved, written or published
        required: false
        default: false
        type: boolean

# One launch of a release at a time; launching twice is refused by the state either way
concurrency:
  group: shipcast-\${{ github.event.release.tag_name || inputs.tag || github.run_id }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  launch:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: ${ACTION}
        with:
          command: launch
          launches-repo: ${options.launchesRepo}
          github-token: \${{ secrets.SHIPCAST_GITHUB_TOKEN }}
          ai-provider: \${{ vars.SHIPCAST_AI_PROVIDER || '${options.ai}' }}
          ai-api-key: \${{ (vars.SHIPCAST_AI_PROVIDER || '${options.ai}') == 'openai' && secrets.OPENAI_API_KEY || secrets.ANTHROPIC_API_KEY }}
          ai-model: \${{ vars.SHIPCAST_AI_MODEL }}
          dry-run: \${{ inputs.dry-run == true || vars.SHIPCAST_DRY_RUN == 'true' }}
`;
}

/** The variables each channel's secrets are, in the publish workflow's env: the set Action mode prefers */
const CHANNEL_SECRETS = (channel: ActionChannel): readonly string[] => ACTION_VARIABLES[channel]?.[0] ?? [];

export function renderPublishWorkflow(options: Pick<SetupOptions, 'channels'>): string {
  const names = options.channels.flatMap((c) => CHANNEL_SECRETS(c));
  const env = names.length > 0 ? `\n        env:\n${names.map((n) => `          ${n}: \${{ secrets.${n} }}`).join('\n')}` : '';
  return `# Shipcast, in the launches repo (written by \`npx @yeyo11/shipcast init\`).
#
# When a drafts pull request (launch/*) is merged, Shipcast publishes that launch to every channel its
# launch.yml turns on, once the article is live. Every hour it also publishes what is due (a scheduled
# piece, a channel to retry). A channel without its secrets is not published to.
#
# Secrets: SHIPCAST_GITHUB_TOKEN (this workflow's own token is the fallback), and each channel's.
# Variables (optional): SHIPCAST_DRY_RUN=true lists what would be posted and posts nothing.
name: Shipcast publish

on:
  pull_request:
    types: [closed]
  schedule:
    - cron: "17 * * * *"
  workflow_dispatch:
    inputs:
      dry-run:
        description: List what would be published; nothing is posted or saved
        required: false
        default: false
        type: boolean

concurrency:
  group: shipcast-\${{ github.event.pull_request.number || 'round' }}
  cancel-in-progress: false

permissions:
  # The launch registry lives on this repo's shipcast-state branch
  contents: write
  pull-requests: read

jobs:
  publish:
    if: github.event_name != 'pull_request' || (github.event.pull_request.merged == true && startsWith(github.event.pull_request.head.ref, 'launch/'))
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: ${ACTION}
        with:
          command: \${{ github.event_name == 'pull_request' && 'publish' || 'round' }}
          launches-repo: \${{ github.repository }}
          github-token: \${{ secrets.SHIPCAST_GITHUB_TOKEN || github.token }}
          dry-run: \${{ inputs.dry-run == true || vars.SHIPCAST_DRY_RUN == 'true' }}${env}
`;
}

const TOKEN_HOW =
  'a fine-grained token at https://github.com/settings/personal-access-tokens/new: only this project and the launches repo; Contents, Pull requests and Discussions read and write';

const CHANNEL_HOW: Record<string, string> = {
  DEVTO_API_KEY: 'https://dev.to/settings/extensions (DEV Community API Keys)',
  BLUESKY_HANDLE: 'your handle, like you.bsky.social',
  BLUESKY_APP_PASSWORD: 'https://bsky.app/settings/app-passwords',
  MASTODON_INSTANCE: 'your server, like mastodon.social',
  MASTODON_ACCESS_TOKEN: 'https://<your server>/settings/applications (New application; scopes read, write:statuses, write:media)',
  HASHNODE_TOKEN: 'https://hashnode.com/settings/developer',
  HASHNODE_PUBLICATION_HOST: 'your publication, like you.hashnode.dev',
  TELEGRAM_BOT_TOKEN: 'https://t.me/BotFather (/newbot), then add the bot to your channel as an admin',
  TELEGRAM_CHAT_ID: 'your channel, like @yourchannel',
  DISCORD_WEBHOOK_URL: 'Server Settings > Integrations > Webhooks (https://support.discord.com/hc/en-us/articles/228383668)',
};

/** Every secret and variable the setup needs, in the order to set them */
export function secretsToSet(options: SetupOptions): SecretToSet[] {
  const out: SecretToSet[] = [
    { name: 'SHIPCAST_GITHUB_TOKEN', repo: options.repo, kind: 'secret', why: 'opens the drafts pull request in the launches repo', how: TOKEN_HOW },
    options.ai === 'anthropic'
      ? { name: 'ANTHROPIC_API_KEY', repo: options.repo, kind: 'secret', why: 'writes the launch content', how: 'https://console.anthropic.com/settings/keys' }
      : { name: 'OPENAI_API_KEY', repo: options.repo, kind: 'secret', why: 'writes the launch content', how: 'https://platform.openai.com/api-keys' },
    { name: 'SHIPCAST_AI_PROVIDER', repo: options.repo, kind: 'variable', why: 'the AI, switchable later without editing the workflow', how: 'anthropic or openai', value: options.ai },
  ];
  if (options.launchesRepo !== options.repo) {
    out.push({ name: 'SHIPCAST_GITHUB_TOKEN', repo: options.launchesRepo, kind: 'secret', why: 'reads the project and posts its GitHub Discussion (optional: the workflow token is the fallback)', how: 'the same token' });
  }
  for (const channel of options.channels) {
    for (const name of CHANNEL_SECRETS(channel)) {
      out.push({ name, repo: options.launchesRepo, kind: 'secret', why: `publishes to ${channel}`, how: CHANNEL_HOW[name] ?? '' });
    }
  }
  return out;
}

export function secretsReport(list: SecretToSet[]): string {
  const lines = ['Set these (Settings > Secrets and variables > Actions, or with the GitHub CLI):', ''];
  for (const s of list) {
    lines.push(`  ${s.kind === 'secret' ? 'secret  ' : 'variable'} ${s.name}  in ${s.repo}: ${s.why}`);
    lines.push(`           ${s.kind === 'variable' && s.value ? `value: ${s.value}` : `get it: ${s.how}`}`);
    lines.push(`           ${s.kind === 'secret' ? `gh secret set ${s.name} --repo ${s.repo}` : `gh variable set ${s.name} --repo ${s.repo} --body ${s.value ?? '<value>'}`}`);
  }
  return lines.join('\n');
}

/** owner/name from a GitHub remote URL, https or ssh */
export function repoFromRemote(url: string): string | undefined {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function originOf(dir: string): string | undefined {
  const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? repoFromRemote(result.stdout) : undefined;
}

function gitUserName(dir: string): string | undefined {
  const result = spawnSync('git', ['config', 'user.name'], { cwd: dir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

/** Where the launches repo's files go: the flag, this repo, a sibling checkout of it, or a folder to copy over */
export function launchesDirFor(cwd: string, repo: string, launchesRepo: string, flag: string | undefined, origin: (dir: string) => string | undefined = originOf): { dir: string; copy: boolean } {
  if (flag) return { dir: resolve(cwd, flag), copy: false };
  if (launchesRepo.toLowerCase() === repo.toLowerCase()) return { dir: cwd, copy: false };
  const sibling = join(dirname(cwd), launchesRepo.split('/')[1]!);
  if (existsSync(join(sibling, '.git')) && origin(sibling)?.toLowerCase() === launchesRepo.toLowerCase()) return { dir: sibling, copy: false };
  return { dir: join(cwd, 'shipcast-launches'), copy: true };
}

interface SetupArgs {
  repo?: string;
  launchesRepo?: string;
  launchesDir?: string;
  brand?: string;
  name?: string;
  site?: string;
  languages?: string;
  ai?: string;
  channels?: string;
  force: boolean;
  yes: boolean;
}

const FLAGS: Record<string, keyof Omit<SetupArgs, 'force' | 'yes'>> = {
  '--repo': 'repo',
  '--launches-repo': 'launchesRepo',
  '--launches-dir': 'launchesDir',
  '--brand': 'brand',
  '--name': 'name',
  '--site': 'site',
  '--languages': 'languages',
  '--ai': 'ai',
  '--channels': 'channels',
};

export function parseSetupArgs(argv: string[]): SetupArgs | { error: string } {
  const args: SetupArgs = { force: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === '--force') args.force = true;
    else if (flag === '--yes' || flag === '-y') args.yes = true;
    else if (flag === '--action') continue;
    else if (FLAGS[flag]) {
      const value = argv[++i];
      if (value === undefined) return { error: `${flag} needs a value` };
      args[FLAGS[flag]] = value;
    } else return { error: `unknown flag ${flag}` };
  }
  return args;
}

/** Turns the answers into options, or every problem with them */
export function setupOptions(answers: { repo?: string | undefined; launchesRepo?: string | undefined; brand?: string | undefined; name?: string | undefined; site?: string | undefined; languages?: string | undefined; ai?: string | undefined; channels?: string | undefined }): SetupOptions | { errors: string[] } {
  const errors: string[] = [];
  const repo = answers.repo ?? '';
  if (!REPO.test(repo)) errors.push(`the project must be owner/name, not "${repo}"`);
  const owner = repo.split('/')[0] ?? '';
  const launchesRepo = answers.launchesRepo ?? `${owner}/launches`;
  if (!REPO.test(launchesRepo)) errors.push(`the launches repo must be owner/name, not "${launchesRepo}"`);
  const ai = answers.ai ?? 'anthropic';
  if (ai !== 'anthropic' && ai !== 'openai') errors.push(`the AI is anthropic or openai, not "${ai}"`);
  const languages = (answers.languages ?? 'en').split(',').map((l) => l.trim()).filter(Boolean);
  const channels = (answers.channels ?? DEFAULT_CHANNELS.join(',')).split(',').map((c) => c.trim()).filter(Boolean);
  const unknown = channels.filter((c) => !(ACTION_CHANNELS as readonly string[]).includes(c));
  if (unknown.length > 0) errors.push(`unknown channels ${unknown.join(', ')}: choose from ${ACTION_CHANNELS.join(', ')}`);
  const brand = Brand.safeParse({ id: answers.brand ?? owner.toLowerCase(), displayName: answers.name ?? owner, site: answers.site ?? '', github: owner, languages: { blog: languages } });
  if (!brand.success) for (const issue of brand.error.issues) errors.push(`brand ${issue.path.join('.')}: ${issue.message}`);
  if (errors.length > 0 || !brand.success) return { errors };
  return {
    repo,
    launchesRepo,
    ai: ai as SetupAi,
    channels: channels as ActionChannel[],
    brand: { id: brand.data.id, displayName: brand.data.displayName, site: brand.data.site, github: owner, languages: brand.data.languages.blog },
  };
}

/** The files to write: path and content, the launches repo's under its own folder */
export function setupFiles(options: SetupOptions, projectDir: string, launchesDir: string): Array<{ path: string; content: string }> {
  const project = [
    { path: join(projectDir, '.github', 'launch.yml'), content: renderLaunchYml(options) },
    { path: join(projectDir, '.github', 'workflows', 'shipcast.yml'), content: renderReleaseWorkflow(options) },
  ];
  const launches = [
    { path: join(launchesDir, 'brand.yml'), content: renderBrandYml(options) },
    { path: join(launchesDir, '.github', 'workflows', 'shipcast-publish.yml'), content: renderPublishWorkflow(options) },
  ];
  return [...project, ...launches];
}

/** `shipcast init` for the GitHub Action: the exit code */
export async function runSetup(argv: string[], cwd: string, log: (line: string) => void = console.log): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    log(SETUP_USAGE);
    return 0;
  }
  const parsed = parseSetupArgs(argv);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n\n${SETUP_USAGE}`);
    return 2;
  }
  const prompt = parsed.yes || !process.stdin.isTTY ? undefined : createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ask = async (question: string, given: string | undefined, fallback: string | undefined) => {
      if (given !== undefined) return given;
      if (!prompt) return fallback;
      return (await prompt.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback;
    };
    const repo = await ask('This project, owner/name', parsed.repo, originOf(cwd));
    const owner = repo?.split('/')[0] ?? '';
    const launchesRepo = await ask('Your launches repo (your blog), owner/name', parsed.launchesRepo, owner ? `${owner}/launches` : undefined);
    const site = await ask('Your blog’s address, https://…', parsed.site, owner ? `https://${owner.toLowerCase()}.github.io` : undefined);
    const name = await ask('Who the launches speak for', parsed.name, gitUserName(cwd) ?? owner);
    const languages = await ask('The blog’s languages (en, es or en,es)', parsed.languages, 'en');
    const ai = await ask('The AI (anthropic or openai)', parsed.ai, 'anthropic');
    const channels = await ask(`Channels (from ${ACTION_CHANNELS.join(', ')})`, parsed.channels, DEFAULT_CHANNELS.join(','));
    const options = setupOptions({ repo, launchesRepo, brand: parsed.brand, name, site, languages, ai, channels });
    if ('errors' in options) {
      console.error(`shipcast init cannot go on:\n${options.errors.map((e) => `  - ${e}`).join('\n')}`);
      return 2;
    }

    const where = launchesDirFor(cwd, options.repo, options.launchesRepo, parsed.launchesDir);
    const files = setupFiles(options, cwd, where.dir);
    const existing = files.filter((f) => existsSync(f.path));
    if (existing.length > 0 && !parsed.force) {
      console.error(`shipcast init never overwrites a file (--force does):\n${existing.map((f) => `  ${relative(cwd, f.path) || f.path}`).join('\n')}`);
      return 1;
    }
    // What it writes must be what Shipcast reads: a template drifting from the schemas is a bug here
    for (const f of files) {
      if (basename(f.path) === 'launch.yml' && !parseLaunchConfig(f.content).ok) throw new Error('the launch.yml written does not parse');
      if (basename(f.path) === 'brand.yml' && !parseBrand(f.content).ok) throw new Error('the brand.yml written does not parse');
    }
    for (const f of files) {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content);
      log(`wrote ${relative(cwd, f.path) || f.path}`);
    }

    log('');
    log(`In ${options.repo}: commit .github/launch.yml and .github/workflows/shipcast.yml.`);
    log(
      where.copy
        ? `In ${options.launchesRepo}: copy shipcast-launches/brand.yml and shipcast-launches/.github/ into its root and commit them (or run init again with --launches-dir <its checkout>).`
        : `In ${options.launchesRepo} (${relative(cwd, where.dir) || '.'}): commit brand.yml and .github/workflows/shipcast-publish.yml.`,
    );
    log('');
    log(secretsReport(secretsToSet(options)));
    log('');
    log('Then publish a release (or run "Shipcast launch" by hand with a tag): the drafts pull request arrives in');
    log(`${options.launchesRepo}; merge it to publish. To try it first, set the variable SHIPCAST_DRY_RUN=true in both repos.`);
    log('Guide: https://github.com/yeyo11/shipcast/blob/main/docs/getting-started.md');
    return 0;
  } finally {
    prompt?.close();
  }
}

/** Whether a folder is Shipcast's own checkout, where `init` is the local install instead */
export function isShipcastCheckout(dir: string): boolean {
  try {
    return existsSync(join(dir, 'packages', 'engine')) && (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }).name === 'shipcast';
  } catch {
    return false;
  }
}
