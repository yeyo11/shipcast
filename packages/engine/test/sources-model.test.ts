import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSources, InvalidSources, primaryRepoOf, SOURCE_LIMITS, sourceRepos, type LaunchSource, type SourcesLaunchInput } from '../src/index.ts';
import { aLaunch, memoryRegistry } from '../src/testing/index.ts';

/*
 * A launch made from sources (launch-sources): what a request may hold, which repo is the primary
 * one, and the rows the registry keeps for it.
 */

const input = (sources: SourcesLaunchInput['sources'], title = 'A launch'): SourcesLaunchInput => ({ title, lang: 'en', channels: [], sources });
const SHA = 'a'.repeat(64);

test('a request needs a title and at least one source, each of a kind it can read', () => {
  assert.throws(() => checkSources(input([], 'x')), /at least one source/);
  assert.throws(() => checkSources(input([{ kind: 'text', text: 'hi' }], '  ')), /needs a title/);
  assert.throws(() => checkSources(input([{ kind: 'text', text: '   ' }])), /is empty/);
  assert.throws(() => checkSources(input([{ kind: 'url', url: 'file:///etc/passwd' }])), /http or https/);
  assert.throws(() => checkSources(input([{ kind: 'url', url: 'not a url' }])), /not a URL/);
  assert.throws(() => checkSources(input([{ kind: 'repo', repo: 'no-slash' }])), /owner\/name/);
  assert.throws(() => checkSources(input([{ kind: 'media', sha256: 'abc' }])), /sha256/);
  assert.throws(() => checkSources(input([{ kind: 'text', text: 'x'.repeat(SOURCE_LIMITS.textChars + 1) }])), InvalidSources);
  checkSources(input([{ kind: 'text', text: 'mine' }, { kind: 'url', url: 'https://example.com' }, { kind: 'repo', repo: 'yeyo11/claudio' }, { kind: 'media', sha256: SHA }]));
});

test('a request is bounded: sources, repos, pages and files, and a repo once', () => {
  const many = Array.from({ length: SOURCE_LIMITS.sources + 1 }, () => ({ kind: 'text' as const, text: 'x' }));
  assert.throws(() => checkSources(input(many)), /at most 12 sources/);
  const pages = Array.from({ length: SOURCE_LIMITS.urls + 1 }, (_, i) => ({ kind: 'url' as const, url: `https://example.com/${i}` }));
  assert.throws(() => checkSources(input(pages)), /at most 8 pages/);
  assert.throws(() => checkSources(input([{ kind: 'repo', repo: 'a/b' }, { kind: 'repo', repo: 'A/B' }])), /given twice/);
  assert.throws(() => checkSources(input([{ kind: 'repo', repo: 'a/b', primary: true }, { kind: 'repo', repo: 'a/c', primary: true }])), /only one repo/);
});

test('the primary repo is the one marked, or the first', () => {
  assert.equal(primaryRepoOf([{ kind: 'text', text: 'x' }]), undefined);
  assert.equal(primaryRepoOf([{ kind: 'repo', repo: 'a/one' }, { kind: 'repo', repo: 'a/two' }])?.repo, 'a/one');
  assert.equal(primaryRepoOf([{ kind: 'repo', repo: 'a/one' }, { kind: 'repo', repo: 'a/two', primary: true }])?.repo, 'a/two');
});

test('the registry keeps a launch’s sources in order, its uploads shared by their bytes', async () => {
  const registry = await memoryRegistry();
  const launch = await aLaunch(registry);
  const other = await aLaunch(registry, { repo: 'yeyo11/shipcast', ref: 'v0.2.0' });

  const upload = await registry.sources.recordUpload({ sha256: SHA, kind: 'image', mime: 'image/png', bytes: 10, width: 3, height: 2, storage: 'r2', path: `media/aa/${SHA}` });
  assert.deepEqual(await registry.sources.recordUpload({ sha256: SHA, kind: 'image', mime: 'image/png', bytes: 10, width: 3, height: 2, storage: 'r2', path: `media/aa/${SHA}` }), upload, 'the same bytes twice are one upload');
  assert.equal((await registry.sources.upload(SHA))?.id, upload.id);
  const owned = await registry.sources.attach(launch.id, upload);
  assert.notEqual(owned.id, upload.id, 'the launch owns a row of its own');
  assert.equal((await registry.sources.attach(launch.id, upload)).id, owned.id, 'attached twice is one row');

  const rows = await registry.sources.replace(launch.id, [
    { kind: 'repo_release', role: 'primary', repo: 'yeyo11/claudio', ref: 'v0.9.0' },
    { kind: 'repo', role: 'context', repo: 'yeyo11/shipcast' },
    { kind: 'text', role: 'context', text: 'my words', meta: { title: 'Why' } },
    { kind: 'media', role: 'context', mediaId: owned.id, meta: { alt: 'the dashboard' } },
  ]);
  assert.deepEqual(rows.map((r) => [r.position, r.kind, r.role]), [[1, 'repo_release', 'primary'], [2, 'repo', 'context'], [3, 'text', 'context'], [4, 'media', 'context']]);
  assert.equal(rows[3]!.media?.sha256, SHA);
  assert.deepEqual(rows[2]!.meta, { title: 'Why' });

  await registry.sources.freeze(rows[0]!.id, 'f'.repeat(40));
  assert.equal((await registry.sources.list(launch.id))[0]!.sha, 'f'.repeat(40));

  await registry.sources.replace(other.id, [{ kind: 'repo_release', role: 'primary', repo: 'yeyo11/shipcast', ref: 'v0.2.0' }, { kind: 'repo', role: 'context', repo: 'yeyo11/claudio' }]);
  const further = await registry.sources.furtherRepos([launch.id, other.id]);
  assert.deepEqual(further.get(launch.id), ['yeyo11/shipcast'], 'the primary repo is not a further one');
  assert.deepEqual(further.get(other.id), ['yeyo11/claudio']);
  assert.deepEqual(sourceRepos(await registry.sources.list(launch.id)), ['yeyo11/claudio', 'yeyo11/shipcast']);

  const again = await registry.sources.replace(launch.id, [{ kind: 'text', role: 'context', text: 'only this' }]);
  assert.deepEqual(again.map((r: LaunchSource) => r.position), [1], 'replacing starts the numbering again');
});
