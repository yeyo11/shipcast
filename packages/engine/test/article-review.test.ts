import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approveLaunch, articleConfig, articleSlug, claimArticle, draftArticle, draftLaunch, editDraft, isArticle, launchDir, loadBrand, readReview, type Repositories } from '../src/index.ts';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { FakeGitHub, memoryRegistry, mockRunner, promptOf, submitParts, textParts } from '../src/testing/index.ts';

const BRAND_YML = 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  instagram: off\n';

/** The launches repo whose drafts pull request is #7, launch/claudio-v0.9.0 */
function fakeGitHub(files: Record<string, string>): FakeGitHub {
  const github = new FakeGitHub({ files, firstPullRequest: 7 });
  github.addPullRequest({
    repo: 'yeyo11/launches',
    number: 7,
    branch: 'launch/claudio-v0.9.0',
    title: 'Launch claudio v0.9.0',
    files: ['launches/claudio/v0.9.0/bluesky.md', 'public/launches/claudio/v0.9.0/og.png', 'src/content/posts/en/claudio.md', 'launches/claudio/v0.9.0/pack.json'],
  });
  return github;
}

/** A model that answers `output` the way the runner asks: through the submit tool beside the repo's tools, else as JSON text */
function answering(output: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: async (options) => ({
      stream: convertArrayToReadableStream((options.tools ?? []).length > 0 ? submitParts(output) : textParts(JSON.stringify(output))),
    }),
  });
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
  githubDiscussions: { title: 'claudio 0.9', body: 'What shipped. https://josegarrido.dev/en/claudio/?ref=github' },
};

async function deps(github: FakeGitHub, output: unknown = launchPack) {
  const model = answering(output);
  return {
    model,
    github,
    aiRunner: mockRunner(model),
    registry: await memoryRegistry(),
    launchesRepo: 'yeyo11/launches',
    checkout: async () => ({ hostPath: '/h', providerPath: '/workspace/x' }),
    now: () => new Date('2026-10-25T00:00:00Z'),
    fetch: (async () => new Response(null, { status: 404 })) as typeof fetch,
  };
}

test('published directly, the drafts go onto main in one commit and the launch says so', async () => {
  const github = fakeGitHub({ 'yeyo11/launches/brand.yml@HEAD': BRAND_YML, 'yeyo11/claudio/.github/launch.yml@v0.9.0': LAUNCH_YML });
  const d = await deps(github);
  const brand = await loadBrand(github, 'yeyo11/launches');
  const { launch } = await d.registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const result = await draftLaunch(launch, brand, d, { direct: true });
  assert.ok(result.ok);
  assert.equal(github.opened.length, 0, 'no pull request');
  assert.equal(github.commits[0]?.branch, 'main');
  assert.match((await d.registry.launches.get(launch.id))?.detail ?? '', /^direct:sha1 /);
  const bluesky = github.commits[0]?.files.find((f) => f.path.endsWith('/bluesky.md'));
  assert.match(bluesky && 'content' in bluesky ? bluesky.content : '', /^> \*\*Published directly:\*\*/m, 'no merge to speak of');
});

test('an article lives under articles/, is claimed once, and turns on only the chosen channels', async () => {
  assert.equal(articleSlug('Árboles, ramas & Claude: ¿qué?'), 'arboles-ramas-claude-que');
  const brand = { id: 'personal' } as Parameters<typeof articleConfig>[0];
  const config = articleConfig(brand, ['bluesky', 'reddit']);
  assert.equal(config.publishing.blog, 'approval');
  assert.equal(config.publishing.bluesky, 'approval');
  assert.equal(config.publishing.reddit, 'approval');
  assert.equal(config.publishing.devto, 'off');
  // An article belongs to no repository, so there is no Discussions to post it in, even when chosen
  assert.equal(config.publishing.githubDiscussions, 'off');
  assert.equal(articleConfig(brand, ['githubDiscussions', 'threads']).publishing.githubDiscussions, 'off');
  assert.equal(articleConfig(brand, ['githubDiscussions', 'threads']).publishing.threads, 'approval');

  const registry = await memoryRegistry();
  const first = await claimArticle({ title: 'Hello there', markdown: 'x', lang: 'en', channels: [] }, brand as never, { registry, launchesRepo: 'yeyo11/launches' });
  assert.ok(first.claimed);
  assert.ok(isArticle(first.launch));
  assert.equal(launchDir(first.launch), 'articles/hello-there');
  assert.equal((await claimArticle({ title: 'Hello there', markdown: 'y', lang: 'en', channels: [] }, brand as never, { registry, launchesRepo: 'yeyo11/launches' })).claimed, false);
});

test('an article keeps the owner’s words, gets its translation and pieces, and carries its channels', async () => {
  const github = fakeGitHub({ 'yeyo11/launches/brand.yml@HEAD': BRAND_YML });
  const pack = { ...launchPack, project: { name: 'x', repo: 'https://github.com/x/y' }, devto: undefined, mastodon: undefined };
  const d = await deps(github, pack);
  const brand = await loadBrand(github, 'yeyo11/launches');
  const input = { title: 'My own title', markdown: 'My own words.', lang: 'en' as const, channels: ['bluesky' as const] };
  const { launch } = await claimArticle(input, brand, d);
  const result = await draftArticle(launch, input, brand, d);
  assert.ok(result.ok, result.ok ? '' : result.problems.join('; '));
  const prompt = promptOf(d.model);
  assert.match(prompt, /My own words\./);
  assert.match(prompt, /Translate it faithfully into Spanish/);
  assert.equal(d.model.doStreamCalls[0]!.tools, undefined, 'an article reads no repo');
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
  const github = fakeGitHub({
    'yeyo11/launches/launches/claudio/v0.9.0/bluesky.md@launch/claudio-v0.9.0': '# Bluesky\n\nhello',
    'yeyo11/launches/src/content/posts/en/claudio.md@launch/claudio-v0.9.0': '---\ntitle: x\n---\nbody',
  });
  const registry = await memoryRegistry();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const drafted = await registry.launches.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/7');
  const d = { github, launchesRepo: 'yeyo11/launches' };

  const review = await readReview(drafted, d);
  assert.deepEqual(review?.drafts.map((x) => [x.label, x.kind]), [['Article (en)', 'article'], ['Bluesky', 'channel'], ['og', 'image'], ['pack.json', 'data']]);
  assert.equal(review?.drafts[1]?.content, '# Bluesky\n\nhello');
  assert.match(review?.drafts[2]?.url ?? '', /raw\.githubusercontent\.com\/yeyo11\/launches\/launch\/claudio-v0\.9\.0\/public\//);

  await editDraft(drafted, 'launches/claudio/v0.9.0/bluesky.md', '# Bluesky\n\nedited', d);
  assert.deepEqual(github.updates.map(({ branch, path, content }) => ({ branch, path, content }))[0], { branch: 'launch/claudio-v0.9.0', path: 'launches/claudio/v0.9.0/bluesky.md', content: '# Bluesky\n\nedited\n' });
  await assert.rejects(editDraft(drafted, 'launches/claudio/v0.9.0/pack.json', '{}', d), /not a draft/);
  // A post the network would refuse is refused here, before the merge, not when it fails to publish
  const long = `# Bluesky\n\n> **Approval:** x\n\n${'a'.repeat(280)} https://josegarrido.dev/en/claudio/?ref=bluesky`;
  await assert.rejects(editDraft(drafted, 'launches/claudio/v0.9.0/bluesky.md', long, d), /Bluesky takes at most 300 characters \(the link included\); this is 328/);
  assert.equal(github.updates.length, 1, 'nothing is committed');

  await approveLaunch(drafted, d);
  assert.deepEqual(github.merged, [7]);
  await assert.rejects(approveLaunch(drafted, d), /is merged/);
  await assert.rejects(editDraft(drafted, 'launches/claudio/v0.9.0/bluesky.md', 'x', d), /no longer open/);
});
