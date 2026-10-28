import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deliverDrafts, DraftSnapshotService, readReview, reviewFromSnapshot, type PipelineDeps } from '../src/index.ts';
import { FakeGitHub, memoryRegistry } from '../src/testing/index.ts';

const LAUNCHES = 'yeyo11/launches';
const D = 'launches/claudio/v1.0.0';

async function drafted() {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  github.setFile('yeyo11/claudio', '.github/launch.yml', 'brand: personal\n', 'v1.0.0');
  const files = [`${D}/bluesky.md`, 'src/content/posts/en/claudio.md', `public/${D}/og.jpg`];
  github.addPullRequest({ repo: LAUNCHES, number: 7, branch: 'launch/claudio-v1.0.0', files });
  for (const path of files.slice(0, 2)) github.setFile(LAUNCHES, path, `# ${path}\n`, 'launch/claudio-v1.0.0');
  const withPr = await registry.launches.setStatus(launch.id, 'drafted', `https://github.com/${LAUNCHES}/pull/7`);
  const service = new DraftSnapshotService({ github, registry, launchesRepo: LAUNCHES });
  return { registry, github, launch: withPr, service };
}

test('a refreshed snapshot holds the pull request, each text and launch.yml, and reads as the same review GitHub gives', async () => {
  const { github, launch, service } = await drafted();
  const snapshot = await service.refresh(launch);
  assert.ok(snapshot);
  assert.equal(snapshot.pullRequest.state, 'open');
  assert.equal(snapshot.launchYml, 'brand: personal\n');
  assert.equal(snapshot.files.find((f) => f.path.endsWith('og.jpg'))?.content, null, 'media is listed, not read');
  assert.equal(snapshot.files.find((f) => f.path.endsWith('bluesky.md'))?.content, `# ${D}/bluesky.md\n`);
  assert.ok(snapshot.readAt);
  assert.deepEqual(reviewFromSnapshot(launch, snapshot, LAUNCHES), await readReview(launch, { github, launchesRepo: LAUNCHES }));
});

test("an edit Shipcast makes is in the snapshot at once; the poll reads only the pull requests still open", async () => {
  const { registry, github, launch, service } = await drafted();
  await service.refresh(launch);
  await service.edited(launch, `${D}/bluesky.md`, 'edited\n');
  const after = await service.get(launch.id);
  assert.equal(after?.files.find((f) => f.path.endsWith('bluesky.md'))?.content, 'edited\n');
  assert.equal(after?.headSha, null, 'the head moved: GitHub tells the new one');

  github.pulls.get(`${LAUNCHES}#7`)!.state = 'merged';
  assert.deepEqual(await service.refreshOpen(), { refreshed: 1, problems: [] });
  assert.equal((await registry.drafts.snapshot(launch.id))?.pullRequest.state, 'merged');
  const reads = github.calls.length;
  assert.deepEqual(await service.refreshOpen(), { refreshed: 0, problems: [] }, 'a merged pull request is not read again');
  assert.equal(github.calls.length, reads);
  assert.equal((await service.launchOf(7))?.id, launch.id);
  assert.equal(await service.launchOf(8), undefined);
});

test('opening the pull request writes its snapshot from the files pushed, without reading them back', async () => {
  const registry = await memoryRegistry();
  const github = new FakeGitHub();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v1.0.0', trigger: 'release', kind: 'launch', brand: 'personal' });
  const service = new DraftSnapshotService({ github, registry, launchesRepo: LAUNCHES });
  const deps = { github, registry, launchesRepo: LAUNCHES, drafts: service } as unknown as PipelineDeps;
  const files = [{ path: `${D}/bluesky.md`, content: 'hello\n' }, { path: `public/${D}/og.jpg`, bytes: new Uint8Array([1]) }];
  const result = await deliverDrafts(launch, deps, { files, branch: 'launch/claudio-v1.0.0', title: 't', body: 'b', message: 'm' }, {});
  assert.ok(result.ok);
  const snapshot = await registry.drafts.snapshot(launch.id);
  assert.equal(snapshot?.pullRequest.branch, 'launch/claudio-v1.0.0');
  assert.deepEqual(
    snapshot?.files.map((f) => [f.path, f.content]),
    [
      [`${D}/bluesky.md`, 'hello\n'],
      [`public/${D}/og.jpg`, null],
    ],
  );
  assert.equal(github.called('pullRequestFiles').length, 0);
});
