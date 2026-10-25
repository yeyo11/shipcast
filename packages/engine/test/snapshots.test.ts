import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryRegistry as memory } from '../src/testing.ts';

const account = { network: 'mastodon', brand: 'personal', label: '@me@mastodon.social', settings: {} };

test('an account keeps one snapshot a day, the latest reading of that day', async () => {
  const registry = await memory();
  const a = await registry.addAccount(account);
  await registry.recordSnapshot(a.id, { followers: 10, following: 5, posts: 1 }, new Date('2026-10-24T04:00:00Z'));
  await registry.recordSnapshot(a.id, { followers: 11, following: 5, posts: 2 }, new Date('2026-10-25T04:00:00Z'));
  const later = await registry.recordSnapshot(a.id, { followers: 13, posts: 2, extra: { members: 4 } }, new Date('2026-10-25T16:30:00Z'));
  assert.deepEqual(later, { accountId: a.id, day: '2026-10-25', takenAt: '2026-10-25T16:30:00.000Z', followers: 13, following: null, posts: 2, extra: { members: 4 } });

  // A reading that arrives late, from earlier the same day, does not replace the newer one
  const late = await registry.recordSnapshot(a.id, { followers: 12 }, new Date('2026-10-25T10:00:00Z'));
  assert.equal(late.followers, 13);

  const history = await registry.accountSnapshots(a.id);
  assert.deepEqual(history.map((s) => [s.day, s.followers]), [['2026-10-24', 10], ['2026-10-25', 13]]);
  assert.deepEqual((await registry.accountSnapshots(a.id, { since: '2026-10-25' })).map((s) => s.day), ['2026-10-25']);
  assert.equal((await registry.lastSnapshot(a.id))?.followers, 13);
});

test('the last snapshot of every account comes back by account; an account removed takes its history with it', async () => {
  const registry = await memory();
  const a = await registry.addAccount(account);
  const b = await registry.addAccount({ ...account, network: 'github', label: '@me' });
  const c = await registry.addAccount({ ...account, network: 'brevo', label: 'me@x.dev' });
  await registry.recordSnapshot(a.id, { followers: 1 }, new Date('2026-10-24T04:00:00Z'));
  await registry.recordSnapshot(a.id, { followers: 2 }, new Date('2026-10-25T04:00:00Z'));
  await registry.recordSnapshot(b.id, { followers: 9 }, new Date('2026-10-25T04:00:00Z'));
  const last = await registry.lastSnapshots();
  assert.equal(last.get(a.id)?.followers, 2);
  assert.equal(last.get(b.id)?.followers, 9);
  assert.equal(last.has(c.id), false);
  assert.equal(await registry.lastSnapshot(c.id), undefined);

  await registry.deleteAccount(a.id);
  assert.deepEqual(await registry.accountSnapshots(a.id), []);
});

test('a check keeps the picture it found, and one without a picture, or a failed one, leaves the last in place', async () => {
  const registry = await memory();
  const a = await registry.addAccount(account);
  assert.equal(a.avatarUrl, null);
  assert.equal((await registry.recordCheck(a.id, { ok: true, account: '@me', avatarUrl: 'https://cdn.example/1.png' })).avatarUrl, 'https://cdn.example/1.png');
  assert.equal((await registry.recordCheck(a.id, { ok: true, account: '@me' })).avatarUrl, 'https://cdn.example/1.png');
  assert.equal((await registry.recordCheck(a.id, { ok: false, problem: 'rejected' })).avatarUrl, 'https://cdn.example/1.png');
  assert.equal((await registry.recordCheck(a.id, { ok: true, account: '@me', avatarUrl: 'https://cdn.example/2.png' })).avatarUrl, 'https://cdn.example/2.png');
});
