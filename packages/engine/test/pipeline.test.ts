import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimManual,
  draftLaunch,
  loadBrand,
  loadProjects,
  Registry,
  type AiProvider,
  type ObjectRequest,
} from '../src/index.ts';
import { FakeGitHub, memoryRegistry } from '../src/testing/index.ts';

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  instagram: off\n  reddit: off\n';

const article = { title: 'claudio', description: 'd', markdown: 'b' };
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', ...article }, es: { slug: 'claudio-como-servicio', ...article } },
  devto: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'b' },
  mastodon: { lang: 'en', text: 'm' },
  githubDiscussions: { title: 'claudio 0.9', body: 'What shipped. https://josegarrido.dev/en/claudio/?ref=github' },
};

class FakeAi implements AiProvider {
  output: unknown;
  requests: ObjectRequest[] = [];
  constructor(output: unknown) {
    this.output = output;
  }
  readonly id = 'test' as const;
  async *streamText() {}
  async generateObject(request: ObjectRequest) {
    this.requests.push(request);
    return { output: this.output, chatId: 'chat-1', costUsd: 0.4 };
  }
}

async function setup(output: unknown = pack, files: Record<string, string> = {}) {
  const github = new FakeGitHub({
    files: {
      'yeyo11/launches/brand.yml@HEAD': BRAND_YML,
      'yeyo11/claudio/.github/launch.yml@v0.9.0': LAUNCH_YML,
      ...files,
    },
    latestRelease: { tag: 'v0.9.0', url: 'u' },
  });
  const registry = await memoryRegistry();
  const clones: string[] = [];
  const deps = {
    github,
    ai: new FakeAi(output),
    registry,
    launchesRepo: 'yeyo11/launches',
    checkout: async (repo: string, ref: string) => {
      clones.push(`${repo}@${ref}`);
      return { hostPath: '/h', providerPath: '/workspace/x' };
    },
    now: () => new Date('2026-10-25T00:00:00Z'),
    // The site serves no covers
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  };
  return { github, registry, deps, clones };
}

test('the brand comes from the launches repo, validated', async () => {
  const { github } = await setup();
  assert.equal((await loadBrand(github, 'yeyo11/launches')).site, 'https://josegarrido.dev');
  await assert.rejects(loadBrand(new FakeGitHub(), 'yeyo11/launches'), /has no brand.yml/);
});

test('the known projects come from the launches repo; without projects.yml there are none', async () => {
  const { github } = await setup(pack, { 'yeyo11/launches/projects.yml@HEAD': 'claudio:\n  colour: "#2FD7A0"\n  motif: phone\n' });
  assert.equal((await loadProjects(github, 'yeyo11/launches'))['claudio']?.motif, 'phone');
  assert.deepEqual(await loadProjects(new FakeGitHub(), 'yeyo11/launches'), {});
  const broken = new FakeGitHub({ files: { 'yeyo11/launches/projects.yml@HEAD': 'claudio:\n  colour: green\n  motif: phone\n' } });
  await assert.rejects(loadProjects(broken, 'yeyo11/launches'), /projects\.yml is invalid/);
});

test('a claimed launch becomes a drafts pull request and is recorded as drafted', async () => {
  const { github, registry, deps, clones } = await setup();
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });

  const result = await draftLaunch(launch, brand, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(clones, ['yeyo11/claudio@v0.9.0']);
  const pr = github.opened[0]!;
  assert.equal(pr.repo, 'yeyo11/launches');
  assert.equal(pr.branch, 'launch/claudio-v0.9.0');
  assert.equal(pr.title, 'Launch claudio v0.9.0');
  assert.ok(pr.files.some((f) => f.path === 'src/content/posts/en/claudio.md'));
  assert.ok(pr.files.some((f) => f.path === 'public/launches/claudio/v0.9.0/og.png' && 'bytes' in f), 'the launch image travels as a binary');
  const article = pr.files.find((f) => f.path === 'src/content/posts/en/claudio.md');
  assert.match(article && 'content' in article ? article.content : '', /^image: "\/launches\/claudio\/v0\.9\.0\/og\.png"$/m);
  assert.ok(!pr.files.some((f) => f.path.includes('instagram')), 'channels off in launch.yml get nothing');
  assert.ok(pr.files.some((f) => f.path === 'public/covers/claudio.jpg'), 'a project without a cover gets one');
  assert.ok(pr.files.some((f) => f.path === 'projects.yml' && 'content' in f && f.content.includes('/covers/claudio.jpg')));
  const after = (await registry.launches.get(launch.id))!;
  assert.equal(after.status, 'drafted');
  assert.equal(after.detail, 'https://github.com/yeyo11/launches/pull/1');
});

test('a pack that falls short fails the launch with the problems and the chat to read', async () => {
  const { github, registry, deps } = await setup({ ...pack, bluesky: undefined });
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const result = await draftLaunch(launch, brand, deps);
  assert.equal(result.ok, false);
  assert.equal(github.opened.length, 0, 'no pull request for a pack that fails');
  assert.equal((await registry.launches.get(launch.id))!.status, 'failed');
  assert.match((await registry.launches.get(launch.id))!.detail ?? '', /bluesky: the pack has no bluesky\nclaudio chat: chat-1/);
});

test('a manual launch takes the latest release and is claimed like any other', async () => {
  const { github, registry } = await setup();
  const brand = await loadBrand(github, 'yeyo11/launches');
  const first = await claimManual('yeyo11/claudio', undefined, brand, { github, registry });
  assert.ok('claimed' in first && first.claimed);
  assert.equal(first.launch.trigger, 'manual');
  assert.equal(first.launch.ref, 'v0.9.0');
  const again = await claimManual('yeyo11/claudio', 'v0.9.0', brand, { github, registry });
  assert.ok('claimed' in again && !again.claimed, 'never twice, by hand or by the watcher');

  await registry.launches.setStatus(first.launch.id, 'failed', 'could not clone');
  const retry = await claimManual('yeyo11/claudio', 'v0.9.0', brand, { github, registry });
  assert.ok('claimed' in retry && retry.claimed, 'a failed launch published nothing: by hand, it is retried');
  assert.equal(retry.launch.id, first.launch.id);
  assert.equal(retry.launch.status, 'detected');

  await registry.launches.setStatus(first.launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/1');
  const drafted = await claimManual('yeyo11/claudio', 'v0.9.0', brand, { github, registry });
  assert.ok('claimed' in drafted && !drafted.claimed, 'a drafted launch is never drafted again');
});

test('a manual launch explains why it cannot start', async () => {
  const { github, registry } = await setup(pack, { 'yeyo11/off/.github/launch.yml@v1.0.0': 'enabled: true\nbrand: personal\ntriggers:\n  manual: false\n' });
  const brand = await loadBrand(github, 'yeyo11/launches');
  github.latest = undefined;
  assert.deepEqual(await claimManual('yeyo11/claudio', undefined, brand, { github, registry }), {
    error: 'yeyo11/claudio has no published release; pass --ref <tag>',
  });
  assert.deepEqual(await claimManual('yeyo11/none', 'v1.0.0', brand, { github, registry }), { error: 'yeyo11/none has no .github/launch.yml at v1.0.0' });
  assert.deepEqual(await claimManual('yeyo11/off', 'v1.0.0', brand, { github, registry }), {
    error: "manual launches are turned off in yeyo11/off's launch.yml",
  });
});
