import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GitHubError } from '../../src/index.ts';
import { FakeGitHub } from '../../src/testing/github.ts';

test('files are read per repo, path and ref, the default branch being HEAD, and every call is recorded', async () => {
  const github = new FakeGitHub({ files: { 'me/app/.github/launch.yml@v1.0.0': 'enabled: true\n' } });
  github.setFile('me/launches', 'brand.yml', 'id: personal\n');
  assert.equal(await github.fileAt('me/app', '.github/launch.yml', 'v1.0.0'), 'enabled: true\n');
  assert.equal(await github.fileAt('me/app', '.github/launch.yml', 'v2.0.0'), undefined);
  assert.equal(await github.fileAt('me/launches', 'brand.yml', 'main'), 'id: personal\n', 'main is HEAD');
  assert.deepEqual(github.called('fileAt')[0], ['me/app', '.github/launch.yml', 'v1.0.0']);
  assert.equal(github.calls.length, 3);
});

test('a pull request carries its files on its branch until it is merged, and a second one of the branch is the same', async () => {
  const github = new FakeGitHub({ firstPullRequest: 7 });
  const draft = { repo: 'me/launches', branch: 'launch/app-v1', base: 'main', title: 'Launch app v1', body: 'b', message: 'm', files: [{ path: 'launches/app/v1/bluesky.md', content: '# Bluesky\n' }, { path: 'public/og.png', bytes: new Uint8Array([1]) }] };
  assert.deepEqual(await github.openPullRequest(draft), { number: 7, url: 'https://github.com/me/launches/pull/7', created: true });
  assert.deepEqual(await github.openPullRequest(draft), { number: 7, url: 'https://github.com/me/launches/pull/7', created: false });
  assert.equal(github.opened.length, 1);
  assert.equal(await github.pullRequestState('me/launches', 7), 'open');
  assert.equal(github.file('me/launches', 'launches/app/v1/bluesky.md'), undefined, 'not on main before the merge');
  assert.deepEqual(await github.pullRequestFiles('me/launches', 7), ['launches/app/v1/bluesky.md', 'public/og.png']);

  await github.updateFile('me/launches', 'launch/app-v1', 'launches/app/v1/bluesky.md', '# Bluesky\n\nedited\n', 'Edit');
  await github.mergePullRequest('me/launches', 7, 'Launch app v1');
  assert.equal(await github.pullRequestState('me/launches', 7), 'merged');
  assert.equal(github.file('me/launches', 'launches/app/v1/bluesky.md'), '# Bluesky\n\nedited\n');
  assert.deepEqual(github.blobs['me/launches/public/og.png@HEAD'], new Uint8Array([1]));
  await assert.rejects(github.pullRequest('me/launches', 99), (e) => e instanceof GitHubError && e.status === 404);
  assert.equal(await github.pullRequestState('me/launches', 99), 'open', 'one it was not given answers the default state');
});

test('commits write and delete files on a branch, folders list what is under them, and a method can be made to fail', async () => {
  const github = new FakeGitHub({ files: { 'me/launches/public/launches/app/v1/og.png@HEAD': 'x', 'me/launches/public/launches/app/v1/a.jpg@HEAD': 'y' } });
  const { sha } = await github.commitToBranch('me/launches', 'main', 'Delete', [{ path: 'public/launches/app/v1/og.png', delete: true }, { path: 'src/a.md', content: 'A' }]);
  assert.equal(sha, 'sha1');
  assert.deepEqual(await github.filesUnder('me/launches', 'HEAD', 'public/launches/app/v1'), ['public/launches/app/v1/a.jpg']);
  assert.equal(github.file('me/launches', 'src/a.md'), 'A');
  assert.equal(github.commits[0]?.message, 'Delete');

  github.failOn('fileAt', new Error('404'));
  await assert.rejects(github.fileAt('me/launches', 'src/a.md', 'HEAD'), /404/);
  github.failOn('fileAt');
  assert.equal(await github.fileAt('me/launches', 'src/a.md', 'HEAD'), 'A');
});

test('events are answered page by page, then not modified', async () => {
  const github = new FakeGitHub({ events: [{ notModified: false, etag: 'W/"1"', events: [] }], latestRelease: { tag: 'v1', url: 'u' } });
  assert.deepEqual(await github.userEvents('me'), { notModified: false, etag: 'W/"1"', events: [] });
  assert.deepEqual(await github.userEvents('me', 'W/"1"'), { notModified: true });
  assert.deepEqual(github.called('userEvents'), [['me', undefined], ['me', 'W/"1"']]);
  assert.deepEqual(await github.latestRelease('me/app'), { tag: 'v1', url: 'u' });
});
