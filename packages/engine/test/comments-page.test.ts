import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Channel } from '@shipcast/schema';
import type { CommentStatus, Registry } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

/** Two launches, a post each on two channels, and `n` comments spread over them with every status */
async function seeded() {
  const registry = await memoryRegistry();
  const make = async (ref: string, channels: Channel[]) => {
    const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref, trigger: 'release', kind: 'major', brand: 'personal' });
    const made = [];
    for (const channel of channels) made.push((await registry.recordPost({ launchId: launch.id, channel, externalId: `${ref}-${channel}`, url: `https://example.com/${ref}/${channel}` })).post);
    return { launch, posts: made };
  };
  const a = await make('v1.0.0', ['mastodon', 'bluesky']);
  const b = await make('v2.0.0', ['mastodon']);
  return { registry, a, b };
}

async function add(registry: Registry, postId: number, channel: Channel, n: number, status: CommentStatus, text: string, handle = '@someone') {
  const { comment } = await registry.recordComment({
    postId,
    channel,
    externalId: `${channel}-${postId}-${n}`,
    author: { handle, displayName: 'Someone' },
    text,
    createdAt: `2026-10-${String(10 + (n % 15)).padStart(2, '0')}T10:00:00.000Z`,
    own: false,
  });
  await registry.updateComment(comment.id, { status });
}

test('the page is cut by the database and the total counts every match', async () => {
  const { registry, a } = await seeded();
  for (let i = 0; i < 30; i++) await add(registry, a.posts[0]!.id, 'mastodon', i, 'new', `comment ${i}`);
  const first = await registry.commentsPage({ pageSize: 10 });
  assert.equal(first.total, 30);
  assert.equal(first.pages, 3);
  assert.equal(first.comments.length, 10);
  const last = await registry.commentsPage({ pageSize: 10, page: 3 });
  assert.equal(last.comments.length, 10);
  const ids = new Set([...first.comments, ...(await registry.commentsPage({ pageSize: 10, page: 2 })).comments, ...last.comments].map((c) => c.id));
  assert.equal(ids.size, 30, 'no comment on two pages, none missed');
  const dates = first.comments.map((c) => c.createdAt);
  assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
  assert.equal((await registry.commentsPage({ pageSize: 10, page: 99 })).page, 3, 'a page past the end shows the last');
});

test('the filters narrow by state, channel, launch, post and text, together', async () => {
  const { registry, a, b } = await seeded();
  const [m1, bs1] = [a.posts[0]!.id, a.posts[1]!.id];
  await add(registry, m1, 'mastodon', 1, 'new', 'How do I install it?');
  await add(registry, m1, 'mastodon', 2, 'draft-ready', 'Does it run on Windows?', '@win');
  await add(registry, m1, 'mastodon', 3, 'sent', 'Great work');
  await add(registry, bs1, 'bluesky', 4, 'dismissed', 'spam spam');
  await add(registry, b.posts[0]!.id, 'mastodon', 5, 'failed', '100% broken_link');

  const total = async (f: Parameters<Registry['commentsPage']>[0]) => (await registry.commentsPage(f)).total;
  assert.equal(await total({}), 5);
  assert.equal(await total({ bucket: 'waiting' }), 3, 'new, drafted and failed wait for a reply');
  assert.equal(await total({ bucket: 'replied' }), 1);
  assert.equal(await total({ bucket: 'ignored' }), 1);
  assert.equal(await total({ channel: 'bluesky' }), 1);
  assert.equal(await total({ launchId: a.launch.id }), 4);
  assert.equal(await total({ launchId: b.launch.id }), 1);
  assert.equal(await total({ postId: m1 }), 3);
  assert.equal(await total({ launchId: a.launch.id, channel: 'mastodon', bucket: 'waiting' }), 2);
  assert.equal(await total({ search: 'windows' }), 1, 'case-insensitive');
  assert.equal(await total({ search: '@win' }), 1, 'the author counts');
  assert.equal(await total({ search: '  ' }), 5, 'blank words are no filter');
  assert.equal(await total({ search: '100%' }), 1, 'a percent sign is a letter');
  assert.equal(await total({ search: 'broken_link' }), 1);
  assert.equal(await total({ search: 'broken-link' }), 0, 'an underscore is not a wildcard');
  assert.equal(await total({ search: 'install', bucket: 'replied' }), 0);
});

test('the facets count what each filter would offer, in grouped queries', async () => {
  const { registry, a, b } = await seeded();
  await add(registry, a.posts[0]!.id, 'mastodon', 1, 'new', 'one');
  await add(registry, a.posts[1]!.id, 'bluesky', 2, 'sent', 'two');
  await add(registry, b.posts[0]!.id, 'mastodon', 3, 'dismissed', 'three');
  const facets = await registry.commentFacets();
  assert.deepEqual(facets.channels, [
    { channel: 'bluesky', count: 1 },
    { channel: 'mastodon', count: 2 },
  ]);
  assert.deepEqual(
    facets.launches.map((l) => [l.ref, l.count]),
    [
      ['v2.0.0', 1],
      ['v1.0.0', 2],
    ],
  );
  assert.deepEqual(facets.buckets, { waiting: 1, replied: 1, ignored: 1 });
  const posts = await registry.commentPosts(a.launch.id);
  assert.deepEqual(
    posts.map((p) => [p.channel, p.count]),
    [
      ['mastodon', 1],
      ['bluesky', 1],
    ],
  );
});
