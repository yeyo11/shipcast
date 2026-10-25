import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry, type NewLaunch } from '../src/index.ts';
import { memoryRegistry as memory } from '../src/testing.ts';

const release: NewLaunch = { repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'major', brand: 'personal' };

test('a release is claimed once: the second claim gets the existing launch back', async () => {
  const registry = await memory();
  const first = await registry.claim(release);
  assert.equal(first.claimed, true);
  assert.equal(first.launch.status, 'detected');

  const again = await registry.claim({ ...release, trigger: 'manual', kind: 'minor' });
  assert.equal(again.claimed, false);
  assert.equal(again.launch.id, first.launch.id);
  assert.equal(again.launch.kind, 'major', 'the first claim is the one that counts');
});

test('claims of the same release at once: exactly one wins', async () => {
  const registry = await memory();
  const claims = await Promise.all(Array.from({ length: 5 }, () => registry.claim(release)));
  assert.equal(claims.filter((c) => c.claimed).length, 1);
  assert.equal(new Set(claims.map((c) => c.launch.id)).size, 1);
});

test('timestamps are ISO 8601 in UTC with milliseconds, as SQLite wrote them', async () => {
  const registry = await memory();
  const { launch } = await registry.claim(release);
  assert.match(launch.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(launch.updatedAt, launch.createdAt, 'one statement, one moment');
});

test('a skipped release stays recorded, so the next poll does not pick it up again', async () => {
  const registry = await memory();
  const { launch } = await registry.claim(release);
  await registry.setStatus(launch.id, 'skipped', 'launch.yml has enabled: false');
  const again = await registry.claim(release);
  assert.equal(again.claimed, false);
  assert.equal(again.launch.status, 'skipped');
  assert.equal(again.launch.detail, 'launch.yml has enabled: false');
});

test('the last published ref feeds the pack inference; drafts and failures do not count', async () => {
  const registry = await memory();
  assert.equal(await registry.lastPublishedRef('yeyo11/claudio'), undefined);

  const a = (await registry.claim({ ...release, ref: 'v0.8.0' })).launch;
  await registry.setStatus(a.id, 'published');
  const b = (await registry.claim({ ...release, ref: 'v0.8.1' })).launch;
  await registry.setStatus(b.id, 'failed', 'dev.to answered 500');

  assert.equal(await registry.lastPublishedRef('yeyo11/claudio'), 'v0.8.0');
  assert.equal(await registry.lastPublishedRef('yeyo11/other'), undefined);
});

test('a piece is published once per channel', async () => {
  const registry = await memory();
  const { launch } = await registry.claim(release);
  assert.deepEqual(await registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '1' }), {
    recorded: true,
  });
  assert.deepEqual(await registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/y', externalId: '2' }), {
    recorded: false,
  });
  const posts = await registry.posts(launch.id);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, 'https://dev.to/x');
});

test('setStatus on an unknown launch throws instead of silently doing nothing', async () => {
  await assert.rejects((await memory()).setStatus(999, 'published'), /no launch with id 999/);
});

test('cursors keep polling state across restarts, and the schema survives reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-registry-'));
  try {
    const first = await Registry.memory(dir);
    await first.setCursor('events:yeyo11', 'W/"etag-1"');
    await first.claim(release);
    await first.close();

    // Reopening runs the migrations again: already applied, they change nothing
    const reopened = await Registry.memory(dir);
    assert.equal(await reopened.cursor('events:yeyo11'), 'W/"etag-1"');
    assert.equal((await reopened.find('yeyo11/claudio', 'v0.9.0'))?.status, 'detected');
    await reopened.setCursor('events:yeyo11', 'W/"etag-2"');
    assert.equal(await reopened.cursor('events:yeyo11'), 'W/"etag-2"');
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a channel that failed for good can be retried, without posting the others again', async () => {
  const registry = await memory();
  const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  await registry.setStatus(launch.id, 'published', 'https://github.com/yeyo11/launches/pull/1');
  await registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '1' });
  await registry.setCursor(`publish-failed:${launch.id}:newsletter`, 'Brevo: 405');
  await registry.setCursor(`publish-failed:${launch.id}:devto`, 'stale');

  const reopened = await registry.retryChannel('newsletter');
  assert.deepEqual(reopened.map((l) => l.status), ['drafted']);
  assert.equal(reopened[0]!.detail, 'https://github.com/yeyo11/launches/pull/1', 'the pull request stays recorded');
  assert.equal(await registry.cursor(`publish-failed:${launch.id}:newsletter`), undefined);
  assert.equal(await registry.cursor(`publish-failed:${launch.id}:devto`), 'stale', 'other channels untouched');
  assert.deepEqual(await registry.retryChannel('newsletter'), [], 'nothing left to retry');
});

test('accounts: the first per network and brand is the primary, and another can take over', async () => {
  const registry = await memory();
  const a = await registry.addAccount({ network: 'mastodon', brand: 'personal', label: 'main', settings: { instance: 'https://mastodon.social' } });
  const b = await registry.addAccount({ network: 'mastodon', brand: 'personal', label: 'second', settings: {} });
  const c = await registry.addAccount({ network: 'mastodon', brand: 'company', label: 'main', settings: {} });
  assert.equal(a.primary, true);
  assert.equal(b.primary, false);
  assert.equal(c.primary, true, 'brands never share a primary');
  assert.equal((await registry.primaryAccount('personal', 'mastodon'))?.id, a.id);

  await registry.makePrimary(b.id);
  assert.equal((await registry.primaryAccount('personal', 'mastodon'))?.id, b.id);
  assert.equal((await registry.account(a.id))?.primary, false);

  await registry.deleteAccount(b.id);
  assert.equal((await registry.primaryAccount('personal', 'mastodon'))?.id, a.id, 'the next one takes over');
  assert.deepEqual((await registry.accounts({ brand: 'company' })).map((x) => x.id), [c.id]);

  const checked = await registry.recordCheck(a.id, { ok: false, problem: 'rejected' }, new Date('2026-10-25T00:00:00Z'));
  assert.deepEqual([checked.status, checked.problem, checked.checkedAt], ['failed', 'rejected', '2026-10-25T00:00:00.000Z']);
  assert.equal((await registry.updateAccount(a.id, { label: 'renamed' })).label, 'renamed');
  assert.deepEqual((await registry.account(a.id))?.settings, { instance: 'https://mastodon.social' });
});

test('accounts added at once for a new network and brand get one primary between them', async () => {
  const registry = await memory();
  const added = await Promise.all(['a', 'b', 'c'].map((label) => registry.addAccount({ network: 'bluesky', brand: 'personal', label, settings: {} })));
  assert.equal(added.filter((a) => a.primary).length, 1);
});

test('cursors are listed by prefix', async () => {
  const registry = await memory();
  await registry.setCursor('publish-failed:1:devto', 'rejected');
  await registry.setCursor('publish-failed:1:bluesky', 'down');
  await registry.setCursor('publish-failed:12:devto', 'other launch');
  await registry.setCursor('publish-failedX1:devto', 'not a match for a LIKE wildcard either');
  assert.deepEqual((await registry.cursorsWithPrefix('publish-failed:1:')).map((c) => c.key), ['publish-failed:1:bluesky', 'publish-failed:1:devto']);
});

test('metrics keep every reading; the latest of each is the newest', async () => {
  const registry = await memory();
  const { launch } = await registry.claim(release);
  await registry.recordMetrics(launch.id, 'devto', { views: 10, likes: 1, broken: Number.NaN }, new Date('2026-10-01T00:00:00Z'));
  await registry.recordMetrics(launch.id, 'devto', { views: 25.5 }, new Date('2026-10-02T00:00:00Z'));
  assert.deepEqual(
    (await registry.latestMetrics(launch.id)).map((m) => [m.name, m.value]),
    [
      ['likes', 1],
      ['views', 25.5],
    ],
  );
  assert.deepEqual((await registry.metricHistory(launch.id, 'devto', 'views')).map((m) => m.value), [10, 25.5]);
});
