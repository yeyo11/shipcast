import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, ConnectorError, Devto, Mastodon } from '@shipcast/connectors';
import { blueskyFeed, countFeed, mastodonFeed } from '../src/channels/feeds.ts';
import { MemoryCache } from '../src/redis/memory.ts';

/*
 * The adapters' comment feeds over the real connectors and a fake network: one call per account
 * says which posts moved, and what an account is (its id, a session) is asked once across runs.
 */

const posts = [
  { postId: 1, externalId: '101' },
  { postId: 2, externalId: '102' },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('Mastodon: mentions place each reply under its post, through earlier replies and recorded comments', async () => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}?${url.searchParams}`);
    return json([
      // Newest first, as Mastodon answers
      { id: '13', status: { id: 's6', in_reply_to_id: 'elsewhere', visibility: 'public' } },
      { id: '12', status: { id: 's5', in_reply_to_id: 'c-known', visibility: 'public' } },
      { id: '11', status: { id: 's4', in_reply_to_id: '101', visibility: 'direct' } },
      { id: '10', status: { id: 's3', in_reply_to_id: 's2', visibility: 'public' } },
      { id: '9', status: { id: 's2', in_reply_to_id: '101', visibility: 'unlisted' } },
    ]);
  };
  const feed = mastodonFeed(new Mastodon({ instance: 'https://m.example', accessToken: 't', fetch }));
  const changes = await feed.changes(posts, '8', { postOfComment: async (id) => (id === 'c-known' ? '102' : undefined) });
  assert.deepEqual([...changes.touched].sort(), ['101', '102']);
  assert.equal(changes.cursor, '13');
  assert.deepEqual(calls, ['/api/v1/notifications?types%5B%5D=mention&limit=80&min_id=8']);
});

test('Mastodon: a token granted before read:notifications is refused as what to do, never retried', async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ error: 'This action is outside the authorized scopes' }), { status: 403 });
  const feed = mastodonFeed(new Mastodon({ instance: 'https://m.example', accessToken: 't', fetch }));
  await assert.rejects(
    feed.changes(posts, '8', { postOfComment: async () => undefined }),
    (error: unknown) => error instanceof ConnectorError && !error.retryable && /not granted read:notifications: connect the account again/.test(error.message),
  );
});

test('Bluesky: one notifications call; the read session is kept between runs', async () => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.pathname.split('/').at(-1)!);
    if (url.pathname.endsWith('createSession')) return json({ did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'jwt' });
    return json({
      notifications: [
        { uri: 'at://x/1', reason: 'reply', indexedAt: '2026-11-10T10:05:00Z', record: { reply: { root: { uri: '102' }, parent: { uri: 'at://y/2' } } } },
        { uri: 'at://x/0', reason: 'reply', indexedAt: '2026-11-10T09:00:00Z', record: { reply: { root: { uri: '101' }, parent: { uri: '101' } } } },
      ],
    });
  };
  const cache = new MemoryCache();
  const run = () => blueskyFeed(new Bluesky({ identifier: 'me.bsky.social', appPassword: 'p', fetch, cache })).changes(posts, '2026-11-10T10:00:00Z', { postOfComment: async () => undefined });
  const first = await run();
  assert.deepEqual([...first.touched], ['102'], 'the older notification was seen last run');
  assert.equal(first.cursor, '2026-11-10T10:05:00Z');
  await run();
  assert.deepEqual(calls, ['com.atproto.server.createSession', 'app.bsky.notification.listNotifications', 'app.bsky.notification.listNotifications'], 'one sign-in for both runs');
});

test('dev.to: one listing; a post whose comment count moved is the one read', async () => {
  let comments = 0;
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(new URL(String(input)).pathname);
    return json([
      { id: 101, page_views_count: 1, public_reactions_count: 0, comments_count: comments },
      { id: 102, page_views_count: 1, public_reactions_count: 0, comments_count: 3 },
    ]);
  };
  const devto = new Devto({ apiKey: 'k', fetch });
  const feed = countFeed(() => devto.commentCounts());
  const known = { postOfComment: async () => undefined };
  const first = await feed.changes(posts, undefined, known);
  assert.deepEqual([...first.touched], ['101', '102'], 'no cursor: every post');
  const quiet = await feed.changes(posts, first.cursor, known);
  assert.deepEqual([...quiet.touched], []);
  comments = 1;
  const moved = await feed.changes(posts, quiet.cursor, known);
  assert.deepEqual([...moved.touched], ['101']);
  assert.equal(calls.length, 3, 'one call a run');
});
