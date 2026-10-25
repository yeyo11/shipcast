import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  approveLaunch,
  articleConfig,
  articleSlug,
  claimArticle,
  draftArticle,
  draftLaunch,
  editDraft,
  isArticle,
  launchDir,
  loadBrand,
  readReview,
  Registry,
  type AiProvider,
  type EventsPage,
  type GenerateRequest,
  type GitHubSource,
  type GitHubWriter,
  type PullRequestDraft,
  type ReviewGitHub,
} from '../src/index.ts';

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  instagram: off\n';

class FakeGitHub implements GitHubSource, GitHubWriter, ReviewGitHub {
  files: Record<string, string>;
  opened: PullRequestDraft[] = [];
  commits: Array<{ repo: string; branch: string; message: string; files: PullRequestDraft['files'] }> = [];
  updates: Array<{ branch: string; path: string; content: string }> = [];
  merged: number[] = [];
  prState: 'open' | 'merged' | 'closed' = 'open';
  constructor(files: Record<string, string>) {
    this.files = files;
  }
  async userEvents(): Promise<EventsPage> {
    return { notModified: true };
  }
  async fileAt(repo: string, path: string, ref: string) {
    return this.files[`${repo}/${path}@${ref}`];
  }
  async latestRelease() {
    return { tag: 'v0.9.0', url: 'u' };
  }
  async pullRequestState() {
    return this.prState;
  }
  async openPullRequest(draft: PullRequestDraft) {
    this.opened.push(draft);
    return { number: 7, url: 'https://github.com/yeyo11/launches/pull/7', created: true };
  }
  async commitToBranch(repo: string, branch: string, message: string, files: PullRequestDraft['files']) {
    this.commits.push({ repo, branch, message, files });
    return { sha: 'abc123' };
  }
  async pullRequest(_repo: string, number: number) {
    return { number, url: `https://github.com/yeyo11/launches/pull/${number}`, state: this.prState, branch: 'launch/claudio-v0.9.0', title: 'Launch claudio v0.9.0' };
  }
  async pullRequestFiles() {
    return ['launches/claudio/v0.9.0/bluesky.md', 'public/launches/claudio/v0.9.0/og.png', 'src/content/posts/en/claudio.md', 'launches/claudio/v0.9.0/pack.json'];
  }
  async updateFile(_repo: string, branch: string, path: string, content: string) {
    this.updates.push({ branch, path, content });
  }
  async mergePullRequest(_repo: string, number: number) {
    this.merged.push(number);
    return { sha: 'merged' };
  }
}

class FakeAi implements AiProvider {
  requests: GenerateRequest[] = [];
  output: unknown;
  constructor(output: unknown) {
    this.output = output;
  }
  async generate(request: GenerateRequest) {
    this.requests.push(request);
    return { output: this.output, chatId: 'c', costUsd: 0.1 };
  }
}

const version = { title: 'T', description: 'd', markdown: 'AI copy' };
const launchPack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', ...version }, es: { slug: 'claudio-es', ...version } },
  devto: { tags: ['ai'] },
  bluesky: { lang: 'en', text: 'b' },
  mastodon: { lang: 'en', text: 'm' },
};

function deps(github: FakeGitHub, output: unknown = launchPack) {
  return {
    github,
    ai: new FakeAi(output),
    registry: new Registry(':memory:'),
    launchesRepo: 'yeyo11/launches',
    checkout: async () => ({ hostPath: '/h', providerPath: '/workspace/x' }),
    now: () => new Date('2026-10-25T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  };
}

test('published directly, the drafts go onto main in one commit and the launch says so', async () => {
  const github = new FakeGitHub({ 'yeyo11/launches/brand.yml@HEAD': BRAND_YML, 'yeyo11/claudio/.github/launch.yml@v0.9.0': LAUNCH_YML });
  const d = deps(github);
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = d.registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const result = await draftLaunch(launch, brand, d, { direct: true });
  assert.ok(result.ok);
  assert.equal(github.opened.length, 0, 'no pull request');
  assert.equal(github.commits[0]?.branch, 'main');
  assert.match(d.registry.get(launch.id)?.detail ?? '', /^direct:abc123 /);
});

test('an article lives under articles/, is claimed once, and turns on only the chosen channels', () => {
  assert.equal(articleSlug('Árboles, ramas & Claude: ¿qué?'), 'arboles-ramas-claude-que');
  const brand = { id: 'personal' } as Parameters<typeof articleConfig>[0];
  const config = articleConfig(brand, ['bluesky', 'hackerNews']);
  assert.equal(config.publishing.blog, 'approval');
  assert.equal(config.publishing.bluesky, 'approval');
  assert.equal(config.publishing.hackerNews, 'manual', 'drafts-only stays manual');
  assert.equal(config.publishing.devto, 'off');

  const registry = new Registry(':memory:');
  const first = claimArticle({ title: 'Hello there', markdown: 'x', lang: 'en', channels: [] }, brand as never, { registry, launchesRepo: 'yeyo11/launches' });
  assert.ok(first.claimed);
  assert.ok(isArticle(first.launch));
  assert.equal(launchDir(first.launch), 'articles/hello-there');
  assert.equal(claimArticle({ title: 'Hello there', markdown: 'y', lang: 'en', channels: [] }, brand as never, { registry, launchesRepo: 'yeyo11/launches' }).claimed, false);
});

test('an article keeps the owner’s words, gets its translation and pieces, and carries its channels', async () => {
  const github = new FakeGitHub({ 'yeyo11/launches/brand.yml@HEAD': BRAND_YML });
  const pack = { ...launchPack, project: { name: 'x', repo: 'https://github.com/x/y' }, devto: undefined, mastodon: undefined };
  const d = deps(github, pack);
  const brand = await loadBrand(github, 'yeyo11/launches');
  const input = { title: 'My own title', markdown: 'My own words.', lang: 'en' as const, channels: ['bluesky' as const] };
  const { launch } = claimArticle(input, brand, d);
  const result = await draftArticle(launch, input, brand, d);
  assert.ok(result.ok, result.ok ? '' : result.problems.join('; '));
  const ai = d.ai.requests[0]!;
  assert.match(ai.prompt, /My own words\./);
  assert.match(ai.prompt, /Translate it faithfully into Spanish/);
  assert.deepEqual(ai.allowedTools, []);
  const pr = github.opened[0]!;
  assert.equal(pr.branch, 'article/my-own-title');
  const en = pr.files.find((f) => f.path === 'src/content/posts/en/claudio.md');
  assert.match(en && 'content' in en ? en.content : '', /title: "My own title"[\s\S]*My own words\./);
  assert.doesNotMatch(en && 'content' in en ? en.content : '', /^repo:/m, 'an article has no project repo');
  const config = pr.files.find((f) => f.path === 'articles/my-own-title/launch.yml');
  assert.match(config && 'content' in config ? config.content : '', /bluesky: approval/);
  assert.ok(pr.files.some((f) => f.path === 'articles/my-own-title/bluesky.md'));
  assert.ok(!pr.files.some((f) => f.path.startsWith('public/covers/')), 'an article draws no project cover');
});

test('reviewing reads the drafts from the pull request; edits land on its branch; approving merges it', async () => {
  const github = new FakeGitHub({
    'yeyo11/launches/launches/claudio/v0.9.0/bluesky.md@launch/claudio-v0.9.0': '# Bluesky\n\nhello',
    'yeyo11/launches/src/content/posts/en/claudio.md@launch/claudio-v0.9.0': '---\ntitle: x\n---\nbody',
  });
  const registry = new Registry(':memory:');
  const { launch } = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const drafted = registry.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/7');
  const d = { github, launchesRepo: 'yeyo11/launches' };

  const review = await readReview(drafted, d);
  assert.deepEqual(review?.drafts.map((x) => [x.label, x.kind]), [['Article (en)', 'article'], ['Bluesky', 'channel'], ['og', 'image'], ['pack.json', 'data']]);
  assert.equal(review?.drafts[1]?.content, '# Bluesky\n\nhello');
  assert.match(review?.drafts[2]?.url ?? '', /raw\.githubusercontent\.com\/yeyo11\/launches\/launch%2Fclaudio-v0\.9\.0\//);

  await editDraft(drafted, 'launches/claudio/v0.9.0/bluesky.md', '# Bluesky\n\nedited', d);
  assert.deepEqual(github.updates[0], { branch: 'launch/claudio-v0.9.0', path: 'launches/claudio/v0.9.0/bluesky.md', content: '# Bluesky\n\nedited\n' });
  await assert.rejects(editDraft(drafted, 'launches/claudio/v0.9.0/pack.json', '{}', d), /not a draft/);

  await approveLaunch(drafted, d);
  assert.deepEqual(github.merged, [7]);
  github.prState = 'merged';
  await assert.rejects(approveLaunch(drafted, d), /is merged/);
  await assert.rejects(editDraft(drafted, 'launches/claudio/v0.9.0/bluesky.md', 'x', d), /no longer open/);
});
