import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimManual,
  draftLaunch,
  loadBrand,
  Registry,
  type AiProvider,
  type EventsPage,
  type GenerateRequest,
  type GitHubSource,
  type GitHubWriter,
  type PullRequestDraft,
} from '../src/index.ts';

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  instagram: off\n  reddit: off\n';

class FakeGitHub implements GitHubSource, GitHubWriter {
  files: Record<string, string>;
  latest: string | undefined;
  opened: PullRequestDraft[] = [];
  constructor(files: Record<string, string>, latest?: string) {
    this.files = files;
    this.latest = latest;
  }
  async userEvents(): Promise<EventsPage> {
    return { notModified: true };
  }
  async fileAt(repo: string, path: string, ref: string) {
    return this.files[`${repo}/${path}@${ref}`];
  }
  async latestRelease() {
    return this.latest ? { tag: this.latest, url: 'u' } : undefined;
  }
  async openPullRequest(draft: PullRequestDraft) {
    this.opened.push(draft);
    return { number: 1, url: 'https://github.com/yeyo11/launches/pull/1', created: true };
  }
}

const article = { title: 'claudio', description: 'd', markdown: 'b' };
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { slug: 'claudio', en: article, es: article },
  devto: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'b' },
  mastodon: { lang: 'en', text: 'm' },
};

class FakeAi implements AiProvider {
  output: unknown;
  requests: GenerateRequest[] = [];
  constructor(output: unknown) {
    this.output = output;
  }
  async generate(request: GenerateRequest) {
    this.requests.push(request);
    return { output: this.output, chatId: 'chat-1', costUsd: 0.4 };
  }
}

function setup(output: unknown = pack, files: Record<string, string> = {}) {
  const github = new FakeGitHub({
    'yeyo11/launches/brand.yml@HEAD': BRAND_YML,
    'yeyo11/claudio/.github/launch.yml@v0.9.0': LAUNCH_YML,
    ...files,
  }, 'v0.9.0');
  const registry = new Registry(':memory:');
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
  };
  return { github, registry, deps, clones };
}

test('the brand comes from the launches repo, validated', async () => {
  const { github } = setup();
  assert.equal((await loadBrand(github, 'yeyo11/launches')).site, 'https://josegarrido.dev');
  await assert.rejects(loadBrand(new FakeGitHub({}), 'yeyo11/launches'), /has no brand.yml/);
});

test('a claimed launch becomes a drafts pull request and is recorded as drafted', async () => {
  const { github, registry, deps, clones } = setup();
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });

  const result = await draftLaunch(launch, brand, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(clones, ['yeyo11/claudio@v0.9.0']);
  const pr = github.opened[0]!;
  assert.equal(pr.repo, 'yeyo11/launches');
  assert.equal(pr.branch, 'launch/claudio-v0.9.0');
  assert.equal(pr.title, 'Launch claudio v0.9.0');
  assert.ok(pr.files.some((f) => f.path === 'src/content/posts/en/claudio.md'));
  assert.ok(!pr.files.some((f) => f.path.includes('instagram')), 'channels off in launch.yml get nothing');
  const after = registry.get(launch.id)!;
  assert.equal(after.status, 'drafted');
  assert.equal(after.detail, 'https://github.com/yeyo11/launches/pull/1');
});

test('a pack that falls short fails the launch with the problems and the chat to read', async () => {
  const { github, registry, deps } = setup({ ...pack, bluesky: undefined });
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const result = await draftLaunch(launch, brand, deps);
  assert.equal(result.ok, false);
  assert.equal(github.opened.length, 0, 'no pull request for a pack that fails');
  assert.equal(registry.get(launch.id)!.status, 'failed');
  assert.match(registry.get(launch.id)!.detail ?? '', /bluesky: the pack has no bluesky\nclaudio chat: chat-1/);
});

test('a manual launch takes the latest release and is claimed like any other', async () => {
  const { github, registry } = setup();
  const brand = await loadBrand(github, 'yeyo11/launches');
  const first = await claimManual('yeyo11/claudio', undefined, brand, { github, registry });
  assert.ok('claimed' in first && first.claimed);
  assert.equal(first.launch.trigger, 'manual');
  assert.equal(first.launch.ref, 'v0.9.0');
  const again = await claimManual('yeyo11/claudio', 'v0.9.0', brand, { github, registry });
  assert.ok('claimed' in again && !again.claimed, 'never twice, by hand or by the watcher');
});

test('a manual launch explains why it cannot start', async () => {
  const { github, registry } = setup(pack, { 'yeyo11/off/.github/launch.yml@v1.0.0': 'enabled: true\nbrand: personal\ntriggers:\n  manual: false\n' });
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
