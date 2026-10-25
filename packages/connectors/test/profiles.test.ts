import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, Devto, Discord, Hashnode, imageUrl, Instagram, Mastodon, Telegram } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

test('only a plain https address is kept as a picture', () => {
  assert.equal(imageUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
  assert.equal(imageUrl('http://cdn.example/a.png'), undefined);
  assert.equal(imageUrl('javascript:alert(1)'), undefined);
  assert.equal(imageUrl('not a url'), undefined);
  assert.equal(imageUrl(null), undefined);
});

test('Bluesky checks with the app password, then reads the public profile for the picture and the counts', async () => {
  const calls: Call[] = [];
  const profile = () => Response.json({ avatar: 'https://cdn.bsky.app/a.jpg', displayName: 'José', followersCount: 120, followsCount: 80, postsCount: 45 });
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', () => Response.json({ did: 'did:plc:1', handle: 'me.bsky.social', accessJwt: 'j' })],
        ['GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3A1', profile],
      ],
      calls,
    ),
  });
  assert.deepEqual(await bluesky.check(), { ok: true, account: '@me.bsky.social', avatarUrl: 'https://cdn.bsky.app/a.jpg', displayName: 'José' });
  assert.deepEqual(await bluesky.profileStats(), { followers: 120, following: 80, posts: 45 });
  assert.equal(calls.at(-1)?.headers.authorization, undefined, 'the AppView needs no session');
});

test('a Bluesky profile that does not answer leaves the check working, without a picture', async () => {
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', () => Response.json({ did: 'did:plc:1', handle: 'me.bsky.social', accessJwt: 'j' })],
        ['GET https://public.api.bsky.app/', () => new Response('down', { status: 502 })],
      ],
      [],
    ),
  });
  assert.deepEqual(await bluesky.check(), { ok: true, account: '@me.bsky.social' });
});

test('Mastodon reads the picture, the name and the counts from verify_credentials', async () => {
  const me = () =>
    Response.json({ acct: 'me', display_name: 'José', avatar: 'https://files.mastodon.social/a.png', followers_count: 30, following_count: 12, statuses_count: 210 });
  const mastodon = new Mastodon({ instance: 'https://mastodon.social/', accessToken: 't', fetch: fakeFetch([['GET https://mastodon.social/api/v1/accounts/verify_credentials', me]], []) });
  assert.deepEqual(await mastodon.check(), { ok: true, account: '@me@mastodon.social', avatarUrl: 'https://files.mastodon.social/a.png', displayName: 'José' });
  assert.deepEqual(await mastodon.profileStats(), { followers: 30, following: 12, posts: 210 });
});

test('Instagram asks /me for the picture on the check and for the counts on the stats', async () => {
  const calls: Call[] = [];
  const instagram = new Instagram({
    userId: '17841',
    accessToken: 't',
    fetch: fakeFetch(
      [
        ['GET https://graph.instagram.com/v25.0/me?fields=user_id%2Cusername%2Cname%2Cprofile_picture_url', () => Response.json({ user_id: '17841', id: '9', username: 'me', name: 'José', profile_picture_url: 'https://scontent.cdninstagram.com/p.jpg?oe=1' })],
        ['GET https://graph.instagram.com/v25.0/me?fields=followers_count%2Cfollows_count%2Cmedia_count', () => Response.json({ followers_count: 500, follows_count: 50, media_count: 33, id: '9' })],
      ],
      calls,
    ),
  });
  assert.deepEqual(await instagram.check(), { ok: true, account: '@me', avatarUrl: 'https://scontent.cdninstagram.com/p.jpg?oe=1', displayName: 'José' });
  assert.deepEqual(await instagram.profileStats(), { followers: 500, following: 50, posts: 33 });
});

test('dev.to takes the picture from /users/me and counts followers and articles a thousand at a time', async () => {
  const calls: Call[] = [];
  const thousand = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const devto = new Devto({
    apiKey: 'k',
    fetch: fakeFetch(
      [
        ['GET https://dev.to/api/users/me', () => Response.json({ username: 'me', name: 'José', profile_image: 'https://media.dev.to/me.png' })],
        ['GET https://dev.to/api/followers/users?per_page=1000&page=1', () => Response.json(thousand)],
        ['GET https://dev.to/api/followers/users?per_page=1000&page=2', () => Response.json([{ id: 1 }, { id: 2 }])],
        ['GET https://dev.to/api/articles/me/published?per_page=1000&page=1', () => Response.json([{ id: 1 }, { id: 2 }, { id: 3 }])],
      ],
      calls,
    ),
  });
  assert.deepEqual(await devto.check(), { ok: true, account: '@me', avatarUrl: 'https://media.dev.to/me.png', displayName: 'José' });
  assert.deepEqual(await devto.profileStats(), { followers: 1002, posts: 3 });
  assert.equal(calls.length, 4);
});

test('Hashnode reads the picture with the check and the counts from me', async () => {
  const calls: Call[] = [];
  const hashnode = new Hashnode({
    token: 't',
    fetch: fakeFetch(
      [
        [
          'POST https://gql.hashnode.com',
          () => {
            const query = String(JSON.parse(String(calls.at(-1)?.body)).query);
            return query.includes('followersCount')
              ? Response.json({ data: { me: { followersCount: 7, followingsCount: 3, posts: { totalDocuments: 12 } } } })
              : Response.json({ data: { me: { username: 'me', name: 'José', profilePicture: 'https://cdn.hashnode.com/me.png' } } });
          },
        ],
      ],
      calls,
    ),
  });
  assert.deepEqual(await hashnode.check(), { ok: true, account: 'me', avatarUrl: 'https://cdn.hashnode.com/me.png', displayName: 'José' });
  assert.deepEqual(await hashnode.profileStats(), { followers: 7, following: 3, posts: 12 });
});

test('Telegram counts the channel’s members, and never keeps its photo, whose address carries the bot token', async () => {
  const telegram = new Telegram({
    botToken: 'T',
    chatId: '@c',
    fetch: fakeFetch(
      [
        // Before getChat, which is a prefix of it
        ['POST https://api.telegram.org/botT/getChatMemberCount', () => Response.json({ ok: true, result: 42 })],
        ['POST https://api.telegram.org/botT/getMe', () => Response.json({ ok: true, result: { username: 'bot' } })],
        ['POST https://api.telegram.org/botT/getChat', () => Response.json({ ok: true, result: { title: 'Shipcast', photo: { small_file_id: 's', big_file_id: 'b' } } })],
      ],
      [],
    ),
  });
  const check = await telegram.check();
  assert.ok(check.ok);
  assert.equal(check.ok && check.avatarUrl, undefined);
  assert.doesNotMatch(JSON.stringify(check), /botT/);
  assert.deepEqual(await telegram.profileStats(), { followers: 42 });
});

test('Discord builds the webhook’s picture on its CDN, and none for a webhook without one', async () => {
  const hook = 'https://discord.com/api/webhooks/1/abc';
  const withAvatar = new Discord({ webhookUrl: hook, fetch: fakeFetch([[`GET ${hook}`, () => Response.json({ id: '1', name: 'Shipcast', avatar: 'h4sh', channel_id: 'C' })]], []) });
  assert.deepEqual(await withAvatar.check(), { ok: true, account: 'Shipcast', avatarUrl: 'https://cdn.discordapp.com/avatars/1/h4sh.png?size=128' });
  const plain = new Discord({ webhookUrl: hook, fetch: fakeFetch([[`GET ${hook}`, () => Response.json({ id: '1', name: 'Shipcast', avatar: null, channel_id: 'C' })]], []) });
  assert.deepEqual(await plain.check(), { ok: true, account: 'Shipcast' });
});
