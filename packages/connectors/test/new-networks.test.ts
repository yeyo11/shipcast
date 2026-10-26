import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConnectorError,
  escapeLittle,
  exchangeLinkedInCode,
  exchangeThreadsCode,
  GitHubDiscussions,
  LinkedIn,
  linkedinAuthorizeUrl,
  Threads,
  threadsAuthorizeUrl,
} from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

const GQL = 'POST https://api.github.com/graphql';
const gql = (data: unknown) => () => Response.json({ data });
const bodyOf = (call: Call | undefined) => JSON.parse(String(call?.body)) as { query: string; variables: Record<string, unknown> };
const repoAnswer = (enabled: boolean, categories: string[]) =>
  gql({ repository: { id: 'R_1', hasDiscussionsEnabled: enabled, discussionCategories: { nodes: categories.map((name, i) => ({ id: `C_${i}`, name })) } } });

test('GitHub Discussions: a discussion goes in Announcements, is updated and deleted through GraphQL with the minted token', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      [
        GQL,
        sequence(
          repoAnswer(true, ['General', 'Announcements', 'Q&A']),
          gql({ createDiscussion: { discussion: { id: 'D_1', url: 'https://github.com/yeyo11/claudio/discussions/7' } } }),
          gql({ updateDiscussion: { discussion: { id: 'D_1' } } }),
          gql({ deleteDiscussion: { discussion: { id: 'D_1' } } }),
        ),
      ],
    ],
    calls,
  );
  const discussions = new GitHubDiscussions({ auth: { token: async () => 'inst-token' }, fetch: http });
  const published = await discussions.publish({ repo: 'yeyo11/claudio', title: 'claudio 1.0', body: 'What shipped.' });
  assert.deepEqual(published, { externalId: 'D_1', url: 'https://github.com/yeyo11/claudio/discussions/7' });
  assert.equal(calls[0]!.headers.authorization, 'Bearer inst-token');
  assert.deepEqual(bodyOf(calls[0]).variables, { owner: 'yeyo11', name: 'claudio' });
  assert.deepEqual(bodyOf(calls[1]).variables, { input: { repositoryId: 'R_1', categoryId: 'C_1', title: 'claudio 1.0', body: 'What shipped.' } });
  assert.match(bodyOf(calls[1]).query, /createDiscussion/);

  await discussions.edit('D_1', { body: 'Edited.' });
  assert.deepEqual(bodyOf(calls[2]).variables, { input: { discussionId: 'D_1', body: 'Edited.' } });
  await discussions.delete('D_1');
  assert.deepEqual(bodyOf(calls[3]).variables, { input: { id: 'D_1' } });
  assert.match(bodyOf(calls[3]).query, /deleteDiscussion/);
});

test('GitHub Discussions: General when there is no Announcements; turned-off Discussions are said in words and not retried', async () => {
  const general = new GitHubDiscussions({ auth: { token: async () => 't' }, fetch: fakeFetch([[GQL, repoAnswer(true, ['General', 'Ideas'])]], []) });
  assert.equal(await general.category('yeyo11/claudio'), 'General');

  const off = new GitHubDiscussions({ auth: { token: async () => 't' }, fetch: fakeFetch([[GQL, repoAnswer(false, [])]], []) });
  await assert.rejects(
    off.publish({ repo: 'yeyo11/claudio', title: 't', body: 'b' }),
    (e) => e instanceof ConnectorError && /enable Discussions in the repo settings/.test(e.message) && !e.retryable,
  );

  const missing = new GitHubDiscussions({ auth: { token: async () => 't' }, fetch: fakeFetch([[GQL, () => Response.json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] })]], []) });
  await assert.rejects(missing.publish({ repo: 'yeyo11/gone', title: 't', body: 'b' }), (e) => e instanceof ConnectorError && e.status === 404);
});

test('GitHub Discussions: a refused token is minted again once', async () => {
  const calls: Call[] = [];
  let minted = 0;
  const auth = { token: async () => `token-${minted}`, invalidate: () => void minted++ };
  const http = fakeFetch([[GQL, sequence(() => new Response('{"message":"Bad credentials"}', { status: 401 }), gql({ deleteDiscussion: { discussion: { id: 'D_1' } } }))]], calls);
  await new GitHubDiscussions({ auth, fetch: http }).delete('D_1');
  assert.deepEqual(
    calls.map((c) => c.headers.authorization),
    ['Bearer token-0', 'Bearer token-1'],
  );
});

test('GitHub Discussions: metrics, comments with their replies, and a reply under the thread’s comment', async () => {
  const calls: Call[] = [];
  const comment = (id: string, login: string, extra: Record<string, unknown> = {}) => ({
    id,
    body: `${id} body`,
    createdAt: '2026-10-25T10:00:00Z',
    url: `https://github.com/x/y/discussions/1#${id}`,
    viewerDidAuthor: false,
    authorAssociation: 'NONE',
    author: { login, avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    ...extra,
  });
  const http = fakeFetch(
    [
      [
        GQL,
        sequence(
          gql({ node: { upvoteCount: 3, reactions: { totalCount: 5 }, comments: { totalCount: 2 } } }),
          gql({ node: { comments: { nodes: [{ ...comment('DC_1', 'ana'), replies: { nodes: [comment('DC_2', 'yeyo11', { authorAssociation: 'OWNER' }), comment('DC_3', 'bot', { viewerDidAuthor: true })] } }] } } }),
          gql({ node: { replyTo: { id: 'DC_1' } } }),
          gql({ addDiscussionComment: { comment: { id: 'DC_9', url: 'https://github.com/x/y/discussions/1#DC_9' } } }),
        ),
      ],
    ],
    calls,
  );
  const discussions = new GitHubDiscussions({ auth: { token: async () => 't' }, fetch: http });
  assert.deepEqual(await discussions.metrics('D_1'), { reactions: 5, upvotes: 3, comments: 2 });
  const list = await discussions.comments('D_1');
  assert.deepEqual(
    list.map((c) => [c.externalId, c.author.handle, c.inReplyTo ?? null, c.own]),
    [
      ['DC_1', '@ana', null, false],
      ['DC_2', '@yeyo11', 'DC_1', true],
      ['DC_3', '@bot', 'DC_1', true],
    ],
  );
  const sent = await discussions.reply({ postExternalId: 'D_1', commentExternalId: 'DC_2', authorHandle: '@yeyo11' }, 'Thanks!');
  assert.deepEqual(sent, { externalId: 'DC_9', url: 'https://github.com/x/y/discussions/1#DC_9' });
  // GitHub nests one level: a reply to a reply goes under the comment its thread hangs from
  assert.deepEqual(bodyOf(calls[3]).variables, { input: { discussionId: 'D_1', replyToId: 'DC_1', body: 'Thanks!' } });
});

test('Threads: the code becomes a long-lived token, and the authorize URL asks for every scope', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://graph.threads.com/oauth/access_token', () => new Response('{"access_token":"short","user_id":17841400000000000001}')],
      ['GET https://graph.threads.com/access_token?', () => Response.json({ access_token: 'long', token_type: 'bearer', expires_in: 5184000 })],
    ],
    calls,
  );
  const url = new URL(threadsAuthorizeUrl('app1', 'https://shipcast.example/auth/threads/callback', 'st'));
  assert.equal(url.origin + url.pathname, 'https://threads.com/oauth/authorize');
  assert.equal(url.searchParams.get('scope'), 'threads_basic,threads_content_publish,threads_read_replies,threads_manage_replies,threads_manage_insights,threads_delete');
  assert.equal(url.searchParams.get('state'), 'st');

  const token = await exchangeThreadsCode({ appId: 'app1', appSecret: 'sec' }, 'https://shipcast.example/auth/threads/callback', 'code#_', http);
  assert.deepEqual(token, { userId: '17841400000000000001', accessToken: 'long', expiresIn: 5184000 }, 'the id is kept whole, past 2^53');
  const form = new URLSearchParams(String(calls[0]!.body));
  assert.equal(form.get('code'), 'code', 'the #_ Threads appends is dropped');
  assert.equal(form.get('grant_type'), 'authorization_code');
  const exchange = new URL(calls[1]!.url);
  assert.equal(exchange.searchParams.get('grant_type'), 'th_exchange_token');
  assert.equal(exchange.searchParams.get('access_token'), 'short');
});

test('Threads: an image post is a container waited on and then published; delete, insights and refresh', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://graph.threads.com/v1.0/42/threads_publish', () => Response.json({ id: 'post-1' })],
      ['POST https://graph.threads.com/v1.0/42/threads', () => Response.json({ id: 'cont-1' })],
      ['GET https://graph.threads.com/v1.0/cont-1?', sequence(() => Response.json({ status: 'IN_PROGRESS' }), () => Response.json({ status: 'FINISHED' }))],
      ['GET https://graph.threads.com/v1.0/post-1/insights?', () => Response.json({ data: [{ name: 'views', values: [{ value: 120 }] }, { name: 'likes', values: [{ value: 7 }] }] })],
      ['GET https://graph.threads.com/v1.0/post-1?', () => Response.json({ permalink: 'https://www.threads.com/@me/post/abc' })],
      ['DELETE https://graph.threads.com/v1.0/post-1?', () => Response.json({ success: true, deleted_id: 'post-1' })],
      ['GET https://graph.threads.com/refresh_access_token?', () => Response.json({ access_token: 'fresh', expires_in: 5184000 })],
    ],
    calls,
  );
  const threads = new Threads({ userId: '42', accessToken: 'tok', fetch: http, sleep: async () => {} });
  const published = await threads.publish({ text: 'Hello https://example.dev/en/x/?ref=threads', imageUrl: 'https://example.dev/og.jpg' });
  assert.deepEqual(published, { externalId: 'post-1', url: 'https://www.threads.com/@me/post/abc' });
  const container = new URLSearchParams(String(calls[0]!.body));
  assert.equal(container.get('media_type'), 'IMAGE');
  assert.equal(container.get('image_url'), 'https://example.dev/og.jpg');
  assert.equal(container.get('text'), 'Hello https://example.dev/en/x/?ref=threads');
  assert.equal(calls.filter((c) => c.url.includes('/cont-1?')).length, 2, 'it waits until the container is FINISHED');
  assert.equal(new URLSearchParams(String(calls.find((c) => c.url.endsWith('/threads_publish'))!.body)).get('creation_id'), 'cont-1');

  assert.deepEqual(await threads.metrics('post-1'), { views: 120, likes: 7 });
  await threads.delete('post-1');
  assert.equal(calls.at(-1)!.method, 'DELETE');
  assert.deepEqual(await threads.refreshToken(), { accessToken: 'fresh', expiresIn: 5184000 });
  assert.equal(new URL(calls.at(-1)!.url).searchParams.get('grant_type'), 'th_refresh_token');
});

test('Threads: a text post has no image; the replies are read flat and a reply is a post with reply_to_id', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://graph.threads.com/v1.0/42/threads_publish', () => Response.json({ id: 'r-9' })],
      ['POST https://graph.threads.com/v1.0/42/threads', () => Response.json({ id: 'cont-2' })],
      ['GET https://graph.threads.com/v1.0/cont-2?', () => Response.json({ status: 'FINISHED' })],
      ['GET https://graph.threads.com/v1.0/me?', () => Response.json({ username: 'me' })],
      [
        'GET https://graph.threads.com/v1.0/post-1/conversation?',
        () =>
          Response.json({
            data: [
              { id: 'c1', text: 'Nice!', username: 'ana', timestamp: '2026-10-25T10:00:00+0000', replied_to: { id: 'post-1' } },
              { id: 'c2', text: 'Thanks', username: 'me', timestamp: '2026-10-25T10:05:00+0000', replied_to: { id: 'c1' } },
            ],
          }),
      ],
      ['GET https://graph.threads.com/v1.0/r-9?', () => Response.json({ permalink: 'https://www.threads.com/@me/post/r9' })],
    ],
    calls,
  );
  const threads = new Threads({ userId: '42', accessToken: 'tok', fetch: http, sleep: async () => {} });
  const list = await threads.comments('post-1');
  assert.deepEqual(
    list.map((c) => [c.externalId, c.inReplyTo ?? null, c.own]),
    [
      ['c1', null, false],
      ['c2', 'c1', true],
    ],
  );
  const sent = await threads.reply({ postExternalId: 'post-1', commentExternalId: 'c1', authorHandle: '@ana' }, 'Glad you like it');
  assert.deepEqual(sent, { externalId: 'r-9', url: 'https://www.threads.com/@me/post/r9' });
  const container = new URLSearchParams(String(calls.find((c) => c.method === 'POST' && c.url.endsWith('/42/threads'))!.body));
  assert.equal(container.get('media_type'), 'TEXT');
  assert.equal(container.get('reply_to_id'), 'c1');
  assert.equal(container.get('image_url'), null);
});

test('LinkedIn: the code becomes a token and the member id comes from userinfo', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://www.linkedin.com/oauth/v2/accessToken', () => Response.json({ access_token: 'li-tok', expires_in: 5184000, scope: 'openid,profile,w_member_social' })],
      ['GET https://api.linkedin.com/v2/userinfo', () => Response.json({ sub: 'abc123', name: 'José' })],
    ],
    calls,
  );
  const url = new URL(linkedinAuthorizeUrl('cid', 'https://shipcast.example/auth/linkedin/callback', 'st'));
  assert.equal(url.origin + url.pathname, 'https://www.linkedin.com/oauth/v2/authorization');
  assert.equal(url.searchParams.get('scope'), 'openid profile w_member_social');
  const token = await exchangeLinkedInCode({ clientId: 'cid', clientSecret: 'sec' }, 'https://shipcast.example/auth/linkedin/callback', 'code', http);
  assert.deepEqual(token, { personId: 'abc123', name: 'José', accessToken: 'li-tok', expiresIn: 5184000 });
  const form = new URLSearchParams(String(calls[0]!.body));
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), 'https://shipcast.example/auth/linkedin/callback');
  assert.equal(calls[1]!.headers.authorization, 'Bearer li-tok');
});

test('LinkedIn: an article post with its uploaded thumbnail, through the Posts API, and its delete', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://api.linkedin.com/rest/images?action=initializeUpload', () => Response.json({ value: { uploadUrl: 'https://upload.linkedin.example/img', image: 'urn:li:image:I1' } })],
      ['PUT https://upload.linkedin.example/img', () => new Response(null, { status: 201 })],
      ['POST https://api.linkedin.com/rest/posts', () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:777' } })],
      ['DELETE https://api.linkedin.com/rest/posts/', () => new Response(null, { status: 204 })],
    ],
    calls,
  );
  const linkedin = new LinkedIn({ personId: 'abc123', accessToken: 'li-tok', fetch: http });
  const published = await linkedin.publish({
    text: 'Shipped (finally) #opensource',
    article: { url: 'https://example.dev/en/x/?ref=linkedin', title: 'X', description: 'What X does', thumbnail: { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg' } },
  });
  assert.deepEqual(published, { externalId: 'urn:li:share:777', url: 'https://www.linkedin.com/feed/update/urn:li:share:777/' });
  const post = calls.find((c) => c.url === 'https://api.linkedin.com/rest/posts')!;
  assert.equal(post.headers['linkedin-version'], '202609');
  assert.equal(post.headers['x-restli-protocol-version'], '2.0.0');
  const body = JSON.parse(String(post.body)) as Record<string, unknown>;
  assert.equal(body.author, 'urn:li:person:abc123');
  assert.equal(body.commentary, 'Shipped \\(finally\\) #opensource', 'little-format markup is escaped; a hashtag stays one');
  assert.deepEqual(body.content, { article: { source: 'https://example.dev/en/x/?ref=linkedin', title: 'X', description: 'What X does', thumbnail: 'urn:li:image:I1' } });
  assert.equal(body.visibility, 'PUBLIC');
  assert.equal(body.lifecycleState, 'PUBLISHED');

  await linkedin.delete('urn:li:share:777');
  assert.equal(calls.at(-1)!.url, 'https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A777');
  assert.equal(calls.at(-1)!.headers['x-restli-method'], 'DELETE');
  assert.equal(escapeLittle('a_b*c'), 'a\\_b\\*c');
});

test('LinkedIn: a thumbnail that fails costs the card its picture, not the post; an expired token is refused before any request', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://api.linkedin.com/rest/images', () => new Response('nope', { status: 500 })],
      ['POST https://api.linkedin.com/rest/posts', () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } })],
    ],
    calls,
  );
  const linkedin = new LinkedIn({ personId: 'p', accessToken: 't', fetch: http });
  await linkedin.publish({ text: 't', article: { url: 'https://example.dev/x', title: 'X', description: 'd', thumbnail: { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' } } });
  const content = (JSON.parse(String(calls.at(-1)!.body)) as { content: { article: Record<string, unknown> } }).content.article;
  assert.equal(content.thumbnail, undefined);

  const expired = new LinkedIn({ personId: 'p', accessToken: 't', expiresAt: '2026-01-01T00:00:00Z', fetch: fakeFetch([], []), now: () => Date.parse('2026-10-25T00:00:00Z') });
  await assert.rejects(expired.publish({ text: 't', article: { url: 'https://example.dev/x', title: 'X', description: 'd' } }), (e) => e instanceof ConnectorError && !e.retryable);
  assert.equal((await expired.check()).ok, false);
});
