import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { parseBrand, parseLaunchConfig } from '@shipcast/schema';
import {
  ACTION,
  launchesDirFor,
  renderPublishWorkflow,
  renderReleaseWorkflow,
  repoFromRemote,
  runSetup,
  secretsToSet,
  setupFiles,
  setupOptions,
  type SetupOptions,
} from '../src/setup.ts';

const options = (): SetupOptions => {
  const made = setupOptions({ repo: 'dev/tool', site: 'https://dev.example', name: 'A Dev' });
  assert.ok(!('errors' in made), JSON.stringify(made));
  return made;
};

test('the answers default to the owner’s launches repo, Anthropic and the channels that need no app', () => {
  const o = options();
  assert.equal(o.launchesRepo, 'dev/launches');
  assert.equal(o.ai, 'anthropic');
  assert.deepEqual(o.channels, ['blog', 'devto', 'bluesky', 'mastodon', 'githubDiscussions']);
  assert.deepEqual(o.brand, { id: 'dev', displayName: 'A Dev', site: 'https://dev.example', github: 'dev', languages: ['en'] });
});

test('wrong answers are all reported at once', () => {
  const made = setupOptions({ repo: 'nope', site: 'http://insecure.example', ai: 'gemini', channels: 'blog,reddit' });
  assert.ok('errors' in made);
  const text = made.errors.join('\n');
  assert.match(text, /owner\/name, not "nope"/);
  assert.match(text, /anthropic or openai, not "gemini"/);
  assert.match(text, /unknown channels reddit/);
  assert.match(text, /brand site/);
});

test('the files written are the files Shipcast reads, and the workflows are valid YAML on the Action', () => {
  const o = { ...options(), ai: 'openai' as const, channels: ['blog', 'devto', 'telegram'] as SetupOptions['channels'] };
  const files = setupFiles(o, '/p', '/l');
  assert.deepEqual(
    files.map((f) => f.path),
    ['/p/.github/launch.yml', '/p/.github/workflows/shipcast.yml', '/l/brand.yml', '/l/.github/workflows/shipcast-publish.yml'],
  );
  const launch = parseLaunchConfig(files[0]!.content);
  assert.ok(launch.ok);
  assert.equal(launch.value.publishing.devto, 'approval');
  assert.equal(launch.value.publishing.bluesky, 'off', 'a channel not chosen is off, not its default');
  assert.equal(launch.value.publishing.instagram, 'off');
  const brand = parseBrand(files[2]!.content);
  assert.ok(brand.ok);
  assert.equal(brand.value.site, 'https://dev.example');

  const release = parse(files[1]!.content) as { on: Record<string, unknown>; jobs: { launch: { steps: Array<{ uses: string; with: Record<string, string> }> } } };
  assert.deepEqual(Object.keys(release.on), ['release', 'workflow_dispatch']);
  const step = release.jobs.launch.steps[0]!;
  assert.equal(step.uses, ACTION);
  assert.equal(step.with['launches-repo'], 'dev/launches');
  assert.match(step.with['ai-provider']!, /vars\.SHIPCAST_AI_PROVIDER \|\| 'openai'/);

  const publish = parse(files[3]!.content) as { jobs: { publish: { steps: Array<{ env: Record<string, string> }> } } };
  assert.deepEqual(Object.keys(publish.jobs.publish.steps[0]!.env), ['DEVTO_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], 'only the chosen channels’ secrets');
});

test('every secret to set says where, why and how to get it', () => {
  const list = secretsToSet(options());
  const names = list.map((s) => `${s.kind} ${s.name} ${s.repo}`);
  assert.deepEqual(names.slice(0, 4), ['secret SHIPCAST_GITHUB_TOKEN dev/tool', 'secret ANTHROPIC_API_KEY dev/tool', 'variable SHIPCAST_AI_PROVIDER dev/tool', 'secret SHIPCAST_GITHUB_TOKEN dev/launches']);
  assert.ok(names.includes('secret BLUESKY_APP_PASSWORD dev/launches'));
  for (const s of list.filter((s) => s.kind === 'secret')) assert.ok(s.how.length > 0, `${s.name} has a how`);
  assert.match(list.find((s) => s.name === 'DEVTO_API_KEY')!.how, /^https:\/\/dev\.to\/settings\/extensions/);
});

test('the repo comes from a GitHub remote, https or ssh', () => {
  assert.equal(repoFromRemote('git@github.com:dev/tool.git'), 'dev/tool');
  assert.equal(repoFromRemote('https://github.com/dev/my.tool\n'), 'dev/my.tool');
  assert.equal(repoFromRemote('https://gitlab.com/dev/tool.git'), undefined);
});

test('the launches repo’s files go to its sibling checkout, to this repo when it is the same one, or to a folder to copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'shipcast-setup-'));
  const project = join(root, 'tool');
  mkdirSync(join(root, 'launches', '.git'), { recursive: true });
  assert.deepEqual(launchesDirFor(project, 'dev/tool', 'dev/launches', undefined, () => 'dev/launches'), { dir: join(root, 'launches'), copy: false });
  assert.deepEqual(launchesDirFor(project, 'dev/tool', 'dev/launches', undefined, () => 'someone/else'), { dir: join(project, 'shipcast-launches'), copy: true });
  assert.deepEqual(launchesDirFor(project, 'dev/tool', 'dev/tool', undefined), { dir: project, copy: false });
  assert.deepEqual(launchesDirFor(project, 'dev/tool', 'dev/launches', '../blog'), { dir: join(root, 'blog'), copy: false });
});

test('init in an empty repo writes the setup from its origin, prints the secrets, and never overwrites', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-init-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:dev/tool.git'], { cwd: dir });
  const lines: string[] = [];
  const code = await runSetup(['--yes', '--site', 'https://dev.example', '--name', 'A Dev'], dir, (line) => lines.push(line));
  assert.equal(code, 0);
  const out = lines.join('\n');
  for (const file of ['.github/launch.yml', '.github/workflows/shipcast.yml', 'shipcast-launches/brand.yml', 'shipcast-launches/.github/workflows/shipcast-publish.yml']) {
    assert.ok(existsSync(join(dir, file)), file);
  }
  assert.match(readFileSync(join(dir, '.github/workflows/shipcast.yml'), 'utf8'), /launches-repo: dev\/launches/);
  assert.match(out, /gh secret set SHIPCAST_GITHUB_TOKEN --repo dev\/tool/);
  assert.match(out, /https:\/\/console\.anthropic\.com\/settings\/keys/);
  assert.match(out, /copy shipcast-launches\/brand\.yml/);

  const again = await runSetup(['--yes', '--site', 'https://dev.example'], dir, () => {});
  assert.equal(again, 1, 'a second run refuses to overwrite');
});

test('templates/ holds the workflows exactly as init writes them for a placeholder launches repo', () => {
  const root = join(import.meta.dirname, '..', '..', '..', 'templates');
  assert.equal(readFileSync(join(root, 'shipcast-release.yml'), 'utf8'), renderReleaseWorkflow({ launchesRepo: 'your-login/launches', ai: 'anthropic' }));
  assert.equal(readFileSync(join(root, 'shipcast-publish.yml'), 'utf8'), renderPublishWorkflow({ channels: ['blog', 'devto', 'bluesky', 'mastodon', 'hashnode', 'telegram', 'discord', 'githubDiscussions'] }));
});
