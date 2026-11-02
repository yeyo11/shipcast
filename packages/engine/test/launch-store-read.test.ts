import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { draftFile, parseLaunchConfig, type Channel } from '@shipcast/schema';
import {
  channelRows,
  draftOfPiece,
  editPost,
  launchConfigOf,
  launchDir,
  launchGrounding,
  launchMediaPath,
  LaunchNotHeld,
  LaunchReadService,
  LaunchStoreService,
  launchReplyContext,
  mediaKind,
  mimeOf,
  storedFile,
  type EditDeps,
  type Launch,
  type PostKind,
  type Review,
  type ReviewGitHub,
} from '../src/index.ts';
import { FakeGitHub, memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

/*
 * Reading launches from the launch model (docs/launch-store-read.md): a launch the tables hold is
 * read from them alone. Checked on two launches decided in merged pull requests, held as the import
 * of those launches wrote them (docs/launch-import.md); a launch the tables do not hold is not read
 * from GitHub any more (phase 8).
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

/** The launches repo with two merged pull requests, which nothing should read once the tables hold them */
class LaunchesRepo implements ReviewGitHub {
  calls: string[] = [];

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

const bytesOf = (content: string | Uint8Array) => (typeof content === 'string' ? new TextEncoder().encode(content) : content);

/**
 * Holds a launch decided in a merged pull request as the import wrote it: the pack, the channel rows
 * (a channel on that never published turned off), a version per text at the pull request's head and
 * another where main changed it after the merge, the media, the merge as the approval, and each
 * published piece pointed at its draft's current version.
 */
async function hold(registry: Awaited<ReturnType<typeof memoryRegistry>>, media: MemoryMediaStore, launch: Launch, number: number, channelsText: string) {
  const head = COMMITS[PULLS[number]!.head]!;
  const main = COMMITS[MAIN]!;
  const batch = 'batch-1';
  const pack = JSON.parse(text(head[`${launchDir(launch)}/pack.json`])!) as Record<string, unknown>;
  const { id: packId } = await registry.launchStore.addPack(launch.id, pack, { aiTask: 'import (pull request)', importBatch: batch });

  const published = await registry.posts.posts(launch.id);
  const parsed = parseLaunchConfig(channelsText);
  assert.ok(parsed.ok);
  const rows = channelRows(parsed.value).map((row) => (row.mode === 'off' || published.some((p) => p.channel === row.channel) ? row : { ...row, mode: 'off' as const, note: 'not published before the import' }));
  await registry.launchStore.replaceChannels(launch.id, rows, channelsText, batch);

  const approved: Record<string, number> = {};
  const current = new Map<string, number>();
  const drafts: Array<{ channel: string; piece: string }> = [];
  for (const path of Object.keys(head).sort()) {
    const stored = storedFile(launch, path);
    if (stored.kind === 'draft') {
      const versions = [text(head[path])!, ...(text(main[path]) !== text(head[path]) ? [text(main[path])!] : [])];
      const ids: number[] = [];
      let draftId = 0;
      for (const body of versions) {
        const added = await registry.launchStore.addVersion(launch.id, { channel: stored.channel, piece: stored.piece, body, fields: { path }, origin: 'import', packId, importBatch: batch });
        ids.push(added.versionId);
        draftId = added.draftId;
      }
      approved[String(draftId)] = ids[0]!;
      current.set(`${stored.channel}\n${stored.piece}`, ids.at(-1)!);
      drafts.push({ channel: stored.channel, piece: stored.piece });
    } else if (stored.kind === 'media') {
      const put = await media.put(bytesOf(main[path] ?? head[path]!), mimeOf(path));
      await registry.launchStore.addMedia({
        launchId: stored.shared ? null : launch.id,
        sha256: put.sha256,
        kind: mediaKind(put.mime),
        mime: put.mime,
        bytes: put.bytes,
        storage: media.storage,
        path: put.key,
        role: stored.role,
        publicPath: stored.publicPath,
        importBatch: batch,
      });
    }
  }
  await registry.launchStore.approveOnce(launch.id, { by: 'yeyo11', at: '2026-10-24T23:10:06Z', note: `merged https://github.com/${LAUNCHES}/pull/${number} (imported)`, versions: approved, importBatch: batch });
  for (const post of published) {
    const piece = draftOfPiece(post.channel, post.kind, drafts);
    const versionId = piece === undefined ? undefined : current.get(`${post.channel}\n${piece}`);
    if (versionId !== undefined) await registry.database.execute(sql`UPDATE posts SET draft_version_id = ${versionId} WHERE id = ${post.id}`);
  }
}

/** Two launches published from merged pull requests, held by the launch model as the import left them */
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
  await hold(registry, media, release, 1, LAUNCH_YML);
  await hold(registry, media, article, 2, ARTICLE_YML);
  return { registry, github, media, release, article, read: new LaunchReadService({ registry, media }) };
}

const texts = (review: Review | undefined) => review?.drafts.filter((d) => d.kind === 'article' || d.kind === 'channel').map(({ path, label, kind, content }) => ({ path, label, kind, content }));
const files = (review: Review | undefined) => review?.drafts.filter((d) => d.kind === 'image' || d.kind === 'video').map(({ path, label, kind }) => ({ path, label, kind }));

test('an imported release reads from the tables alone: the texts as main has them, the files served by the app, no GitHub call', async () => {
  const { github, release, read, media } = await imported();
  const stored = await read.review(release);
  assert.deepEqual(github.calls, []);

  assert.deepEqual(stored?.pullRequest, { number: 1, url: `https://github.com/${LAUNCHES}/pull/1`, state: 'merged', branch: 'launch/claudio-v1.0.0' }, 'the pull request it was decided in, merged');
  assert.deepEqual(
    texts(stored)?.map((t) => t.path).sort(),
    [ARTICLE_EN, BLUESKY, MASTODON].sort(),
    'every text of the launch',
  );
  assert.equal(stored?.drafts.find((d) => d.path === BLUESKY)?.content, draft('Bluesky', 'hello, edited on main'), 'the Bluesky edit after the merge included');
  // The project's cover and projects.yml are the site's, not the launch's
  assert.deepEqual(files(stored)?.map((f) => f.path).sort(), [`public/${D}/demo.mp4`, `public/${D}/og.png`]);
  assert.deepEqual(stored?.drafts.filter((d) => d.kind === 'data').map((d) => d.path), [`${D}/pack.json`]);

  // Each file is served by the app, from the media store
  const og = stored!.drafts.find((d) => d.path === `public/${D}/og.png`)!;
  assert.match(og.url!, /^\/media\/\d+$/);
  const served = await read.mediaFile(Number(og.url!.split('/').at(-1)));
  assert.deepEqual(served, { body: new Uint8Array([1, 2, 3]), mime: 'image/png' });
  assert.ok(media.objects.size > 0);
});

test('an imported article lists its own launch.yml beside its pack', async () => {
  const { github, article, read } = await imported();
  const stored = await read.review(article);
  assert.deepEqual(github.calls, []);
  assert.equal(stored?.pullRequest?.state, 'merged');
  assert.deepEqual(texts(stored)?.map((t) => t.path).sort(), [ARTICLE_BLUESKY, ARTICLE_ES].sort());
  assert.deepEqual(files(stored)?.map((f) => f.path), [`public/${A}/og.png`]);
  assert.deepEqual(stored?.drafts.filter((d) => d.kind === 'data').map((d) => d.path).sort(), [`${A}/launch.yml`, `${A}/pack.json`]);
});

test("the channels are launch.yml's, with the channels the import turned off", async () => {
  const { github, release, article, read } = await imported();
  for (const launch of [release, article]) {
    const fromFile = (await launchConfigOf(github, LAUNCHES, launch))!;
    github.calls = [];
    const stored = (await read.channelConfig(launch))!;
    assert.deepEqual(github.calls, []);
    const changed = Object.keys(fromFile.publishing).filter((c) => fromFile.publishing[c as keyof typeof fromFile.publishing] !== stored.publishing[c as keyof typeof stored.publishing]);
    // Mastodon (and Discussions, on by default) were on and never published: off since the import
    assert.deepEqual(changed.sort(), launch === release ? ['githubDiscussions', 'mastodon'] : []);
    assert.deepEqual({ ...stored, publishing: fromFile.publishing }, fromFile, 'everything else as launch.yml says');
  }
});

test('the pack replies and the writing assistant are grounded in is the launch model’s', async () => {
  const { github, release, article, read } = await imported();
  assert.equal((await read.pack(release))?.analysis.summary, 'what claudio is');
  assert.equal((await read.pack(article))?.analysis.summary, 'an opinion');
  const grounding = await launchGrounding(release, { stored: read });
  assert.equal(grounding.launch?.analysis?.summary, 'what claudio is');
  const reply = await launchReplyContext({ checkout: async () => ({ hostPath: '/tmp/x' }) as never, stored: read })(article);
  assert.equal(reply.analysis?.summary, 'an opinion');
  assert.deepEqual(github.calls, [], 'the pack came from the tables');
});

test('a launch the tables do not hold: no review when nothing was drafted, a clear error when its drafts are only in a pull request', async () => {
  const registry = await memoryRegistry();
  const read = new LaunchReadService({ registry, media: new MemoryMediaStore() });
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/other', ref: 'v1.0.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  assert.equal(await read.review(launch), undefined);
  const inPullRequest = await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/3`);
  await assert.rejects(read.review(inPullRequest), (error: unknown) => error instanceof LaunchNotHeld && /no longer reads/.test(error.message) && error.httpStatus === 409);
  assert.equal(await read.channelConfig(inPullRequest), undefined, 'nothing to schedule by');
  assert.equal(await read.pack(inPullRequest), undefined, 'nothing to ground in');
  assert.equal(await read.mediaFile(1), undefined);
});

test('a launch closed without merging reads as closed; one with no pull request has no review, as on GitHub', async () => {
  const { registry, release, read } = await imported();
  const closed = await registry.launches.setStatus(release.id, 'skipped', `https://github.com/${LAUNCHES}/pull/1: closed without merging`);
  // The import recorded the merge; a launch closed unmerged has none
  await registry.database.execute(sql`DELETE FROM approvals WHERE launch_id = ${release.id}`);
  assert.equal((await read.review(closed))?.pullRequest?.state, 'closed');
  const direct = { ...closed, status: 'drafted', detail: 'direct:abc https://github.com/x' } as Launch;
  assert.equal(await read.review(direct), undefined);
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
  const [linked] = await registry.queries.selectRows<{ id: number }>(sql`SELECT draft_version_id AS id FROM posts WHERE id = ${post!.id}`);
  assert.equal(Number(linked!.id), article.versionId, 'the post names the version it now says');
  assert.equal((await read.review(release))?.drafts.find((d) => d.path === ARTICLE_EN)?.content, '---\ntitle: "claudio"\nupdatedDate: 2026-10-30\n---\n\nThe article, edited.\n');

  // Without the launch store, the edit is the commit alone, as before
  await editPost(post!.id, { text: 'Again.' }, { registry, editors: async () => ({}), blog });
  assert.equal((await registry.launchStore.drafts(release.id)).find((d) => d.piece === 'article:en')!.n, article.n);
});
