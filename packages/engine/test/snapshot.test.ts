import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSnapshot, latestMigration, openSnapshot, parseSnapshot, SnapshotError, type NewLaunch } from '../src/index.ts';

const release: NewLaunch = { repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'major', brand: 'personal' };

test('a snapshot round trip keeps every row, the ids and the once-only claim', async () => {
  const first = await openSnapshot(undefined);
  const { launch } = await first.registry.launches.claim(release);
  await first.registry.launches.setStatus(launch.id, 'drafted', 'https://github.com/yeyo11/launches/pull/7');
  await first.registry.posts.recordPost({ launchId: launch.id, channel: 'bluesky', externalId: 'at://x', url: 'https://bsky.app/x' });
  const account = await first.registry.accounts.addAccount({ network: 'devto', brand: 'personal', label: '@yeyo', settings: { a: 'b' } });
  await first.registry.cursors.setCursor('events-last-id:yeyo11', '123');
  await first.registry.cursors.setCursor('instagram-token', 'secret-token');
  await first.registry.settings.setSetting('ai', { tasks: {}, tone: 'plain' });
  await first.registry.addApiToken({ name: 'cli', hash: 'abc', scopes: ['read'] });
  const text = formatSnapshot(await first.dump());
  await first.close();

  assert.ok(!text.includes('secret-token'), 'a refreshed Instagram token never reaches the state');
  assert.ok(!text.includes('"api_tokens"'), 'API tokens are not part of the state');
  const snapshot = parseSnapshot(text);
  assert.equal(snapshot.migration, latestMigration());
  // Parents first: the posts point at the launches and the accounts
  const order = Object.keys(snapshot.tables);
  assert.ok(order.indexOf('launches') < order.indexOf('posts'));
  assert.ok(order.indexOf('accounts') < order.indexOf('posts'));

  const second = await openSnapshot(snapshot);
  const restored = await second.registry.launches.get(launch.id);
  assert.equal(restored?.status, 'drafted');
  assert.equal(restored?.detail, 'https://github.com/yeyo11/launches/pull/7');
  assert.equal((await second.registry.posts.posts(launch.id)).length, 1);
  assert.equal((await second.registry.accounts.account(account.id))?.label, '@yeyo');
  assert.equal(await second.registry.cursors.cursor('events-last-id:yeyo11'), '123');
  assert.equal(await second.registry.cursors.cursor('instagram-token'), undefined);
  assert.deepEqual(await second.registry.settings.setting('ai'), { tasks: {}, tone: 'plain' });

  // The same release again is refused; a new one takes the next id, after the restored ones
  assert.equal((await second.registry.launches.claim({ ...release, trigger: 'manual' })).claimed, false);
  const next = await second.registry.launches.claim({ ...release, ref: 'v1.0.0' });
  assert.equal(next.claimed, true);
  assert.ok(next.launch.id > launch.id);

  // Saving again gives the same text for the same rows, so an idle run changes nothing in the branch
  const again = formatSnapshot(await second.dump());
  await second.close();
  const third = await openSnapshot(parseSnapshot(again));
  assert.equal(formatSnapshot(await third.dump()), again);
  await third.close();
});

test('a snapshot from a newer Shipcast, or not a snapshot at all, is refused', async () => {
  await assert.rejects(openSnapshot({ format: 1, migration: '9999_future', tables: {} }), SnapshotError);
  assert.throws(() => parseSnapshot('not json'), SnapshotError);
  assert.throws(() => parseSnapshot('{"format":1}'), SnapshotError);
});
