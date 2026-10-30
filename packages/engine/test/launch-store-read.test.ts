import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { draftFile, parseLaunchConfig, type Channel, type ContentPack } from '@shipcast/schema';
import {
  deliverDrafts,
  editPost,
  gitBlobSha,
  inTransaction,
  launchConfigOf,
  launchGrounding,
  launchMediaPath,
  LaunchImportService,
  LaunchReadService,
  LaunchStoreService,
  launchReplyContext,
  packOnLaunchesRepo,
  readReview,
  type EditDeps,
  type ImportGitHub,
  type Launch,
  type PipelineDeps,
  type PostKind,
  type Review,
  type ReviewGitHub,
  type TreeFile,
} from '../src/index.ts';
import { FakeGitHub, memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

/*
 * The launch model's fourth phase (docs/launch-store-read.md): with `launch-store-read`, a launch the
 * tables hold is read from them alone, and reads as the pull request did. The parity is checked on
 * launches imported from a launches repo (the legacy path reads the same repo), and on one the
 * shadow write stored while its pull request is open.
 */

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';
const A = 'articles/my-post';
const HEAD_RELEASE = 'a'.repeat(40);
const HEAD_ARTICLE = 'c'.repeat(40);
const MAIN = 'b'.repeat(40);
const draft = (title: string, body: string) => `# ${title}\n\n> **Approval:** published when this pull request is merged. Edit it here if it needs changes.\n\n${body}\n`;
const BLUESKY = `${D}/${draftFile('bluesky').name}`;
const MASTODON = `${D}/${draftFile('mastodon').name}`;
const ARTICLE_EN = 'src/content/posts/en/claudio.md';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  blog: approval\n  bluesky: approval\n  mastodon: approval\n  devto: off\n  instagram: off\n  newsletter: off\n';
const releasePack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 'what claudio is', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'T', description: 'D', markdown: 'B' } },
  bluesky: { lang: 'en', text: 'hello' },
  mastodon: { lang: 'en', text: 'hello' },
};
const articlePack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'Mi post', repo: `https://github.com/${LAUNCHES}` },
  analysis: { summary: 'an opinion', implemented: ['the opinion'], planned: [], documentedOnly: [], limitations: [] },
  article: { es: { slug: 'my-post', title: 'Mi post', description: 'D', markdown: 'B' } },
  bluesky: { lang: 'es', text: 'hola' },
};
const ARTICLE_YML = 'enabled: true\nbrand: personal\npublishing:\n  blog: approval\n  bluesky: approval\n  devto: off\n  mastodon: off\n  instagram: off\n  newsletter: off\n  githubDiscussions: off\n';
const ARTICLE_ES = 'src/content/posts/es/my-post.md';
const ARTICLE_BLUESKY = `${A}/${draftFile('bluesky').name}`;

const releaseHead: Record<string, string | Uint8Array> = {
  [ARTICLE_EN]: '---\ntitle: "claudio"\n---\n\nThe article.\n',
  [BLUESKY]: draft('Bluesky', 'hello'),
  [MASTODON]: draft('Mastodon', 'hello'),
  [`${D}/pack.json`]: `${JSON.stringify(releasePack, null, 2)}\n`,
  [`public/${D}/og.png`]: new Uint8Array([1, 2, 3]),
  [`public/${D}/demo.mp4`]: new Uint8Array([7, 7]),
  'public/covers/claudio.jpg': new Uint8Array([4, 5]),
  'projects.yml': 'claudio:\n  cover: /covers/claudio.jpg\n',
};
const articleHead: Record<string, string | Uint8Array> = {
  [ARTICLE_ES]: '---\ntitle: "Mi post"\n---\n\nEl artículo.\n',
  [ARTICLE_BLUESKY]: draft('Bluesky', 'hola'),
  [`${A}/pack.json`]: `${JSON.stringify(articlePack, null, 2)}\n`,
  [`${A}/launch.yml`]: ARTICLE_YML,
  [`public/${A}/og.png`]: new Uint8Array([9, 9, 9]),
};
/** Main after both merges, where the release's Bluesky draft was edited again */
const COMMITS: Record<string, Record<string, string | Uint8Array>> = {
  [HEAD_RELEASE]: releaseHead,
  [HEAD_ARTICLE]: articleHead,
  [MAIN]: { 'brand.yml': 'id: personal\n', ...releaseHead, ...articleHead, [BLUESKY]: draft('Bluesky', 'hello, edited on main') },
};
const PULLS: Record<number, { head: string; branch: string }> = { 1: { head: HEAD_RELEASE, branch: 'launch/claudio-v1.0.0' }, 2: { head: HEAD_ARTICLE, branch: 'article/my-post' } };
const text = (content: string | Uint8Array | undefined) => (content === undefined ? undefined : typeof content === 'string' ? content : new TextDecoder().decode(content));

/** The launches repo with two merged pull requests, as the import reads it and as the legacy page reads it */
class LaunchesRepo implements ImportGitHub, ReviewGitHub {
  readonly #blobs = new Map<string, Uint8Array>();
  calls: string[] = [];

  async commitSha(repo: string, ref: string): Promise<string> {
    return repo === LAUNCHES && ref === 'HEAD' ? MAIN : 'd'.repeat(40);
  }

  async tree(_repo: string, sha: string): Promise<TreeFile[]> {
    return Object.entries(COMMITS[sha] ?? {}).map(([path, content]) => {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const blob = gitBlobSha(bytes);
      this.#blobs.set(blob, bytes);
      return { path, sha: blob, size: bytes.byteLength };
    });
  }

  async blob(_repo: string, sha: string): Promise<Uint8Array> {
    return this.#blobs.get(sha)!;
  }

  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    this.calls.push(`fileAt ${repo} ${path}@${ref}`);
    if (repo === 'yeyo11/claudio') return path === '.github/launch.yml' && ref === 'v1.0.0' ? LAUNCH_YML : undefined;
    return text(COMMITS[ref === 'HEAD' ? MAIN : ref]?.[path]);
  }

  async pullRequest(_repo: string, number: number) {
    this.calls.push(`pullRequest ${number}`);
    return { number, url: `https://github.com/${LAUNCHES}/pull/${number}`, state: 'merged' as const, branch: PULLS[number]!.branch, title: 't', headSha: PULLS[number]!.head, mergedBy: 'yeyo11', mergedAt: '2026-10-24T23:10:06Z' };
  }

  async pullRequestFiles(_repo: string, number: number): Promise<string[]> {
    this.calls.push(`pullRequestFiles ${number}`);
    return Object.keys(COMMITS[PULLS[number]!.head]!);
  }

  async updateFile(): Promise<void> {
    throw new Error('not in this test');
  }

  async mergePullRequest(): Promise<{ sha: string }> {
    throw new Error('not in this test');
  }
}

const never = async (): Promise<never> => {
  throw new Error('the legacy path was taken');
};

/** Two launches published from merged pull requests, imported into the launch model */
async function imported() {
  const registry = await memoryRegistry();
  const github = new LaunchesRepo();
  const media = new MemoryMediaStore();
  // A blog post's external id is its article's slug, as publishing records it
  const published = async (repo: string, ref: string, trigger: 'manual' | 'article', number: number, slug: string, posts: Array<[Channel, PostKind]>) => {
    const { launch } = await registry.launches.claim({ repo, ref, trigger, kind: 'launch', brand: 'personal' });
    for (const [channel, kind] of posts) await registry.posts.recordPost({ launchId: launch.id, channel, kind, url: `https://example.com/${channel}/${kind}`, externalId: channel === 'blog' ? slug : `${channel}-${kind}-${launch.id}` });
    return registry.launches.setStatus(launch.id, 'published', `https://github.com/${LAUNCHES}/pull/${number}`);
  };
  const release = await published('yeyo11/claudio', 'v1.0.0', 'manual', 1, 'claudio', [['blog', 'article:en'], ['bluesky', 'post']]);
  const article = await published(LAUNCHES, 'article:my-post', 'article', 2, 'my-post', [['blog', 'article:es'], ['bluesky', 'post']]);
  const service = new LaunchImportService({ registry, inTransaction: (work) => inTransaction(registry, work), github, media, launchesRepo: LAUNCHES, dryPublishing: never as never, writable: true });
  await service.apply(await service.plan({ deletions: [] }));
  github.calls = [];
  return { registry, github, media, release, article, read: new LaunchReadService({ registry, media }) };
}

const texts = (review: Review | undefined) => review?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel').map(({ path, label, kind, content }) => ({ path, label, kind, content }));
const files = (review: Review | undefined) => review?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video').map(({ path, label, kind }) => ({ path, label, kind }));

test('parity: an imported release reads from the tables as the pull request reads on GitHub, with no GitHub call', async () => {
  const { github, release, read, media } = await imported();
  const legacy = await readReview(release, { github, launchesRepo: LAUNCHES });
  github.calls = [];
  const stored = await read.review(release, never);
  assert.deepEqual(github.calls, []);

  assert.deepEqual(stored?.pullRequest, legacy?.pullRequest, 'the same pull request, merged');
  assert.deepEqual(texts(stored), texts(legacy), 'every text, as main has it now (the Bluesky edit after the merge included)');
  assert.equal(stored?.drafts.find((d) => d.path === BLUESKY)?.content, draft('Bluesky', 'hello, edited on main'));
  // The project's cover and projects.yml are the site's: listed by the pull request, not the launch's
  const ownFiles = files(legacy)?.filter((f) => !f.path.startsWith('public/covers/'));
  assert.deepEqual(files(stored), ownFiles);
  assert.deepEqual(
    stored?.drafts.filter((d) => d.kind === 'data').map((d) => d.path),
    legacy?.drafts.filter((d) => d.kind === 'data' && d.path !== 'projects.yml').map((d) => d.path),
  );

  // Each file is served by the app, from the media store
  const og = stored!.drafts.find((d) => d.path === `public/${D}/og.png`)!;
  assert.match(og.url!, /^\/media\/\d+$/);
  const served = await read.mediaFile(Number(og.url!.split('/').at(-1)));
  assert.deepEqual(served, { body: new Uint8Array([1, 2, 3]), mime: 'image/png' });
  assert.ok(media.objects.size > 0);
});

test('parity: an imported article, its own launch.yml listed as the pull request lists it', async () => {
  const { github, article, read } = await imported();
  const legacy = await readReview(article, { github, launchesRepo: LAUNCHES });
  const stored = await read.review(article, never);
  assert.deepEqual(stored?.pullRequest, legacy?.pullRequest);
  assert.deepEqual(texts(stored), texts(legacy));
  assert.deepEqual(files(stored), files(legacy));
  assert.deepEqual(stored?.drafts.filter((d) => d.kind === 'data').map((d) => d.path), legacy?.drafts.filter((d) => d.kind === 'data').map((d) => d.path));
});

test("parity: the channels are launch.yml's, with the channels the import turned off", async () => {
  const { github, release, article, read } = await imported();
  for (const launch of [release, article]) {
    const legacy = (await launchConfigOf(github, LAUNCHES, launch))!;
    github.calls = [];
    const stored = (await read.channelConfig(launch, never))!;
    assert.deepEqual(github.calls, []);
    const changed = Object.keys(legacy.publishing).filter((c) => legacy.publishing[c as keyof typeof legacy.publishing] !== stored.publishing[c as keyof typeof stored.publishing]);
    // Mastodon (and Discussions, on by default) were on and never published: off since the import
    assert.deepEqual(changed.sort(), launch === release ? ['githubDiscussions', 'mastodon'] : []);
    assert.deepEqual({ ...stored, publishing: legacy.publishing }, legacy, 'everything else as launch.yml says');
  }
});

test('parity: the pack replies and the writing assistant are grounded in is main\'s', async () => {
  const { github, release, article, read } = await imported();
  for (const launch of [release, article]) {
    const fromRepo = await packOnLaunchesRepo(github, LAUNCHES, launch);
    assert.ok(fromRepo, 'the pack parses');
    assert.deepEqual(await read.pack(launch, never), fromRepo);
  }
  github.calls = [];
  const grounding = await launchGrounding(release, { github, launchesRepo: LAUNCHES, stored: read });
  assert.equal(grounding.launch?.analysis?.summary, 'what claudio is');
  const reply = await launchReplyContext({ github, launchesRepo: LAUNCHES, checkout: async () => ({ hostPath: '/tmp/x' }) as never, stored: read })(article);
  assert.equal(reply.analysis?.summary, 'an opinion');
  assert.deepEqual(github.calls, [], 'the pack came from the tables');
});

test('a launch the tables do not hold is read as before', async () => {
  const registry = await memoryRegistry();
  const read = new LaunchReadService({ registry, media: new MemoryMediaStore() });
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/other', ref: 'v1.0.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const review = { pullRequest: { number: 3, url: 'u', state: 'open' as const, branch: 'b' }, drafts: [] };
  assert.equal(await read.review(launch, async () => review), review);
  assert.equal(await read.channelConfig(launch, async () => undefined), undefined);
  const pack = { analysis: { summary: 'from GitHub' } } as unknown as ContentPack;
  assert.equal(await read.pack(launch, async () => pack), pack);
  assert.equal(await read.mediaFile(1), undefined);
});

test('a launch the shadow write stores: open until the merge is recorded, an edit is the current text', async () => {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  github.setFile('yeyo11/claudio', '.github/launch.yml', LAUNCH_YML, 'v1.0.0');
  const media = new MemoryMediaStore();
  const store = new LaunchStoreService({ registry, media, github, launchesRepo: LAUNCHES });
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const deps = { github, registry, launchesRepo: LAUNCHES, launchStore: store } as unknown as PipelineDeps;
  const delivered = await deliverDrafts(
    launch,
    deps,
    {
      files: [
        { path: BLUESKY, content: draft('Bluesky', 'hello') },
        { path: `${D}/pack.json`, content: JSON.stringify(releasePack) },
        { path: `public/${D}/og.png`, bytes: new Uint8Array([1, 2, 3]) },
      ],
      branch: 'launch/claudio-v1.0.0',
      title: 't',
      body: 'b',
      message: 'm',
      source: { pack: releasePack as unknown as ContentPack, configText: LAUNCH_YML },
    },
    {},
  );
  assert.ok(delivered.ok);
  const drafted = delivered.launch;
  const read = new LaunchReadService({ registry, media });

  const open = await read.review(drafted, never);
  assert.deepEqual(open?.pullRequest, { number: 1, url: `https://github.com/${LAUNCHES}/pull/1`, state: 'open', branch: 'launch/claudio-v1.0.0' });
  assert.deepEqual(
    open?.drafts.map((d) => [d.path, d.kind]),
    [
      [BLUESKY, 'channel'],
      [`public/${D}/og.png`, 'image'],
      [`${D}/pack.json`, 'data'],
    ],
  );
  const og = (await registry.launchStore.media(drafted.id))[0]!;
  assert.equal(open?.drafts[1]?.url, launchMediaPath(og));
  assert.deepEqual(parseLaunchConfig(LAUNCH_YML).ok && (await read.channelConfig(drafted, never))?.publishing.mastodon, 'approval', 'nothing turned off for a launch drafted now');

  await store.edited(drafted, BLUESKY, draft('Bluesky', 'hello, edited in Shipcast'));
  assert.equal((await read.review(drafted, never))?.drafts[0]?.content, draft('Bluesky', 'hello, edited in Shipcast'));

  await registry.launchStore.approveOnce(drafted.id, { by: 'yeyo11', versions: {} });
  assert.equal((await read.review(drafted, never))?.pullRequest.state, 'merged');
});

test('a launch closed without merging reads as closed; one with no pull request has no review, as on GitHub', async () => {
  const { registry, release, read } = await imported();
  const closed = await registry.launches.setStatus(release.id, 'skipped', `https://github.com/${LAUNCHES}/pull/1: closed without merging`);
  // The import recorded the merge; a launch closed unmerged has none
  await registry.database.execute(sql`DELETE FROM approvals WHERE launch_id = ${release.id}`);
  assert.equal((await read.review(closed, never))?.pullRequest.state, 'closed');
  const direct = { ...closed, status: 'drafted', detail: 'direct:abc https://github.com/x' } as Launch;
  assert.equal(await read.review(direct, never), undefined);
});

test('the article edited after publishing is a version, so the page reads it as the site shows it', async () => {
  const { registry, release, read, media } = await imported();
  const store = new LaunchStoreService({ registry, media, github: new FakeGitHub(), launchesRepo: LAUNCHES });
  const commits: string[] = [];
  const blog: NonNullable<EditDeps['blog']> = {
    github: {
      fileAt: async (_repo, path) => text(COMMITS[MAIN]![path]),
      commitToBranch: async (_repo, branch, _message, files) => {
        commits.push(`${branch} ${files.map((f) => f.path).join(',')}`);
        return { sha: 'e'.repeat(40) };
      },
      filesUnder: async () => [],
    },
    launchesRepo: LAUNCHES,
  };
  const [post] = await registry.posts.posts(release.id, { channel: 'blog' });
  await editPost(post!.id, { text: 'The article, edited.' }, { registry, editors: async () => ({}), blog, launchStore: store, now: () => new Date('2026-10-30T10:00:00Z') });
  assert.deepEqual(commits, [`main ${ARTICLE_EN}`]);

  const article = (await registry.launchStore.drafts(release.id)).find((d) => d.piece === 'article:en')!;
  assert.equal(article.origin, 'post-publish-edit');
  assert.equal((await read.review(release, never))?.drafts.find((d) => d.path === ARTICLE_EN)?.content, '---\ntitle: "claudio"\nupdatedDate: 2026-10-30\n---\n\nThe article, edited.\n');

  // Without the launch store, the edit is the commit alone, as before
  await editPost(post!.id, { text: 'Again.' }, { registry, editors: async () => ({}), blog });
  assert.equal((await registry.launchStore.drafts(release.id)).find((d) => d.piece === 'article:en')!.n, article.n);
});
