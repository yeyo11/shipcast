import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError } from '@shipcast/connectors';
import { contentHash, deleteLaunchPosts, editPost, editPosts, PostRefused } from '../src/index.ts';
import { aPublishedLaunch, FakeConnectors, memoryRegistry, withScheduled } from '../src/testing/index.ts';

/*
 * Characterisation: editing and deleting as they behave today, pinned before PostService takes
 * them over (docs/plans/performance-refactor.md, phase 3). What the existing edit tests leave out:
 * editing twice, a network failing mid-edit, and a launch-wide operation over pieces in every state.
 */

test('a piece can be edited again: it stays edited and its hash follows the last change', async () => {
  const registry = await memoryRegistry();
  const { posts } = await aPublishedLaunch(registry, [{ channel: 'telegram', externalId: '@c:1' }]);
  const fake = new FakeConnectors();
  const deps = { registry, editors: fake.editors() };
  const first = await editPost(posts[0]!.id, { text: 'One' }, deps);
  const second = await editPost(posts[0]!.id, { text: 'Two', link: 'https://josegarrido.dev/en/x/' }, deps);
  assert.deepEqual([first.status, second.status], ['edited', 'edited']);
  assert.equal(second.contentHash, contentHash({ text: 'Two', link: 'https://josegarrido.dev/en/x/' }));
  assert.deepEqual(fake.callsOf('telegram').map((c) => c.input), [{ text: 'One' }, { text: 'Two\n\nhttps://josegarrido.dev/en/x/' }]);
});

test('a network failing mid-edit throws its own error, not a refusal, and the row is left as it was', async () => {
  const registry = await memoryRegistry();
  const { posts } = await aPublishedLaunch(registry, [{ channel: 'mastodon', externalId: 'm1' }]);
  const fake = new FakeConnectors().fail('mastodon', 'edit', new ConnectorError('Mastodon', 'edit: 500', 500));
  await assert.rejects(editPost(posts[0]!.id, { text: 'x' }, { registry, editors: fake.editors() }), (e) => e instanceof ConnectorError && !(e instanceof PostRefused) && e.message === 'Mastodon: edit: 500');
  const row = await registry.posts.post(posts[0]!.id);
  assert.deepEqual([row?.status, row?.contentHash], ['live', null]);
});

test('a launch-wide edit and delete over pieces in every state: what is tried, what is reported, what is left out', async () => {
  const registry = await memoryRegistry();
  const { launch, posts } = await aPublishedLaunch(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'discord', externalId: 'd1' },
    { channel: 'devto', externalId: '42', status: 'edited' },
    { channel: 'instagram', kind: 'story', externalId: 'st1' },
    { channel: 'newsletter', kind: 'issue:en', externalId: '900' },
    { channel: 'hashnode', externalId: 'h1', status: 'deleted' },
    { channel: 'telegram', externalId: null },
  ]);
  await withScheduled(registry, launch.id, { bluesky: new Date('2099-01-01T00:00:00Z') });
  const fake = new FakeConnectors().fail('discord', 'edit', new ConnectorError('Discord', 'edit: 503', 503));
  fake.unconnected.add('mastodon');
  const deps = { registry, editors: fake.editors() };

  const edited = await editPosts(launch.id, { text: 'New' }, undefined, deps);
  assert.deepEqual(
    edited.map((o) => `${o.channel} ${o.kind} ${o.ok ? o.post.status : o.reason}`).sort(),
    ['devto post edited', 'discord post failed', 'instagram story unsupported', 'mastodon post no_credentials', 'newsletter issue:en unsupported', 'telegram post unsupported'],
    'the deleted Hashnode piece and the scheduled Bluesky one are not in the list at all',
  );
  const discord = edited.find((o) => o.channel === 'discord');
  assert.equal(discord && !discord.ok && discord.problem, 'Discord: edit: 503');
  assert.equal(edited.find((o) => o.channel === 'telegram' && !o.ok && /has no id on Telegram/.test(o.problem)) !== undefined, true);

  const deleted = await deleteLaunchPosts(launch.id, undefined, deps);
  assert.deepEqual(
    deleted.map((o) => `${o.channel} ${o.ok ? o.post.status : o.reason}`).sort(),
    ['devto deleted', 'discord deleted', 'instagram unsupported', 'mastodon no_credentials', 'newsletter unsupported', 'telegram unsupported'],
  );
  assert.deepEqual(fake.log.filter((l) => l.includes(' delete ')).sort(), ['devto delete 42', 'discord delete d1']);
  assert.equal(posts[0] && (await registry.posts.post(posts[0].id))?.status, 'live', 'a piece with no credentials is left live');
});
