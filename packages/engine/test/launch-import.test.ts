import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { draftFile } from '@shipcast/schema';
import {
  channelsAsLaunchYml,
  dedupeKeyOf,
  draftOfPiece,
  gitBlobSha,
  ImportRefused,
  inTransaction,
  LaunchImportService,
  NOT_PUBLISHED,
  parseArticleInputs,
  readLaunchYml,
  readPack,
  type DryPublishing,
  type ImportGitHub,
  type Launch,
  type OpenRepositories,
  type TreeFile,
} from '../src/index.ts';
import { FakeConnectors, memoryRegistry, MemoryMediaStore } from '../src/testing/index.ts';

/*
 * The import of the launches drafted before Shipcast held them (docs/launch-import.md): planned
 * without writing, applied as one tagged batch, verified against the commits it read, idempotent,
 * and rolled back to exactly what was there, deleted launches included.
 */

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';
const HEAD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const BLUESKY = `${D}/${draftFile('bluesky').name}`;
const MASTODON = `${D}/${draftFile('mastodon').name}`;
const ARTICLE = 'src/content/posts/en/claudio.md';
const LAUNCH_YML = 'enabled: true\nbrand: personal\npublishing:\n  blog: approval\n  bluesky: approval\n  mastodon: approval\n  devto: off\n  instagram: off\n  newsletter: off\n';
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
  analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', title: 'T', description: 'D', markdown: 'B' } },
  bluesky: { lang: 'en', text: 'hello' },
  mastodon: { lang: 'en', text: 'hello' },
};
const draft = (title: string, body: string) => `# ${title}\n\n> **Approval:** published when this pull request is merged. Edit it here if it needs changes.\n\n${body}\n`;

/** The pull request's head and main after the merge, where the Bluesky draft was edited again */
const COMMITS: Record<string, Record<string, string | Uint8Array>> = {
  [HEAD]: {
    [ARTICLE]: '---\ntitle: "claudio"\ndescription: "D"\n---\n\nThe article.\n',
    [BLUESKY]: draft('Bluesky', 'hello'),
    [MASTODON]: draft('Mastodon', 'hello'),
    [`${D}/pack.json`]: `${JSON.stringify(pack, null, 2)}\n`,
    [`public/${D}/og.png`]: new Uint8Array([1, 2, 3]),
  },
  [MAIN]: {
    'brand.yml': 'id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n',
    [ARTICLE]: '---\ntitle: "claudio"\ndescription: "D"\n---\n\nThe article.\n',
    [BLUESKY]: draft('Bluesky', 'hello, edited on main'),
    [MASTODON]: draft('Mastodon', 'hello'),
    [`${D}/pack.json`]: `${JSON.stringify(pack, null, 2)}\n`,
    [`public/${D}/og.png`]: new Uint8Array([1, 2, 3]),
    'src/content/posts/en/another-launch.md': 'not this launch',
  },
};

/** GitHub as the import reads it: two commits of the launches repo, a merged pull request and the release's launch.yml */
class FakeHistory implements ImportGitHub {
  readonly #blobs = new Map<string, Uint8Array>();
  calls = 0;

  async commitSha(repo: string, ref: string): Promise<string> {
    this.calls += 1;
    return repo === LAUNCHES && ref === 'HEAD' ? MAIN : 'c'.repeat(40);
  }

  async tree(_repo: string, sha: string): Promise<TreeFile[]> {
    this.calls += 1;
    return Object.entries(COMMITS[sha] ?? {}).map(([path, content]) => {
      const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const blob = gitBlobSha(bytes);
      this.#blobs.set(blob, bytes);
      return { path, sha: blob, size: bytes.byteLength };
    });
  }

  async blob(_repo: string, sha: string): Promise<Uint8Array> {
    this.calls += 1;
    return this.#blobs.get(sha)!;
  }

  async fileAt(repo: string, path: string, ref: string): Promise<string | undefined> {
    return repo === 'yeyo11/claudio' && path === '.github/launch.yml' && ref === 'v1.0.0' ? LAUNCH_YML : undefined;
  }

  async pullRequest() {
    return { url: `https://github.com/${LAUNCHES}/pull/1`, state: 'merged' as const, headSha: HEAD, mergedBy: 'yeyo11', mergedAt: '2026-10-24T23:10:06Z' };
  }

  async pullRequestFiles(): Promise<string[]> {
    return Object.keys(COMMITS[HEAD]!);
  }
}

/** Publishers that record what they would send, as the runtime's dry ones do */
function dry(): DryPublishing {
  const fake = new FakeConnectors();
  return {
    publishers: fake.publishers(),
    strategies: {},
    get calls() {
      return fake.log;
    },
  };
}

interface World {
  registry: OpenRepositories;
  media: MemoryMediaStore;
  service: LaunchImportService;
  launch: Launch;
  test: Launch;
}

async function world(options: { writable?: boolean } = {}): Promise<World> {
  const registry = await memoryRegistry();
  const { launch: claimed } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  const launch = await registry.launches.setStatus(claimed.id, 'published', `https://github.com/${LAUNCHES}/pull/1`);
  await registry.posts.recordPost({ launchId: launch.id, channel: 'blog', kind: 'article:en', url: 'https://josegarrido.dev/en/claudio/', externalId: 'claudio' });
  await registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', kind: 'post', url: 'https://bsky.app/x', externalId: 'x' });
  // A test article removed from the blog: its one piece deleted, its numbers kept
  const { launch: testClaim } = await registry.launches.claim({ repo: LAUNCHES, ref: 'article:test', trigger: 'article', kind: 'launch', brand: 'personal' });
  const testLaunch = await registry.launches.setStatus(testClaim.id, 'skipped', 'a test');
  const { post } = await registry.posts.recordPost({ launchId: testLaunch.id, channel: 'bluesky', kind: 'post', url: 'https://bsky.app/t', externalId: 't' });
  await registry.metrics.recordMetrics(testLaunch.id, 'bluesky', { likes: 2 }, new Date('2026-10-25T00:00:00Z'), post.id);
  await registry.database.execute(sql`UPDATE posts SET status = 'deleted' WHERE id = ${post.id}`);
  const media = new MemoryMediaStore();
  const service = new LaunchImportService({
    registry,
    inTransaction: (work) => inTransaction(registry, work),
    github: new FakeHistory(),
    media,
    launchesRepo: LAUNCHES,
    dryPublishing: dry,
    writable: options.writable ?? true,
  });
  return { registry, media, service, launch, test: testLaunch };
}

const count = async (w: World, table: string) => {
  const rows = await w.registry.queries.selectRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.raw(table)}`);
  return Number(rows[0]!.n);
};

test('the dry run reads everything and writes nothing', async () => {
  const w = await world();
  const plan = await w.service.plan({ deletions: [w.test.id] });
  assert.equal(plan.at, MAIN);
  const [imported, deleted] = plan.launches;
  assert.equal(imported!.action, 'import');
  assert.equal(deleted!.action, 'delete');
  assert.deepEqual(imported!.channels!.turnedOff.sort(), ['githubDiscussions', 'mastodon'], 'on in launch.yml (or by default) and never published');
  assert.equal(imported!.drafts.find((d) => d.channel === 'bluesky')!.versions.length, 2, "the pull request's text, then main's");
  assert.ok(!imported!.drafts.some((d) => d.versions.some((v) => v.fields.path.includes('another-launch'))), "another launch's article is not this one's");
  for (const table of ['packs', 'drafts', 'media', 'launch_channels', 'approvals', 'launch_imports']) assert.equal(await count(w, table), 0, table);
  assert.ok(await w.registry.launches.get(w.test.id));
  assert.equal(w.media.objects.size, 0);
});

test('apply writes the launch model as one batch, and the verification holds', async () => {
  const w = await world();
  const batch = (await w.service.apply(await w.service.plan({ deletions: [w.test.id] })))!;
  const store = w.registry.launchStore;

  const drafts = await store.drafts(w.launch.id);
  const bluesky = drafts.find((d) => d.channel === 'bluesky')!;
  assert.equal(bluesky.n, 2);
  assert.equal(bluesky.body, COMMITS[MAIN]![BLUESKY]);
  assert.equal(bluesky.origin, 'import');
  const channels = await store.channels(w.launch.id);
  assert.equal(channels.source, LAUNCH_YML);
  assert.deepEqual(channels.rows.find((r) => r.channel === 'mastodon'), { channel: 'mastodon', mode: 'off', options: {}, note: NOT_PUBLISHED });
  assert.equal(channels.rows.find((r) => r.channel === 'bluesky')!.mode, 'approval');

  const approval = (await store.approval(w.launch.id))!;
  assert.equal(approval.by, 'yeyo11');
  assert.equal(approval.at, '2026-10-24T23:10:06Z');
  const versionOne = await w.registry.queries.selectRows<{ id: number }>(sql`SELECT v.id FROM draft_versions v WHERE v.draft_id = ${bluesky.id} AND v.n = 1`);
  assert.equal(approval.versions[String(bluesky.id)], versionOne[0]!.id, 'the merge approved the pull request\'s text, not the later edit');

  const [file] = await store.media(w.launch.id);
  assert.equal(file!.publicPath, `/${D}/og.png`);
  assert.ok(w.media.objects.has(file!.path));

  const launch = (await w.registry.launches.get(w.launch.id))!;
  assert.equal(launch.repo, 'yeyo11/claudio', 'the legacy columns stay');
  const [columns] = await w.registry.queries.selectRows<{ title: string; dedupe_key: string; model: string }>(sql`SELECT title, dedupe_key, model FROM launches WHERE id = ${w.launch.id}`);
  assert.deepEqual(columns, { title: 'claudio v1.0.0', dedupe_key: 'github-release:yeyo11/claudio@v1.0.0', model: 'legacy' });
  const linked = await w.registry.queries.selectRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM posts WHERE launch_id = ${w.launch.id} AND draft_version_id IS NOT NULL`);
  assert.equal(Number(linked[0]!.n), 2);

  assert.equal(await w.registry.launches.get(w.test.id), undefined, 'the test article is deleted');
  const verification = await w.service.verify(batch);
  assert.deepEqual(verification.problems, []);
  assert.ok(verification.passed.some((line) => line.includes('publishing, run dry with every failure forgotten, sends nothing')));
});

test('a second run finds everything done and writes nothing', async () => {
  const w = await world();
  const batch = await w.service.apply(await w.service.plan({ deletions: [w.test.id] }));
  const again = await w.service.plan({ deletions: [w.test.id] });
  assert.deepEqual(again.launches.map((l) => [l.action, l.reason]), [
    ['skip', `imported already (batch ${batch})`],
    ['skip', `deleted already (batch ${batch})`],
  ]);
  assert.equal(await w.service.apply(again), undefined);
  assert.equal(await count(w, 'launch_imports'), 2);
});

test('the rollback leaves the database as it was before the batch', async () => {
  const w = await world();
  const before = await w.registry.queries.selectRows<{ t: string }>(sql`SELECT (SELECT string_agg(l::text, '|' ORDER BY id) FROM launches l) || (SELECT string_agg(p::text, '|' ORDER BY id) FROM posts p) || (SELECT string_agg(m::text, '|' ORDER BY m::text) FROM metrics m) AS t`);
  const batch = (await w.service.apply(await w.service.plan({ deletions: [w.test.id] })))!;
  await w.service.rollback(batch);
  const after = await w.registry.queries.selectRows<{ t: string }>(sql`SELECT (SELECT string_agg(l::text, '|' ORDER BY id) FROM launches l) || (SELECT string_agg(p::text, '|' ORDER BY id) FROM posts p) || (SELECT string_agg(m::text, '|' ORDER BY m::text) FROM metrics m) AS t`);
  assert.equal(after[0]!.t, before[0]!.t);
  for (const table of ['packs', 'drafts', 'draft_versions', 'media', 'launch_channels', 'launch_sources', 'approvals']) assert.equal(await count(w, table), 0, table);
  assert.equal((await w.service.verify(batch)).problems[0], `no batch ${batch} in force`);
  // Rolled back, the launches are importable again
  assert.equal((await w.service.plan({ deletions: [w.test.id] })).launches[0]!.action, 'import');
});

test('a rollback is refused once the batch\'s launches have rows it did not write', async () => {
  const w = await world();
  const batch = (await w.service.apply(await w.service.plan({ deletions: [] })))!;
  await w.registry.launchStore.addVersion(w.launch.id, { channel: 'bluesky', piece: 'post', body: 'an edit in the app', origin: 'owner' });
  await assert.rejects(w.service.rollback(batch), (error: Error) => error instanceof ImportRefused && /1 draft_versions row not written by the import/.test(error.message));
});

test('the verification finds a channel that would publish, and a draft that is not its file', async () => {
  const w = await world();
  const batch = (await w.service.apply(await w.service.plan({ deletions: [] })))!;
  await w.registry.database.execute(sql`UPDATE launch_channels SET mode = 'approval' WHERE launch_id = ${w.launch.id} AND channel = 'mastodon'`);
  await w.registry.launchStore.addVersion(w.launch.id, { channel: 'blog', piece: 'article:en', body: 'changed', fields: { path: ARTICLE, commit: MAIN }, origin: 'owner', importBatch: batch });
  const { problems } = await w.service.verify(batch);
  assert.ok(problems.includes(`launch ${w.launch.id}: on but never published: mastodon`), problems.join('\n'));
  // Mastodon fetches the launch image before it posts, which the dry site does not serve: an attempt all the same
  assert.ok(problems.includes(`launch ${w.launch.id}: publishing would: try mastodon: https://josegarrido.dev/${D}/og.jpg answered 404`), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes(`${ARTICLE}: version 2 is not the file at bbbbbbb`)), problems.join('\n'));
});

test('without the launch-import flag nothing is written, and a launch with a live piece is never deleted', async () => {
  const w = await world({ writable: false });
  const plan = await w.service.plan({ deletions: [w.launch.id] });
  assert.equal(plan.launches[0]!.action, 'skip');
  assert.match(plan.launches[0]!.reason!, /not deleted: 2 pieces are still on a network/);
  await assert.rejects(w.service.apply(plan), ImportRefused);
  await assert.rejects(w.service.rollback('any'), ImportRefused);
  assert.equal(await count(w, 'launch_imports'), 0);
});

test('a media store that is not there refuses the import before anything is written', async () => {
  const w = await world();
  const registry = w.registry;
  const service = new LaunchImportService({ registry, inTransaction: (work) => inTransaction(registry, work), github: new FakeHistory(), media: { storage: 'none' } as never, launchesRepo: LAUNCHES, dryPublishing: dry, writable: true });
  await assert.rejects(service.apply(await service.plan({ deletions: [w.test.id] })), /media store is not available/);
  assert.ok(await registry.launches.get(w.test.id));
});

test('the pure mapping', () => {
  // `printf 'hello\n' | git hash-object --stdin`
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(dedupeKeyOf({ repo: 'yeyo11/claudio', ref: 'v0.9.0' }), 'github-release:yeyo11/claudio@v0.9.0');
  assert.equal(dedupeKeyOf({ repo: LAUNCHES, ref: 'article:sluice' }), 'article:sluice');
  assert.equal(dedupeKeyOf({ repo: 'yeyo11/x', ref: 'public:123' }), 'github-public:yeyo11/x');

  const drafts = [
    { channel: 'blog', piece: 'article:en' },
    { channel: 'newsletter', piece: 'es' },
    { channel: 'instagram', piece: 'post' },
    { channel: 'youtube', piece: 'short' },
  ];
  assert.equal(draftOfPiece('blog', 'article:en', drafts), 'article:en');
  assert.equal(draftOfPiece('newsletter', 'issue:es', drafts), 'es');
  assert.equal(draftOfPiece('instagram', 'story', drafts), 'post');
  assert.equal(draftOfPiece('youtube', 'post:short', drafts), 'short');
  assert.equal(draftOfPiece('devto', 'post', drafts), undefined);

  // v0.1.0's launch.yml, written before the manual channels were retired
  const old = 'enabled: true\nbrand: personal\npublishing:\n  blog: approval\n  hackerNews: manual\n';
  const read = readLaunchYml(old)!;
  assert.deepEqual(read.dropped, ['hackerNews: manual']);
  assert.equal(read.config.publishing.blog, 'approval');
  assert.equal(readLaunchYml('enabled: [\n'), undefined);
  assert.deepEqual(readPack({ ...pack, hackerNews: { title: 't' } }).dropped, ['hackerNews']);
  assert.deepEqual(readPack(pack).dropped, []);

  // The rows are the channels: one launch.yml names and the rows do not is gone, the rest from the rows
  const yml = channelsAsLaunchYml(old, [{ channel: 'blog', mode: 'off' }]);
  assert.match(yml, /publishing:\n {2}blog: off\n/);
  assert.doesNotMatch(yml, /hackerNews/);

  assert.deepEqual(parseArticleInputs('{"launchId":6,"input":{"markdown":"a"}}\n{"data":{"launchId":8,"input":{"markdown":"b"}},"at":"x"}\n', 'f'), [
    { launchId: 6, input: { markdown: 'a' } },
    { launchId: 8, input: { markdown: 'b' } },
  ]);
  assert.throws(() => parseArticleInputs('{"nope":1}', 'f'), /f:1: no launchId and input/);
});
