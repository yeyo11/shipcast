import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { Brand, draftBody, draftFile, type ContentPack } from '@shipcast/schema';
import {
  approval,
  AppReviewService,
  appBlogKey,
  articlePreview,
  deliverDrafts,
  LaunchReadService,
  LaunchService,
  LaunchStoreService,
  previewAddress,
  publishLaunch,
  type CommitFile,
  type LaunchServiceDeps,
  type PipelineDeps,
  type Publishers,
} from '../src/index.ts';
import { FakeConnectors, FakeGitHub, memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

/*
 * The launch model's fifth phase (docs/app-review.md): with `app-review` a new launch has no pull
 * request. Its drafts are versions, approving is a row, `auto` channels go without it, and the
 * article and its media reach the launches repo as one commit when it is published, before anything
 * links them.
 */

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';
const BRANCH = 'launch/claudio-v1.0.0';
const NOW = new Date('2026-11-02T09:00:00Z');
const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  blog: approval\n  bluesky: approval\n  mastodon: auto\n  devto: off\n  instagram: off\n  newsletter: off\n  githubDiscussions: off\n';
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'Claudio', description: 'D', markdown: 'B' } },
  bluesky: { lang: 'en', text: 'hello' },
  mastodon: { lang: 'en', text: 'hello' },
} as unknown as ContentPack;

const ARTICLE = 'src/content/posts/en/claudio.md';
const BLUESKY = `${D}/${draftFile('bluesky').name}`;
const MASTODON = `${D}/${draftFile('mastodon').name}`;
const pending = (title: string, mode: 'Approval' | 'Auto', body: string) => `# ${title}\n\n> **${mode}:** published when this pull request is merged.\n\n${body}\n`;
const ARTICLE_TEXT = '---\ntitle: "Claudio"\ndescription: "What it is"\npubDate: 2026-10-30\nimage: "/launches/claudio/v1.0.0/og.png"\n---\n\nThe article. <script>alert(1)</script> [a link](javascript:alert(1)) and ![shot](/launches/claudio/v1.0.0/og.png)\n';
const files = [
  { path: ARTICLE, content: ARTICLE_TEXT },
  { path: BLUESKY, content: pending('Bluesky', 'Approval', 'hello from bluesky') },
  { path: MASTODON, content: pending('Mastodon', 'Auto', 'hello from mastodon') },
  { path: `${D}/pack.json`, content: `${JSON.stringify(pack, null, 2)}\n` },
  { path: `public/${D}/og.png`, bytes: new Uint8Array([1, 2, 3]) },
  { path: `public/${D}/og.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
  { path: 'public/covers/claudio.jpg', bytes: new Uint8Array([4, 5]) },
  { path: 'projects.yml', content: 'claudio:\n  cover: /covers/claudio.jpg\n' },
];

/** The deployed site: live or not, the launch image's bytes */
const site = (live: () => boolean): typeof fetch =>
  (async (input: string | URL | Request) => {
    if (!live()) return new Response(null, { status: 404 });
    return String(input).endsWith('/og.jpg') ? new Response(new Uint8Array([0xff, 0xd8, 0xff])) : new Response(null, { status: 200 });
  }) as typeof fetch;

async function setup(options: { app?: boolean; config?: string } = {}) {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  github.setFile(LAUNCHES, 'projects.yml', 'other:\n  colour: "#000000"\n');
  const media = new MemoryMediaStore();
  const store = new LaunchStoreService({ registry, media, github, launchesRepo: LAUNCHES, now: () => NOW });
  const app = new AppReviewService({ registry, media, github, launchesRepo: LAUNCHES, store, now: () => NOW, token: () => 'abc123' });
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const deps = { github, registry, launchesRepo: LAUNCHES, launchStore: store, ...(options.app !== false && { appReview: app }) } as unknown as PipelineDeps;
  const deliver = async (direct = false) => {
    const result = await deliverDrafts(launch, deps, { files, branch: BRANCH, title: 't', body: 'b', message: 'm', source: { pack, configText: options.config ?? LAUNCH_YML } }, { direct });
    assert.ok(result.ok, result.ok ? '' : result.problem);
    return result.launch;
  };
  const launches = new LaunchService({ launches: registry.launches, claims: deps, github: github as unknown as LaunchServiceDeps['github'], launchStore: store, appReview: app });
  const read = new LaunchReadService({ registry, media, site: async () => brand.site });
  const fake = new FakeConnectors();
  const publishers: Publishers = fake.publishers(['bluesky', 'mastodon']);
  let live = true;
  const publish = async () => publishLaunch((await registry.launches.get(launch.id))!, brand, { github, registry, launchesRepo: LAUNCHES, publishers, fetch: site(() => live), appReview: app });
  return { registry, github, media, app, launch, deliver, launches, read, fake, publish, setLive: (on: boolean) => (live = on) };
}

const sent = (fake: FakeConnectors) => fake.calls.filter((c) => c.action === 'publish').map((c) => c.channel);

test('characterisation, flag off: the drafts go to a pull request and the launch stays on it', async () => {
  const { github, deliver } = await setup({ app: false });
  const drafted = await deliver();
  assert.equal(drafted.model, 'legacy');
  assert.equal(drafted.detail, `https://github.com/${LAUNCHES}/pull/1`);
  assert.equal(github.opened.length, 1);
  // Approval is the pull request's merge, read from GitHub
  assert.deepEqual(await approval(drafted, { github, launchesRepo: LAUNCHES }), { state: 'waiting', reason: 'the drafts pull request is open' });
});

test('with app-review the drafts stay in Shipcast: no pull request, no commit, mode lines in the app’s words', async () => {
  const { registry, github, launch, deliver } = await setup();
  const drafted = await deliver();
  assert.equal(drafted.model, 'app');
  assert.equal(drafted.status, 'drafted');
  assert.equal(drafted.detail, null);
  assert.equal(github.opened.length, 0);
  assert.equal(github.commits.length, 0);
  const drafts = await registry.launchStore.drafts(launch.id);
  assert.match(drafts.find((d) => d.channel === 'bluesky')!.body, /published once approved in Shipcast/);
  assert.match(drafts.find((d) => d.channel === 'mastodon')!.body, /without waiting for approval/);
  assert.equal((await registry.launchStore.media(launch.id)).length, 2);
});

test('a media file that cannot be stored fails the draft: the rows are all there is of the launch', async () => {
  const { registry, github, launch } = await setup();
  const media = new MemoryMediaStore();
  media.put = async () => {
    throw new Error('the bucket is away');
  };
  const store = new LaunchStoreService({ registry, media, github, launchesRepo: LAUNCHES });
  const app = new AppReviewService({ registry, media, github, launchesRepo: LAUNCHES, store });
  const deps = { github, registry, launchesRepo: LAUNCHES, appReview: app } as unknown as PipelineDeps;
  const result = await deliverDrafts(launch, deps, { files, branch: BRANCH, title: 't', body: 'b', message: 'm', source: { pack, configText: LAUNCH_YML } }, {});
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.problem, /the bucket is away/);
  assert.equal(github.opened.length, 0);
});

test('the review comes from the rows: no pull request, what waits, and the article previewed with nothing in it that runs', async () => {
  const { launch, deliver, read, github } = await setup();
  const drafted = await deliver();
  const calls = github.calls.length;
  const review = await read.review(drafted, async () => assert.fail('a launch Shipcast holds is never read elsewhere'));
  assert.equal(github.calls.length, calls);
  assert.equal(review?.pullRequest, undefined);
  assert.equal(review?.app?.open, true);
  assert.equal(review?.app?.approval, null);
  assert.deepEqual(Object.keys(review?.app?.waiting ?? {}).sort(), ['blog', 'bluesky']);
  const article = review!.drafts.find((d) => d.path === ARTICLE)!;
  assert.equal(article.approved, false);
  assert.equal(article.preview?.title, 'Claudio');
  assert.match(article.preview?.image ?? '', /^\/media\/\d+$/);
  assert.doesNotMatch(article.preview!.html, /<script/);
  assert.match(article.preview!.html, /&lt;script&gt;/);
  assert.doesNotMatch(article.preview!.html, /javascript:/);
  assert.match(article.preview!.html, /<img src="\/media\/\d+" alt="shot">/);
  assert.equal(launch.id, drafted.id);
});

test('an edit is a version of the owner’s, checked like a pull request edit, and never touches GitHub', async () => {
  const { registry, github, launch, deliver, launches } = await setup();
  await deliver();
  const before = github.calls.length;
  await launches.editDraft(launch.id, BLUESKY, pending('Bluesky', 'Approval', 'edited in the app'));
  const bluesky = (await registry.launchStore.drafts(launch.id)).find((d) => d.channel === 'bluesky')!;
  assert.equal(bluesky.n, 2);
  assert.equal(bluesky.origin, 'owner');
  assert.equal(draftBody(bluesky.body), 'edited in the app');
  assert.equal(github.calls.length, before);
  await assert.rejects(launches.editDraft(launch.id, BLUESKY, pending('Bluesky', 'Approval', 'x'.repeat(400))), /300|limit|long/i);
  await assert.rejects(launches.editDraft(launch.id, `${D}/nothing.md`, 'x'), /not a draft of this launch/);
});

test('nothing goes out before the approval while the article waits for it, auto channels included, and nothing is committed', async () => {
  const { github, fake, deliver, publish, app } = await setup();
  const drafted = await deliver();
  assert.deepEqual(await approval(drafted, { github, launchesRepo: LAUNCHES, appReview: app }), { state: 'waiting', reason: 'the article waits for approval' });
  const result = await publish();
  assert.equal(result.state, 'waiting');
  assert.match(result.state === 'waiting' ? result.reason : '', /the article waits for approval/);
  assert.deepEqual(sent(fake), []);
  assert.equal(github.commits.length, 0);
});

test('approved: the article and its media go to the site in one commit, then, once it is live, every channel with its approved text', async () => {
  const { registry, github, fake, launch, deliver, launches, publish, app } = await setup();
  const drafted = await deliver();
  assert.equal((await app.approval(drafted)).state, 'waiting');
  await launches.approve(launch.id);
  assert.deepEqual(await app.approval((await registry.launches.get(launch.id))!), { state: 'approved' });
  const stored = await registry.launchStore.approval(launch.id);
  assert.equal(Object.keys(stored!.versions).length, 3);

  const result = await publish();
  assert.equal(result.state, 'published');
  assert.equal(github.commits.length, 1);
  const commit = github.commits[0]!;
  assert.equal(commit.branch, 'main');
  const paths = commit.files.map((f: CommitFile) => f.path).sort();
  assert.deepEqual(paths, [`public/${D}/og.jpg`, `public/${D}/og.png`, 'projects.yml', 'public/covers/claudio.jpg', ARTICLE].sort());
  const article = commit.files.find((f) => f.path === ARTICLE) as { content: string };
  // Dated the day it goes out
  assert.match(article.content, /^pubDate: 2026-11-02$/m);
  assert.match(github.file(LAUNCHES, 'projects.yml') ?? '', /claudio:\n\s+colour: .*\n\s+motif: .*\n\s+cover: \/covers\/claudio.jpg/);
  assert.deepEqual(sent(fake).sort(), ['bluesky', 'mastodon']);
  assert.deepEqual((await registry.posts.posts(launch.id, { channel: 'blog' })).map((p) => p.kind), ['article:en']);
  assert.ok(await registry.cursors.cursor(appBlogKey(launch.id)));
  assert.equal((await registry.launches.get(launch.id))!.status, 'published');
  // The pieces name the version they went out with
  const { rows } = (await registry.database.execute(sql`select channel, draft_version_id from posts where launch_id = ${launch.id}`)) as unknown as { rows: Array<{ draft_version_id: number | null }> };
  assert.ok(rows.length > 0 && rows.every((r) => r.draft_version_id !== null));
});

test('an edit after the approval holds back that channel alone, until it is approved again', async () => {
  const { registry, github, fake, launch, deliver, launches, publish } = await setup();
  await deliver();
  await launches.approve(launch.id);
  await launches.editDraft(launch.id, BLUESKY, pending('Bluesky', 'Approval', 'changed after approving'));
  const first = await publish();
  assert.equal(first.state, 'partial');
  assert.deepEqual(sent(fake), ['mastodon']);
  assert.equal(github.commits.length, 1);

  await launches.approve(launch.id);
  const second = await publish();
  assert.equal(second.state, 'published');
  const bluesky = fake.calls.find((c) => c.channel === 'bluesky' && c.action === 'publish');
  assert.match(JSON.stringify(bluesky?.input), /changed after approving/);
  // The article was committed once, whatever the runs
  assert.equal(github.commits.length, 1);
  // A piece that is out is edited on its channel, not here
  await assert.rejects(launches.editDraft(launch.id, BLUESKY, 'x'), /launch is published|out already/);
  assert.equal((await registry.launches.get(launch.id))!.status, 'published');
});

test('a failed commit is tried again, and nothing goes out before the article is committed and live', async () => {
  const { github, fake, launch, deliver, launches, publish, setLive, app } = await setup();
  await deliver();
  await launches.approve(launch.id);
  github.failOn('commitToBranch', new Error('GitHub is down'));
  const failed = await publish();
  assert.equal(failed.state, 'waiting');
  assert.match(failed.state === 'waiting' ? failed.reason : '', /could not be committed.*GitHub is down/);
  assert.deepEqual(sent(fake), []);
  assert.equal(await app.published(launch.id), undefined);

  github.failOn('commitToBranch');
  setLive(false);
  const deploying = await publish();
  assert.equal(deploying.state, 'waiting');
  assert.match(deploying.state === 'waiting' ? deploying.reason : '', /is not live yet/);
  assert.deepEqual(sent(fake), []);
  assert.equal(github.commits.length, 1);

  setLive(true);
  assert.equal((await publish()).state, 'published');
  assert.equal(github.commits.length, 1);
  assert.deepEqual(sent(fake).sort(), ['bluesky', 'mastodon']);
});

test('a run that stopped between its commit and its record does not commit again', async () => {
  const { registry, github, media, launch, deliver, launches } = await setup();
  await deliver();
  await launches.approve(launch.id);
  const held = (await registry.launches.get(launch.id))!;
  // The record of the commit is lost, as when the process stops right after GitHub answered
  let lose = true;
  const cursors = {
    cursor: (key: string) => registry.cursors.cursor(key),
    deleteCursor: (key: string) => registry.cursors.deleteCursor(key),
    setCursor: async (key: string, value: string) => {
      if (lose && value.includes('"sha"')) {
        lose = false;
        throw new Error('the process stopped');
      }
      return registry.cursors.setCursor(key, value);
    },
  } as unknown as typeof registry.cursors;
  const store = new LaunchStoreService({ registry, media, github, launchesRepo: LAUNCHES });
  const stopping = new AppReviewService({ registry: { ...registry, cursors }, media, github, launchesRepo: LAUNCHES, store, now: () => NOW });
  await assert.rejects(stopping.publishSite(held, { article: true, title: 'Claudio' }), /the process stopped/);
  assert.equal(github.commits.length, 1);
  const again = await stopping.publishSite(held, { article: true, title: 'Claudio' });
  assert.equal(again?.sha, 'found on main');
  assert.equal(github.commits.length, 1);
  assert.equal((await stopping.published(launch.id))?.sha, 'found on main');
});

test('auto channels go out without approval as soon as the drafts are ready; without the article the media alone are committed', async () => {
  const config = LAUNCH_YML.replace('blog: approval', 'blog: off');
  const { github, fake, deliver, publish, app } = await setup({ config });
  const drafted = await deliver();
  assert.deepEqual(await app.approval(drafted), { state: 'approved' });
  const result = await publish();
  assert.equal(result.state, 'partial');
  assert.deepEqual(sent(fake), ['mastodon']);
  assert.equal(github.commits.length, 1);
  assert.ok(github.commits[0]!.files.every((f) => f.path !== ARTICLE));
});

test('published directly from the app, the drafts are approved as they are', async () => {
  const { registry, launch, deliver, github } = await setup();
  const drafted = await deliver(true);
  assert.equal(drafted.model, 'app');
  assert.equal(github.commits.length, 0);
  assert.equal((await registry.launchStore.approval(launch.id))?.by, 'shipcast');
});

test('the real site preview: a preview branch and its draft pull request, the address read from the workflow’s comment, closed at publishing', async () => {
  const { github, launch, deliver, launches, publish, app, registry } = await setup();
  const drafted = await deliver();
  const preview = await app.requestPreview(drafted);
  assert.equal(preview.branch, `preview/launch-${launch.id}-abc123`);
  const pushed = github.called('pushPreview')[0]![0] as { files: CommitFile[]; base: string };
  assert.equal(pushed.base, 'main');
  assert.ok(pushed.files.some((f) => f.path === ARTICLE));
  assert.equal(github.commits.length, 0);
  assert.equal((await app.findPreview(drafted))?.url, undefined);

  github.comments.set(`${LAUNCHES}#${preview.number}`, [`<!-- cloudflare-preview -->\n**Preview on Cloudflare Workers** for \`${preview.sha.slice(0, 7)}\`\n\n- Branch: https://preview-launch-1-abc123-josegarrido-dev.acct.workers.dev\n`]);
  const found = await app.findPreview(drafted);
  assert.equal(found?.url, 'https://preview-launch-1-abc123-josegarrido-dev.acct.workers.dev');
  // Asking again reuses the branch
  assert.equal((await app.requestPreview(drafted)).branch, preview.branch);

  await launches.approve(launch.id);
  await publish();
  assert.equal(github.called('closePreview').length, 1);
  assert.equal(await app.sitePreview(launch.id), undefined);
  assert.ok(registry);
});

test('a launch Shipcast holds waits in a process without the flag, and a legacy launch is never edited here', async () => {
  const { registry, github, launch, deliver } = await setup();
  const drafted = await deliver();
  const without = await publishLaunch(drafted, brand, { github, registry, launchesRepo: LAUNCHES, publishers: {} });
  assert.equal(without.state, 'waiting');
  assert.match(without.state === 'waiting' ? without.reason : '', /app-review flag is off/);
  const plain = new LaunchService({ launches: registry.launches, claims: { github, registry, launchesRepo: LAUNCHES } as unknown as PipelineDeps, github: github as unknown as LaunchServiceDeps['github'] });
  await assert.rejects(plain.approve(launch.id), /app-review flag is off/);
});

test('the preview address and the article preview, as pure functions', () => {
  assert.equal(previewAddress(['no mark here']), undefined);
  assert.deepEqual(previewAddress(['<!-- cloudflare-preview -->\nfor `abcdef1`\n- This version: https://v1-x.acct.workers.dev']), { url: 'https://v1-x.acct.workers.dev', sha: 'abcdef1' });
  const preview = articlePreview('---\ntitle: T\n---\n\n[home](/en/) <b>bold</b>\n', { site: 'https://josegarrido.dev', media: () => undefined });
  assert.match(preview.html, /href="https:\/\/josegarrido.dev\/en\/"/);
  assert.match(preview.html, /&lt;b&gt;bold&lt;\/b&gt;/);
});

test('who edited and who approved is recorded: the login, or `owner` when the caller does not say', async () => {
  const { registry, launch, deliver, launches } = await setup();
  await deliver();
  await launches.editDraft(launch.id, BLUESKY, pending('Bluesky', 'Approval', 'by the owner'), 'yeyo11');
  const { rows } = (await registry.database.execute(sql`select author from draft_versions where origin = 'owner'`)) as unknown as { rows: Array<{ author: string | null }> };
  assert.deepEqual(rows, [{ author: 'yeyo11' }]);
  await launches.approve(launch.id, 'yeyo11');
  assert.equal((await registry.launchStore.approval(launch.id))?.by, 'yeyo11');
  await launches.editDraft(launch.id, BLUESKY, pending('Bluesky', 'Approval', 'again'));
  await launches.approve(launch.id);
  assert.equal((await registry.launchStore.approval(launch.id))?.by, 'owner');
});
