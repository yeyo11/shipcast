import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { parseBrand, parseLaunchConfig } from '@shipcast/schema';
import {
  ACTION,
  launchesDirFor,
  NO_BLOG_YET,
  renderPublishWorkflow,
  renderReleaseWorkflow,
  repoFromRemote,
  roundTriggerCurl,
  parseSetupArgs,
  renderBrandYml,
  runSetup,
  secretsToSet,
  setupFiles,
  setupOptions,
  timingReport,
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
  assert.match(out, /actions\/workflows\/shipcast-publish\.yml\/dispatches/, 'the exact call for an outside cron');
  assert.match(out, /gh workflow run shipcast\.yml -f tag="\$TAG"/, 'and the step for a release made with GITHUB_TOKEN');

  const again = await runSetup(['--yes', '--site', 'https://dev.example'], dir, () => {});
  assert.equal(again, 1, 'a second run refuses to overwrite');
});

const TEMPLATE_BRAND = `id: personal
displayName: A Dev
site: https://dev.github.io/blog
github: dev
handles: {}
languages:
  blog: [en, es]
tone: "Plain words."
`;

/** A project with its launches repo's checkout beside it, holding a brand.yml */
const projectBesideBlog = (brandText: string) => {
  const root = mkdtempSync(join(tmpdir(), 'shipcast-init-'));
  const project = join(root, 'tool');
  const blog = join(root, 'blog');
  mkdirSync(project);
  mkdirSync(blog);
  writeFileSync(join(blog, 'brand.yml'), brandText);
  return { project, blog };
};
const BESIDE_BLOG = ['--yes', '--repo', 'dev/tool', '--launches-repo', 'dev/blog', '--launches-dir', '../blog'];

test('a brand.yml already in the launches repo is kept, and launch.yml uses its brand', async () => {
  const { project, blog } = projectBesideBlog(TEMPLATE_BRAND);
  const lines: string[] = [];
  const code = await runSetup(BESIDE_BLOG, project, (line) => lines.push(line));
  assert.equal(code, 0);
  assert.equal(readFileSync(join(blog, 'brand.yml'), 'utf8'), TEMPLATE_BRAND, 'not a byte changed');
  assert.ok(existsSync(join(blog, '.github/workflows/shipcast-publish.yml')), 'the rest is written');
  const launch = parseLaunchConfig(readFileSync(join(project, '.github/launch.yml'), 'utf8'));
  assert.ok(launch.ok);
  assert.match(readFileSync(join(project, '.github/launch.yml'), 'utf8'), /^brand: personal$/m);
  const out = lines.join('\n');
  assert.match(out, /kept .*brand\.yml/);
  assert.doesNotMatch(out, /wrote .*brand\.yml/);
  assert.match(out, /commit \.github\/workflows\/shipcast-publish\.yml/);
  assert.doesNotMatch(out, /commit brand\.yml/);
});

test('a kept brand.yml that does not parse stops init before it writes anything', async () => {
  const { project, blog } = projectBesideBlog('id: personal\nnot_a_key: 1\n');
  const code = await runSetup(BESIDE_BLOG, project, () => {});
  assert.equal(code, 2);
  assert.ok(!existsSync(join(project, '.github/launch.yml')));
  assert.ok(!existsSync(join(blog, '.github/workflows/shipcast-publish.yml')));
});

test('--force still replaces an existing brand.yml with the one from the flags', async () => {
  const { project, blog } = projectBesideBlog(TEMPLATE_BRAND);
  const code = await runSetup([...BESIDE_BLOG, '--force', '--site', 'https://other.example', '--name', 'Other'], project, () => {});
  assert.equal(code, 0);
  assert.match(readFileSync(join(blog, 'brand.yml'), 'utf8'), /https:\/\/other\.example/);
});

test('--tone writes the owner’s tone into brand.yml, as given, and no warning', async () => {
  assert.deepEqual(parseSetupArgs(['--tone', 'First person, plain words.']), { force: false, yes: false, tone: 'First person, plain words.' });
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-init-'));
  const lines: string[] = [];
  const tone = 'First person, as the developer who built it: "the problem", then the commands.';
  const code = await runSetup(['--yes', '--repo', 'dev/tool', '--site', 'https://dev.example', '--name', 'A Dev', '--tone', tone], dir, (line) => lines.push(line));
  assert.equal(code, 0);
  const brand = parseBrand(readFileSync(join(dir, 'shipcast-launches/brand.yml'), 'utf8'));
  assert.ok(brand.ok);
  assert.equal(brand.value.tone, tone, 'quotes and colons survive the YAML');
  assert.doesNotMatch(lines.join('\n'), /has no tone/);
});

test('with --yes and no tone, brand.yml gets a marked placeholder and init warns that the AI has no voice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-init-'));
  const lines: string[] = [];
  assert.equal(await runSetup(['--yes', '--repo', 'dev/tool', '--site', 'https://dev.example', '--name', 'A Dev'], dir, (line) => lines.push(line)), 0);
  const text = readFileSync(join(dir, 'shipcast-launches/brand.yml'), 'utf8');
  assert.match(text, /^# TODO: fill in your tone\. Until you do, the AI has no voice of yours/m);
  assert.match(text, /^tone: ""$/m, 'no voice is invented: the value stays empty');
  const brand = parseBrand(text);
  assert.ok(brand.ok);
  assert.equal(brand.value.tone, '');
  const out = lines.join('\n');
  assert.match(out, /Warning: brand\.yml has no tone, so the AI has no voice of yours: until you fill `tone` in dev\/launches's brand\.yml/);
  assert.ok(out.indexOf('Warning: brand.yml has no tone') > out.indexOf('gh secret set'), 'with the secrets and the next steps');
  assert.match(renderBrandYml({ ...options(), brand: { ...options().brand, tone: '  ' } }), /# TODO: fill in your tone/, 'a blank tone is no tone');
});

test('templates/ holds the workflows exactly as init writes them for a placeholder launches repo', () => {
  const root = join(import.meta.dirname, '..', '..', '..', 'templates');
  assert.equal(readFileSync(join(root, 'shipcast-release.yml'), 'utf8'), renderReleaseWorkflow({ launchesRepo: 'your-login/launches', ai: 'anthropic' }));
  assert.equal(readFileSync(join(root, 'shipcast-publish.yml'), 'utf8'), renderPublishWorkflow({ channels: ['blog', 'devto', 'bluesky', 'mastodon', 'hashnode', 'telegram', 'discord', 'githubDiscussions'] }));
});

test('the publish workflow keeps a backstop cron off the busy minutes, and waits for the deploy inside its timeout', () => {
  const workflow = parse(renderPublishWorkflow({ channels: ['blog', 'bluesky'] })) as {
    on: { schedule: Array<{ cron: string }> };
    jobs: { publish: { 'timeout-minutes': number; steps: Array<{ with: Record<string, unknown> }> } };
  };
  const minutes = workflow.on.schedule.map((s) => s.cron.split(' ')[0]);
  assert.equal(minutes.length, 3, 'one dropped run is covered by the next');
  assert.ok(minutes.every((m) => m !== '0' && m !== '30'), 'not the minutes everyone schedules at');
  const wait = Number(workflow.jobs.publish.steps[0]?.with['wait-minutes']);
  assert.ok(wait >= 20 && wait <= 25 && wait < workflow.jobs.publish['timeout-minutes'], 'the wait fits the job');
});

test('the timing report names the exact dispatch for the launches repo, never a token, and the GITHUB_TOKEN step', () => {
  const curl = roundTriggerCurl('dev/launches');
  assert.match(curl, /repos\/dev\/launches\/actions\/workflows\/shipcast-publish\.yml\/dispatches/);
  assert.match(curl, /\$SHIPCAST_DISPATCH_TOKEN/, 'the token is named, not printed');
  const report = timingReport({ launchesRepo: 'dev/launches' });
  assert.match(report, /Actions read and write/);
  assert.match(report, /GITHUB_TOKEN does not start "Shipcast launch"/);
  assert.match(report, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test('without a blog, init points to the starter template that already reads Shipcast’s articles', () => {
  assert.match(NO_BLOG_YET, /^No blog yet\? Create one from https:\/\/github\.com\/yeyo11\/shipcast-blog \(Use this template\), then run init again\.$/);
});
