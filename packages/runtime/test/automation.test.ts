import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import {
  accountSecretKey,
  lastHappened,
  launchOfPullRequest,
  MemoryStore,
  newWebhookSecret,
  readAutomation,
  record,
  refreshInstagramAccounts,
  verifySignature,
  webhookAction,
  writeAutomation,
} from '../src/index.ts';

test('a delivery is trusted only with the HMAC of its exact body', () => {
  const secret = newWebhookSecret();
  assert.equal(secret.length, 64);
  const body = '{"zen":"Keep it logically awesome."}';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.ok(verifySignature(secret, body, signature));
  assert.equal(verifySignature(secret, `${body} `, signature), false, 'a changed body');
  assert.equal(verifySignature('another', body, signature), false, 'another secret');
  assert.equal(verifySignature(secret, body, null), false, 'no signature');
  assert.equal(verifySignature(secret, body, 'sha1=abc'), false, 'the old SHA-1 header');
});

test('deliveries become actions: claim a release, publish a merge, ignore the rest', () => {
  assert.deepEqual(webhookAction('ping', { zen: 'x' }, 'yeyo11/launches'), { kind: 'ping' });
  const release = webhookAction(
    'release',
    { action: 'published', repository: { full_name: 'yeyo11/claudio' }, release: { id: 7, tag_name: 'v1.0.0', prerelease: false, html_url: 'u', published_at: '2026-10-25T00:00:00Z' } },
    'yeyo11/launches',
  );
  assert.equal(release.kind, 'claim');
  assert.deepEqual(release.kind === 'claim' && release.event, { type: 'release', id: 'webhook-7', repo: 'yeyo11/claudio', tag: 'v1.0.0', prerelease: false, url: 'u', at: '2026-10-25T00:00:00Z' });
  assert.equal(webhookAction('release', { action: 'created', repository: { full_name: 'a/b' }, release: { tag_name: 'v1' } }, 'yeyo11/launches').kind, 'ignore');
  assert.equal(webhookAction('release', { action: 'published', repository: { full_name: 'a/b' }, release: { tag_name: 'v1', draft: true } }, 'yeyo11/launches').kind, 'ignore');

  const merged = { action: 'closed', repository: { full_name: 'yeyo11/launches' }, pull_request: { merged: true, html_url: 'https://github.com/yeyo11/launches/pull/9' } };
  assert.deepEqual(webhookAction('pull_request', merged, 'yeyo11/launches'), { kind: 'publish', pullRequestUrl: 'https://github.com/yeyo11/launches/pull/9' });
  assert.equal(webhookAction('pull_request', { ...merged, pull_request: { merged: false, html_url: 'x' } }, 'yeyo11/launches').kind, 'ignore', 'closed unmerged');
  assert.equal(webhookAction('pull_request', { ...merged, repository: { full_name: 'yeyo11/claudio' } }, 'yeyo11/launches').kind, 'ignore', 'another repo');
  assert.equal(webhookAction('repository', { action: 'publicized', repository: { full_name: 'a/b' } }, 'yeyo11/launches').kind, 'claim');
  assert.equal(webhookAction('star', {}, 'yeyo11/launches').kind, 'ignore');
});

test('a merged pull request finds its drafted launch', async () => {
  const registry = await memoryRegistry();
  const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v1', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/9');
  assert.equal((await launchOfPullRequest({ registry }, 'https://github.com/yeyo11/launches/pull/9'))?.id, launch.id);
  assert.equal(await launchOfPullRequest({ registry }, 'https://github.com/yeyo11/launches/pull/10'), undefined);
});

test('automation settings default to polling every five minutes and never under a minute', async () => {
  const registry = await memoryRegistry();
  assert.deepEqual(await readAutomation(registry), { mode: 'poll', intervalSeconds: 300 });
  assert.deepEqual(await writeAutomation(registry, { mode: 'webhook', intervalSeconds: 10 }), { mode: 'webhook', intervalSeconds: 60 });
  await record(registry, 'automation:last-round', { at: 'now', summary: 's', lines: Array.from({ length: 30 }, (_, i) => String(i)) });
  assert.equal((await lastHappened(registry, 'automation:last-round'))?.lines.length, 20);
});

test('every Instagram account refreshes its own token when it is 30 days old', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const fresh = await registry.addAccount({ network: 'instagram', brand: 'personal', label: 'new', settings: { userId: '1' } });
  const old = await registry.addAccount({ network: 'instagram', brand: 'personal', label: 'old', settings: { userId: '2', refreshedAt: '2026-09-01T00:00:00.000Z' } });
  await secrets.set(accountSecretKey(old.id), JSON.stringify({ accessToken: 'old-token' }), 'x');
  const http = (async () => Response.json({ access_token: 'new-token', expires_in: 5_184_000 })) as typeof fetch;

  const lines = await refreshInstagramAccounts({ registry, secrets }, new Date('2026-10-25T00:00:00Z'), http);
  assert.deepEqual(lines, ['Instagram token of old refreshed; valid for 60 more days']);
  assert.equal(JSON.parse((await secrets.get(accountSecretKey(old.id)))!).accessToken, 'new-token');
  assert.equal((await registry.account(old.id))?.settings.refreshedAt, '2026-10-25T00:00:00.000Z');
  assert.equal((await registry.account(fresh.id))?.settings.refreshedAt, '2026-10-25T00:00:00.000Z', 'a first sight only records the date');
});
