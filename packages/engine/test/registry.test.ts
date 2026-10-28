import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JOB_LOG_LINES, Registry, retryChannelEverywhere, type NewLaunch } from '../src/index.ts';
import { memoryRegistry as memory } from '../src/testing.ts';

const release: NewLaunch = { repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'major', brand: 'personal' };

test('a release is claimed once: the second claim gets the existing launch back', async () => {
  const registry = await memory();
  const first = await registry.launches.claim(release);
  assert.equal(first.claimed, true);
  assert.equal(first.launch.status, 'detected');

  const again = await registry.launches.claim({ ...release, trigger: 'manual', kind: 'minor' });
  assert.equal(again.claimed, false);
  assert.equal(again.launch.id, first.launch.id);
  assert.equal(again.launch.kind, 'major', 'the first claim is the one that counts');
});

test('claims of the same release at once: exactly one wins', async () => {
  const registry = await memory();
  const claims = await Promise.all(Array.from({ length: 5 }, () => registry.launches.claim(release)));
  assert.equal(claims.filter((c) => c.claimed).length, 1);
  assert.equal(new Set(claims.map((c) => c.launch.id)).size, 1);
});

test('timestamps are ISO 8601 in UTC with milliseconds, as SQLite wrote them', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  assert.match(launch.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(launch.updatedAt, launch.createdAt, 'one statement, one moment');
});

test('a skipped release stays recorded, so the next poll does not pick it up again', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  await registry.launches.setStatus(launch.id, 'skipped', 'launch.yml has enabled: false');
  const again = await registry.launches.claim(release);
  assert.equal(again.claimed, false);
  assert.equal(again.launch.status, 'skipped');
  assert.equal(again.launch.detail, 'launch.yml has enabled: false');
});

test('the last published ref feeds the pack inference; drafts and failures do not count', async () => {
  const registry = await memory();
  assert.equal(await registry.launches.lastPublishedRef('yeyo11/claudio'), undefined);

  const a = (await registry.launches.claim({ ...release, ref: 'v0.8.0' })).launch;
  await registry.launches.setStatus(a.id, 'published');
  const b = (await registry.launches.claim({ ...release, ref: 'v0.8.1' })).launch;
  await registry.launches.setStatus(b.id, 'failed', 'dev.to answered 500');

  assert.equal(await registry.launches.lastPublishedRef('yeyo11/claudio'), 'v0.8.0');
  assert.equal(await registry.launches.lastPublishedRef('yeyo11/other'), undefined);
});

test('a piece is published once per launch, channel, account and kind', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  const account = await registry.addAccount({ network: 'devto', brand: 'personal', label: '@me', settings: {} });
  const first = await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', accountId: account.id, url: 'https://dev.to/x', externalId: '1' });
  assert.equal(first.recorded, true);
  assert.equal(first.post.kind, 'post');
  assert.equal(first.post.status, 'live');
  assert.equal(first.post.accountId, account.id);
  const again = await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', accountId: account.id, url: 'https://dev.to/y', externalId: '2' });
  assert.equal(again.recorded, false);
  assert.equal(again.post.id, first.post.id, 'the piece already there comes back');
  assert.equal(again.post.url, 'https://dev.to/x');
  assert.deepEqual(await registry.posts.post(first.post.id), first.post);
  assert.equal((await registry.posts.posts(launch.id)).length, 1);
});

test('with no account, nulls are not distinct: a blog article is still recorded once', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  const piece = { launchId: launch.id, channel: 'blog' as const, kind: 'article:en' as const, url: 'https://example.dev/en/a/', externalId: 'a' };
  assert.equal((await registry.posts.recordPost(piece)).recorded, true);
  const again = await registry.posts.recordPost({ ...piece, url: 'https://example.dev/en/b/' });
  assert.equal(again.recorded, false);
  assert.equal(again.post.url, 'https://example.dev/en/a/');
  assert.equal((await registry.posts.recordPost({ ...piece, kind: 'article:es', url: 'https://example.dev/es/a/' })).recorded, true, 'another language is another piece');
  assert.deepEqual(
    (await registry.posts.posts(launch.id, { channel: 'blog' })).map((p) => [p.kind, p.accountId]),
    [
      ['article:en', null],
      ['article:es', null],
    ],
  );
  assert.deepEqual((await registry.posts.posts(launch.id, { kind: 'article:es' })).map((p) => p.url), ['https://example.dev/es/a/']);
});

test('removing an account keeps its pieces, no longer attributed', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  const account = await registry.addAccount({ network: 'mastodon', brand: 'personal', label: '@me', settings: {} });
  const { post } = await registry.posts.recordPost({ launchId: launch.id, channel: 'mastodon', accountId: account.id, url: 'https://m/1', externalId: '1' });
  await registry.deleteAccount(account.id);
  assert.equal((await registry.posts.post(post.id))?.accountId, null);
});

test('settings hold what the owner chose, typed as it was stored', async () => {
  const registry = await memory();
  assert.equal(await registry.setting<string>('automation:mode'), undefined);
  await registry.setSetting('automation:mode', 'webhook');
  await registry.setSetting('automation:interval', 120);
  await registry.setSetting('automation:interval', 600);
  assert.equal(await registry.setting<string>('automation:mode'), 'webhook');
  assert.equal(await registry.setting<number>('automation:interval'), 600);
  await registry.setSetting('nested', { a: [1, 2], b: null });
  assert.deepEqual(await registry.setting('nested'), { a: [1, 2], b: null });
  assert.equal(await registry.cursor('automation:mode'), undefined, 'not a cursor');
});

test('setStatus on an unknown launch throws instead of silently doing nothing', async () => {
  await assert.rejects((await memory()).launches.setStatus(999, 'published'), /no launch with id 999/);
});

test('cursors keep polling state across restarts, and the schema survives reopening', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-registry-'));
  try {
    const first = await Registry.memory(dir);
    await first.setCursor('events:yeyo11', 'W/"etag-1"');
    await first.launches.claim(release);
    await first.close();

    // Reopening runs the migrations again: already applied, they change nothing
    const reopened = await Registry.memory(dir);
    assert.equal(await reopened.cursor('events:yeyo11'), 'W/"etag-1"');
    assert.equal((await reopened.launches.find('yeyo11/claudio', 'v0.9.0'))?.status, 'detected');
    await reopened.setCursor('events:yeyo11', 'W/"etag-2"');
    assert.equal(await reopened.cursor('events:yeyo11'), 'W/"etag-2"');
    await reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a channel that failed for good can be retried, without posting the others again', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  await registry.launches.setStatus(launch.id, 'published', 'https://github.com/yeyo11/launches/pull/1');
  await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '1' });
  await registry.setCursor(`publish-failed:${launch.id}:newsletter`, 'Brevo: 405');
  await registry.setCursor(`publish-failed:${launch.id}:devto`, 'stale');

  const reopened = await retryChannelEverywhere(registry, 'newsletter');
  assert.deepEqual(reopened.map((l) => l.status), ['drafted']);
  assert.equal(reopened[0]!.detail, 'https://github.com/yeyo11/launches/pull/1', 'the pull request stays recorded');
  assert.equal(await registry.cursor(`publish-failed:${launch.id}:newsletter`), undefined);
  assert.equal(await registry.cursor(`publish-failed:${launch.id}:devto`), 'stale', 'other channels untouched');
  assert.deepEqual(await retryChannelEverywhere(registry, 'newsletter'), [], 'nothing left to retry');
});

test('a retry leaves alone a launch whose channel already has its post', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  await registry.launches.setStatus(launch.id, 'published');
  await registry.posts.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '1' });
  await registry.setCursor(`publish-failed:${launch.id}:devto`, 'stale');
  assert.deepEqual(await retryChannelEverywhere(registry, 'devto'), []);
  assert.equal((await registry.launches.get(launch.id))?.status, 'published');
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
  const { launch } = await registry.launches.claim(release);
  await registry.metrics.recordMetrics(launch.id, 'devto', { views: 10, likes: 1, broken: Number.NaN }, new Date('2026-10-01T00:00:00Z'));
  await registry.metrics.recordMetrics(launch.id, 'devto', { views: 25.5 }, new Date('2026-10-02T00:00:00Z'));
  assert.deepEqual(
    (await registry.metrics.latestMetrics(launch.id)).map((m) => [m.name, m.value]),
    [
      ['likes', 1],
      ['views', 25.5],
    ],
  );
  assert.deepEqual((await registry.metrics.metricHistory(launch.id, 'devto', 'views')).map((m) => m.value), [10, 25.5]);
});

test('a job row keeps its first record, a bounded log, and is forgotten once old', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  const job = await registry.recordJob({ id: 'a', queue: 'publish', title: 'Publishing claudio v0.9.0', launchId: launch.id });
  assert.equal(job.state, 'created');
  assert.equal((await registry.recordJob({ id: 'a', queue: 'publish', title: 'another' })).title, 'Publishing claudio v0.9.0');
  for (let i = 0; i < JOB_LOG_LINES + 5; i++) await registry.logJob('a', `line ${i}`);
  const logged = await registry.job('a');
  assert.equal(logged?.log.length, JOB_LOG_LINES);
  assert.equal(logged?.log[0], 'line 5', 'the oldest lines go first');
  assert.equal(logged?.log.at(-1), `line ${JOB_LOG_LINES + 4}`);

  await registry.updateJob('a', { state: 'active', attempts: 1, started: true });
  const started = (await registry.job('a'))?.startedAt;
  assert.ok(started);
  await registry.updateJob('a', { state: 'retry', started: true });
  assert.equal((await registry.job('a'))?.startedAt, started, 'a later attempt keeps the first start');
  await registry.updateJob('a', { state: 'completed', ended: true, link: '/launches/1' });
  assert.deepEqual((await registry.jobs({ launchId: launch.id })).map((j) => [j.id, j.state, j.link]), [['a', 'completed', '/launches/1']]);
  assert.deepEqual(await registry.jobs({ states: ['active', 'retry'] }), []);
  assert.equal(await registry.pruneJobs('2000-01-01T00:00:00.000Z'), 0);
  assert.equal(await registry.pruneJobs('2999-01-01T00:00:00.000Z'), 1);
});

test('a launch’s sent replies are counted per channel: only others’ comments answered, never another launch’s', async () => {
  const registry = await memory();
  const { launch } = await registry.launches.claim(release);
  const { launch: other } = await registry.launches.claim({ ...release, ref: 'v1.0.0' });
  const { post: mastodon } = await registry.posts.recordPost({ launchId: launch.id, channel: 'mastodon', url: 'https://m/1', externalId: '1' });
  const { post: bluesky } = await registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', url: 'https://b/1', externalId: 'b1' });
  const { post: elsewhere } = await registry.posts.recordPost({ launchId: other.id, channel: 'mastodon', url: 'https://m/2', externalId: '2' });
  const comment = (postId: number, channel: 'mastodon' | 'bluesky', externalId: string, status: 'sent' | 'new', own = false) =>
    registry.recordComment({ postId, channel, externalId, author: { handle: '@ana' }, text: 'hi', createdAt: '2026-10-25T10:00:00.000Z', own, status });
  await comment(mastodon.id, 'mastodon', 'c1', 'sent');
  await comment(mastodon.id, 'mastodon', 'c2', 'sent');
  await comment(mastodon.id, 'mastodon', 'c3', 'new');
  await comment(mastodon.id, 'mastodon', 'c4', 'sent', true);
  await comment(bluesky.id, 'bluesky', 'c5', 'sent');
  await comment(elsewhere.id, 'mastodon', 'c6', 'sent');
  assert.deepEqual(await registry.sentReplies(launch.id), { mastodon: 2, bluesky: 1 });
  assert.deepEqual(await registry.sentReplies(9999), {});
});
