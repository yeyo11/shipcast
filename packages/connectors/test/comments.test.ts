import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, ConnectorError, Devto, htmlToText, Instagram, Mastodon } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.body)) as Record<string, unknown>;

test('HTML comments become plain text: paragraphs, breaks and entities kept, tags dropped', () => {
  assert.equal(htmlToText('<p>Hi <a href="x">@<span>me</span></a> &amp; you</p><p>Line<br>two &#x1F600; &#39;q&#39;</p>'), "Hi @me & you\n\nLine\ntwo 😀 'q'");
  assert.equal(htmlToText('&#99999999; &unknown;'), '&#99999999; &unknown;', 'what cannot be decoded stays as written');
});

test('Mastodon reads the public replies of a status, threads and the owner’s own replies told apart', async () => {
  const calls: Call[] = [];
  const account = (id: string, acct: string) => ({ id, acct, display_name: acct === 'me' ? 'Me' : 'Ana', avatar: 'https://files.example/a.png' });
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [
          'GET https://mastodon.social/api/v1/statuses/100/context',
          () =>
            Response.json({
              ancestors: [],
              descendants: [
                { id: '101', in_reply_to_id: '100', account: account('2', 'ana@fosstodon.org'), content: '<p>Does it run on Windows?</p>', created_at: '2026-10-20T10:00:00.000Z', url: 'https://fosstodon.org/@ana/101', visibility: 'public' },
                { id: '102', in_reply_to_id: '101', account: account('1', 'me'), content: '<p>Not yet</p>', created_at: '2026-10-20T11:00:00.000Z', url: 'https://mastodon.social/@me/102', visibility: 'public' },
                { id: '103', in_reply_to_id: '100', account: account('3', 'bob@x.y'), content: '<p>a secret</p>', created_at: '2026-10-20T12:00:00.000Z', visibility: 'direct' },
              ],
            }),
        ],
        ['GET https://mastodon.social/api/v1/accounts/verify_credentials', () => Response.json({ id: '1', acct: 'me' })],
      ],
      calls,
    ),
  });
  const comments = await mastodon.comments('100');
  assert.deepEqual(comments, [
    {
      externalId: '101',
      author: { handle: '@ana@fosstodon.org', displayName: 'Ana', avatarUrl: 'https://files.example/a.png' },
      text: 'Does it run on Windows?',
      createdAt: '2026-10-20T10:00:00.000Z',
      url: 'https://fosstodon.org/@ana/101',
      own: false,
    },
    {
      externalId: '102',
      author: { handle: '@me@mastodon.social', displayName: 'Me', avatarUrl: 'https://files.example/a.png' },
      text: 'Not yet',
      createdAt: '2026-10-20T11:00:00.000Z',
      inReplyTo: '101',
      url: 'https://mastodon.social/@me/102',
      own: true,
    },
  ]);
  assert.equal(calls[0]!.headers.authorization, 'Bearer t');
  assert.ok(calls.every((c) => !c.url.includes('t=') && !c.url.includes('token')), 'the token travels in a header, never in the URL');
});

test('Mastodon replies in the thread, mentioning the author, with an idempotency key', async () => {
  const calls: Call[] = [];
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch([['POST https://mastodon.social/api/v1/statuses', () => Response.json({ id: '200', url: 'https://mastodon.social/@me/200' })]], calls),
  });
  const sent = await mastodon.reply({ postExternalId: '100', commentExternalId: '101', authorHandle: '@ana@fosstodon.org' }, 'Not yet, it is planned.', { key: 'k1' });
  assert.deepEqual(sent, { externalId: '200', url: 'https://mastodon.social/@me/200' });
  assert.deepEqual(bodyOf(calls[0]), { status: '@ana@fosstodon.org Not yet, it is planned.', in_reply_to_id: '101', visibility: 'public' });
  assert.equal(calls[0]!.headers['idempotency-key'], 'k1');
  await mastodon.reply({ postExternalId: '100', commentExternalId: '101', authorHandle: '@ana@fosstodon.org' }, 'Thanks @ana@fosstodon.org!');
  assert.equal(bodyOf(calls[1]).status, 'Thanks @ana@fosstodon.org!', 'a draft that names the author is not given a second mention');
});

const blueskyThread = {
  thread: {
    post: { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'c0', author: { did: 'did:plc:me', handle: 'me.bsky.social' }, record: { text: 'launch' } },
    replies: [
      {
        post: {
          uri: 'at://did:plc:ana/app.bsky.feed.post/r1',
          cid: 'c1',
          author: { did: 'did:plc:ana', handle: 'ana.bsky.social', displayName: 'Ana', avatar: 'https://cdn.bsky.app/a.jpg' },
          record: { text: 'Nice!', createdAt: '2026-10-21T09:00:00.000Z', reply: { parent: { uri: 'at://did:plc:me/app.bsky.feed.post/root' } } },
        },
        replies: [
          {
            post: {
              uri: 'at://did:plc:me/app.bsky.feed.post/r2',
              cid: 'c2',
              author: { did: 'did:plc:me', handle: 'me.bsky.social' },
              record: { text: 'Thanks', createdAt: '2026-10-21T10:00:00.000Z', reply: { parent: { uri: 'at://did:plc:ana/app.bsky.feed.post/r1' } } },
            },
          },
        ],
      },
      { $type: 'app.bsky.feed.defs#blockedPost', uri: 'at://x/app.bsky.feed.post/b' },
    ],
  },
};

test('Bluesky reads a post’s thread from the public AppView, nested replies included and blocked ones left out', async () => {
  const calls: Call[] = [];
  const bluesky = new Bluesky({ identifier: 'me.bsky.social', appPassword: 'p', fetch: fakeFetch([['GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread', () => Response.json(blueskyThread)]], calls) });
  const comments = await bluesky.comments('at://did:plc:me/app.bsky.feed.post/root');
  assert.equal(comments.length, 2);
  assert.deepEqual(comments[0], {
    externalId: 'at://did:plc:ana/app.bsky.feed.post/r1',
    author: { handle: '@ana.bsky.social', displayName: 'Ana', avatarUrl: 'https://cdn.bsky.app/a.jpg' },
    text: 'Nice!',
    createdAt: '2026-10-21T09:00:00.000Z',
    url: 'https://bsky.app/profile/ana.bsky.social/post/r1',
    own: false,
  });
  assert.equal(comments[1]!.own, true);
  assert.equal(comments[1]!.inReplyTo, 'at://did:plc:ana/app.bsky.feed.post/r1');
  assert.match(calls[0]!.url, /uri=at%3A%2F%2Fdid%3Aplc%3Ame/);
});

test('Bluesky threads a reply with strong references to the root post and the comment', async () => {
  const calls: Call[] = [];
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch(
      [
        [
          'GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts',
          () => Response.json({ posts: [{ uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'c0' }, { uri: 'at://did:plc:ana/app.bsky.feed.post/r1', cid: 'c1' }] }),
        ],
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', () => Response.json({ did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'jwt' })],
        ['POST https://bsky.social/xrpc/com.atproto.repo.createRecord', () => Response.json({ uri: 'at://did:plc:me/app.bsky.feed.post/r3', cid: 'c3' })],
      ],
      calls,
    ),
  });
  const sent = await bluesky.reply({ postExternalId: 'at://did:plc:me/app.bsky.feed.post/root', commentExternalId: 'at://did:plc:ana/app.bsky.feed.post/r1', authorHandle: '@ana.bsky.social' }, 'Thanks!');
  assert.deepEqual(sent, { externalId: 'at://did:plc:me/app.bsky.feed.post/r3', url: 'https://bsky.app/profile/me.bsky.social/post/r3' });
  assert.match(calls[0]!.url, /uris=at%3A%2F%2Fdid%3Aplc%3Ame%2Fapp.bsky.feed.post%2Froot&uris=at%3A%2F%2Fdid%3Aplc%3Aana/);
  const record = bodyOf(calls[2]).record as Record<string, unknown>;
  assert.equal(bodyOf(calls[2]).repo, 'did:plc:me');
  assert.equal(record.text, 'Thanks!');
  assert.deepEqual(record.reply, { root: { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'c0' }, parent: { uri: 'at://did:plc:ana/app.bsky.feed.post/r1', cid: 'c1' } });
});

test('Bluesky refuses to reply to a comment that is gone', async () => {
  const bluesky = new Bluesky({ identifier: 'me', appPassword: 'p', fetch: fakeFetch([['GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts', () => Response.json({ posts: [] })]], []) });
  await assert.rejects(bluesky.reply({ postExternalId: 'at://a/b/c', commentExternalId: 'at://d/e/f', authorHandle: '@x' }, 'hi'), (e: unknown) => e instanceof ConnectorError && e.status === 404);
});

test('Instagram reads a post’s comments and their replies, page by page, and replies under a comment', async () => {
  const calls: Call[] = [];
  const instagram = new Instagram({
    userId: '17',
    accessToken: 'IG',
    fetch: fakeFetch(
      [
        ['GET https://graph.instagram.com/v25.0/me?', () => Response.json({ username: 'me' })],
        [
          'GET https://graph.instagram.com/v25.0/555/comments?fields=id%2Ctext%2Ctimestamp%2Cusername%2Cfrom%2Creplies%7Bid%2Ctext%2Ctimestamp%2Cusername%2Cfrom%7D&limit=50&access_token=IG',
          () =>
            Response.json({
              data: [{ id: 'c1', text: 'Love it', timestamp: '2026-10-22T08:00:00+0000', username: 'ana', replies: { data: [{ id: 'c2', text: 'Gracias', timestamp: '2026-10-22T09:00:00+0000', username: 'me' }] } }],
              paging: { cursors: { after: 'A' }, next: 'https://graph.instagram.com/next' },
            }),
        ],
        ['GET https://graph.instagram.com/v25.0/555/comments?', () => Response.json({ data: [{ id: 'c3', text: 'Second page', timestamp: '2026-10-22T10:00:00+0000', username: 'bob' }], paging: {} })],
        ['POST https://graph.instagram.com/v25.0/c1/replies', () => Response.json({ id: 'c4' })],
      ],
      calls,
    ),
  });
  const comments = await instagram.comments('555');
  assert.deepEqual(
    comments.map((c) => [c.externalId, c.author.handle, c.inReplyTo, c.own]),
    [
      ['c1', '@ana', undefined, false],
      ['c2', '@me', 'c1', true],
      ['c3', '@bob', undefined, false],
    ],
  );
  assert.match(calls[2]!.url, /after=A/, 'the second page follows the cursor');
  const sent = await instagram.reply({ postExternalId: '555', commentExternalId: 'c1', authorHandle: '@ana' }, 'Thanks!');
  assert.deepEqual(sent, { externalId: 'c4' });
  const form = new URLSearchParams(String(calls.at(-1)!.body));
  assert.equal(form.get('message'), 'Thanks!');
  assert.equal(form.get('access_token'), 'IG', 'the token goes in the body of a POST');
});

test('Instagram says which permission is missing when the comments are refused', async () => {
  const refusal = () => Response.json({ error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10 } }, { status: 403 });
  const instagram = new Instagram({
    userId: '17',
    accessToken: 'IG',
    fetch: fakeFetch(
      [
        ['GET https://graph.instagram.com/v25.0/me?', () => Response.json({ username: 'me' })],
        ['GET https://graph.instagram.com/v25.0/555/comments', refusal],
      ],
      [],
    ),
  });
  await assert.rejects(instagram.comments('555'), (e: unknown) => e instanceof ConnectorError && /instagram_business_manage_comments/.test(e.message) && !e.retryable);
});

test('dev.to reads an article’s comment threads, read-only, with each comment’s address', async () => {
  const calls: Call[] = [];
  const devto = new Devto({
    apiKey: 'K',
    fetch: fakeFetch(
      [
        ['GET https://dev.to/api/users/me', () => Response.json({ username: 'me' })],
        [
          'GET https://dev.to/api/comments?a_id=42',
          () =>
            Response.json([
              {
                id_code: 'a1',
                created_at: '2026-10-23T08:00:00Z',
                body_html: '<p>How does it compare?</p>',
                user: { username: 'ana', name: 'Ana', profile_image_90: 'https://media.dev.to/a.png' },
                children: [
                  { id_code: 'a2', created_at: '2026-10-23T09:00:00Z', body_html: '<p>Good question</p>', user: { username: 'me', name: 'Me' }, children: [] },
                  { id_code: 'a3', created_at: '2026-10-23T09:30:00Z', deleted: true, children: [] },
                ],
              },
            ]),
        ],
      ],
      calls,
    ),
  });
  assert.equal('reply' in devto, false, 'Forem has no endpoint to write a comment');
  const comments = await devto.comments('42');
  assert.deepEqual(comments[0], {
    externalId: 'a1',
    author: { handle: '@ana', displayName: 'Ana', avatarUrl: 'https://media.dev.to/a.png' },
    text: 'How does it compare?',
    createdAt: '2026-10-23T08:00:00Z',
    url: 'https://dev.to/ana/comment/a1',
    own: false,
  });
  assert.deepEqual([comments[1]!.externalId, comments[1]!.inReplyTo, comments[1]!.own], ['a2', 'a1', true]);
  assert.equal(comments.length, 2, 'a deleted comment is left out');
  assert.equal(calls.find((c) => c.url.includes('/comments'))!.headers['api-key'], 'K');
});
