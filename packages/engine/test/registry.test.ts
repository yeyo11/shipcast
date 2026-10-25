import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Registry, type NewLaunch } from '../src/index.ts';

const release: NewLaunch = { repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'major', brand: 'personal' };

function memory(): Registry {
  return new Registry(':memory:');
}

test('a release is claimed once: the second claim gets the existing launch back', () => {
  const registry = memory();
  const first = registry.claim(release);
  assert.equal(first.claimed, true);
  assert.equal(first.launch.status, 'detected');

  const again = registry.claim({ ...release, trigger: 'manual', kind: 'minor' });
  assert.equal(again.claimed, false);
  assert.equal(again.launch.id, first.launch.id);
  assert.equal(again.launch.kind, 'major', 'the first claim is the one that counts');
});

test('a skipped release stays recorded, so the next poll does not pick it up again', () => {
  const registry = memory();
  const { launch } = registry.claim(release);
  registry.setStatus(launch.id, 'skipped', 'launch.yml has enabled: false');
  const again = registry.claim(release);
  assert.equal(again.claimed, false);
  assert.equal(again.launch.status, 'skipped');
  assert.equal(again.launch.detail, 'launch.yml has enabled: false');
});

test('the last published ref feeds the pack inference; drafts and failures do not count', () => {
  const registry = memory();
  assert.equal(registry.lastPublishedRef('yeyo11/claudio'), undefined);

  const a = registry.claim({ ...release, ref: 'v0.8.0' }).launch;
  registry.setStatus(a.id, 'published');
  const b = registry.claim({ ...release, ref: 'v0.8.1' }).launch;
  registry.setStatus(b.id, 'failed', 'dev.to answered 500');

  assert.equal(registry.lastPublishedRef('yeyo11/claudio'), 'v0.8.0');
  assert.equal(registry.lastPublishedRef('yeyo11/other'), undefined);
});

test('a piece is published once per channel', () => {
  const registry = memory();
  const { launch } = registry.claim(release);
  assert.deepEqual(registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '1' }), {
    recorded: true,
  });
  assert.deepEqual(registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/y', externalId: '2' }), {
    recorded: false,
  });
  const posts = registry.posts(launch.id);
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.url, 'https://dev.to/x');
});

test('setStatus on an unknown launch throws instead of silently doing nothing', () => {
  assert.throws(() => memory().setStatus(999, 'published'), /no launch with id 999/);
});

test('cursors keep polling state across restarts, and the schema survives reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shipcast-registry-'));
  try {
    const path = join(dir, 'shipcast.db');
    const first = new Registry(path);
    first.setCursor('events:yeyo11', 'W/"etag-1"');
    first.claim(release);
    first.close();

    const reopened = new Registry(path);
    assert.equal(reopened.cursor('events:yeyo11'), 'W/"etag-1"');
    assert.equal(reopened.find('yeyo11/claudio', 'v0.9.0')?.status, 'detected');
    reopened.setCursor('events:yeyo11', 'W/"etag-2"');
    assert.equal(reopened.cursor('events:yeyo11'), 'W/"etag-2"');
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a channel that failed for good can be retried, without posting the others again', () => {
  const registry = new Registry(':memory:');
  const { launch } = registry.claim({ repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'manual', kind: 'launch', brand: 'personal' });
  registry.setStatus(launch.id, 'published', 'https://github.com/yeyo11/launches/pull/1');
  registry.recordPost({ launchId: launch.id, channel: 'devto', url: 'https://dev.to/x', externalId: '1' });
  registry.setCursor(`publish-failed:${launch.id}:newsletter`, 'Brevo: 405');
  registry.setCursor(`publish-failed:${launch.id}:devto`, 'stale');

  const reopened = registry.retryChannel('newsletter');
  assert.deepEqual(reopened.map((l) => l.status), ['drafted']);
  assert.equal(reopened[0]!.detail, 'https://github.com/yeyo11/launches/pull/1', 'the pull request stays recorded');
  assert.equal(registry.cursor(`publish-failed:${launch.id}:newsletter`), undefined);
  assert.equal(registry.cursor(`publish-failed:${launch.id}:devto`), 'stale', 'other channels untouched');
  assert.deepEqual(registry.retryChannel('newsletter'), [], 'nothing left to retry');
});

test('accounts: the first per network and brand is the primary, and another can take over', () => {
  const registry = new Registry(':memory:');
  const a = registry.addAccount({ network: 'mastodon', brand: 'personal', label: 'main', settings: { instance: 'https://mastodon.social' } });
  const b = registry.addAccount({ network: 'mastodon', brand: 'personal', label: 'second', settings: {} });
  const c = registry.addAccount({ network: 'mastodon', brand: 'company', label: 'main', settings: {} });
  assert.equal(a.primary, true);
  assert.equal(b.primary, false);
  assert.equal(c.primary, true, 'brands never share a primary');
  assert.equal(registry.primaryAccount('personal', 'mastodon')?.id, a.id);

  registry.makePrimary(b.id);
  assert.equal(registry.primaryAccount('personal', 'mastodon')?.id, b.id);
  assert.equal(registry.account(a.id)?.primary, false);

  registry.deleteAccount(b.id);
  assert.equal(registry.primaryAccount('personal', 'mastodon')?.id, a.id, 'the next one takes over');
  assert.deepEqual(registry.accounts({ brand: 'company' }).map((x) => x.id), [c.id]);

  const checked = registry.recordCheck(a.id, { ok: false, problem: 'rejected' }, new Date('2026-10-25T00:00:00Z'));
  assert.deepEqual([checked.status, checked.problem, checked.checkedAt], ['failed', 'rejected', '2026-10-25T00:00:00.000Z']);
  assert.equal(registry.updateAccount(a.id, { label: 'renamed' }).label, 'renamed');
  assert.deepEqual(registry.account(a.id)?.settings, { instance: 'https://mastodon.social' });
});
