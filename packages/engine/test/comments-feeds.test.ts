import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Comment } from '@shipcast/connectors';
import type { Channel } from '@shipcast/schema';
import { fetchCommentsByFeed, type CommentDeps, type CommentFeed } from '../src/index.ts';
import { aPublishedLaunch, FakeConnectors, memoryRegistry } from '../src/testing/index.ts';

/*
 * Phase 8's comment runs (the `batched-metrics` flag): one feed call per account says which posts
 * moved, only those are read, a network with no feed (Threads) is read post by post, and every post
 * is read whole once a day.
 */

const comment = (externalId: string, text: string): Comment => ({ externalId, author: { handle: '@ana' }, text, createdAt: '2026-11-03T09:00:00.000Z', own: false });

test('comments read with one call per account: the feed first, then only the posts it names', async () => {
  const registry = await memoryRegistry();
  // Three launches with a post on each network; the Mastodon ones from two accounts
  const mine = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@me', settings: {} });
  const other = await registry.accounts.addAccount({ network: 'mastodon', brand: 'personal', label: '@other', settings: {} });
  for (const n of [1, 2, 3]) {
    await aPublishedLaunch(
      registry,
      [
        { channel: 'mastodon', externalId: `m${n}`, accountId: n === 3 ? other.id : mine.id },
        { channel: 'bluesky', externalId: `b${n}` },
        { channel: 'devto', externalId: `d${n}` },
        { channel: 'threads', externalId: `t${n}` },
      ],
      { ref: `v${n}.0.0` },
    );
  }
  const fake = new FakeConnectors();
  fake.threads = { 'mastodon:m2': [comment('201', 'Does it run on Windows?')] };
  const feedCalls: string[] = [];
  const touch = new Map<string, string[]>();
  const feed = (channel: Channel, accountId: number | null): CommentFeed => ({
    async changes(posts, cursor) {
      feedCalls.push(`${channel}:${accountId ?? 'env'}`);
      const touched = cursor === undefined ? posts.map((p) => p.externalId) : (touch.get(channel) ?? []).filter((id) => posts.some((p) => p.externalId === id));
      return { cursor: `${Number(cursor ?? 0) + 1}`, touched: new Set(touched) };
    },
  });
  const readers = fake.commentConnectors();
  let clock = new Date();
  const deps: CommentDeps = {
    registry,
    connectors: async (channel, accountId) => ({ ...(await readers(channel, accountId)), ...(channel !== 'threads' && { feed: feed(channel, accountId) }) }),
    now: () => clock,
  };

  // The first run has no cursor: every post is read, and each account's cursor set
  const first = await fetchCommentsByFeed(deps, registry.cursors);
  assert.equal(first.posts, 12);
  assert.deepEqual(feedCalls.sort(), ['bluesky:env', 'devto:env', `mastodon:${mine.id}`, `mastodon:${other.id}`].sort());
  assert.equal(first.added.length, 1);

  // Half an hour later the first Mastodon account's feed names m2; nothing else moved
  feedCalls.length = 0;
  fake.calls.length = 0;
  touch.set('mastodon', ['m2']);
  fake.threads['mastodon:m2'] = [comment('201', 'Does it run on Windows?'), comment('202', 'And on BSD?')];
  clock = new Date(clock.getTime() + 30 * 60_000);
  const second = await fetchCommentsByFeed(deps, registry.cursors);
  assert.deepEqual(feedCalls.sort(), ['bluesky:env', 'devto:env', `mastodon:${mine.id}`, `mastodon:${other.id}`].sort(), 'one feed call per account');
  assert.deepEqual(fake.log.sort(), ['mastodon comments m2', 'threads comments t1', 'threads comments t2', 'threads comments t3'], 'only the post named, and Threads post by post');
  assert.deepEqual(second.added.map((c) => c.externalId), ['202']);
  assert.equal(await registry.cursors.cursor(`comments-feed:mastodon:${mine.id}`), '2');

  // A day later every post is read whole once, the owner's replies by hand included
  fake.calls.length = 0;
  touch.clear();
  clock = new Date(clock.getTime() + 24 * 3_600_000);
  const sweep = await fetchCommentsByFeed(deps, registry.cursors);
  assert.equal(sweep.posts, 12);
  assert.equal(fake.calls.length, 12);
});

test('a feed that fails keeps its cursor and reads none of its posts; the other accounts go on', async () => {
  const registry = await memoryRegistry();
  await aPublishedLaunch(registry, [
    { channel: 'mastodon', externalId: 'm1' },
    { channel: 'bluesky', externalId: 'b1' },
  ]);
  await registry.cursors.setCursor('comments-feed:mastodon:env', '9');
  await registry.cursors.setCursor('comments-sweep:mastodon:env', new Date().toISOString());
  await registry.cursors.setCursor('comments-sweep:bluesky:env', new Date().toISOString());
  const fake = new FakeConnectors();
  const readers = fake.commentConnectors();
  const deps: CommentDeps = {
    registry,
    connectors: async (channel, accountId) => ({
      ...(await readers(channel, accountId)),
      feed: {
        changes: async (posts) => {
          if (channel === 'mastodon') throw new Error('Mastodon: 503');
          return { cursor: 'next', touched: new Set(posts.map((p) => p.externalId)) };
        },
      },
    }),
  };
  const result = await fetchCommentsByFeed(deps, registry.cursors);
  assert.deepEqual(result.problems, ['Mastodon feed: Mastodon: 503']);
  assert.deepEqual(fake.log, ['bluesky comments b1']);
  assert.equal(await registry.cursors.cursor('comments-feed:mastodon:env'), '9');
});

test('a feed that fails while the daily sweep is due still lets the sweep read every post whole', async () => {
  const registry = await memoryRegistry();
  await aPublishedLaunch(registry, [{ channel: 'mastodon', externalId: 'm1' }]);
  await registry.cursors.setCursor('comments-feed:mastodon:env', '9');
  // The last sweep was a day ago: this run reads every post, whatever the feed says
  await registry.cursors.setCursor('comments-sweep:mastodon:env', new Date(Date.now() - 25 * 3_600_000).toISOString());
  const fake = new FakeConnectors();
  const readers = fake.commentConnectors();
  const deps: CommentDeps = {
    registry,
    connectors: async (channel, accountId) => ({
      ...(await readers(channel, accountId)),
      feed: {
        changes: async () => {
          throw new Error('Mastodon: the token was not granted read:notifications');
        },
      },
    }),
  };
  const result = await fetchCommentsByFeed(deps, registry.cursors);
  assert.deepEqual(result.problems, ['Mastodon feed: Mastodon: the token was not granted read:notifications']);
  assert.deepEqual(fake.log, ['mastodon comments m1'], 'the sweep read the post');
  assert.equal(await registry.cursors.cursor('comments-feed:mastodon:env'), '9', 'the feed keeps its cursor');
  assert.ok(Date.parse((await registry.cursors.cursor('comments-sweep:mastodon:env'))!) > Date.now() - 60_000, 'the sweep is recorded');
});
