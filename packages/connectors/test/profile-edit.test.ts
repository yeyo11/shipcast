import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, ConnectorError, Devto, MASTODON_SCOPES, Mastodon, Telegram } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

/*
 * Reading and changing an account's own profile, every network faked: nothing here reaches a real
 * one. See docs/decisions/account-analysis.md
 */

test('Mastodon reads the profile from its plain source, and tells a placeholder picture from a real one', async () => {
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch(
      [
        [
          'GET https://mastodon.social/api/v1/accounts/verify_credentials',
          () =>
            Response.json({
              id: '1',
              acct: 'me',
              display_name: 'José',
              note: '<p>I build <a href="x">tools</a></p>',
              avatar: 'https://files.mastodon.social/a.png',
              header: 'https://mastodon.social/headers/original/missing.png',
              fields: [{ name: 'Site', value: '<a href="https://example.dev">example.dev</a>' }],
              source: { note: 'I build tools', fields: [{ name: 'Site', value: 'https://example.dev' }] },
            }),
        ],
      ],
      [],
    ),
  });
  assert.deepEqual(await mastodon.profile(), {
    displayName: 'José',
    bio: 'I build tools',
    links: [{ name: 'Site', value: 'https://example.dev' }],
    hasAvatar: true,
    hasBanner: false,
  });
});

test('Mastodon edits the name, the note and the fields through update_credentials', async () => {
  const calls: Call[] = [];
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch([['PATCH https://mastodon.social/api/v1/accounts/update_credentials', () => Response.json({ id: '1' })]], calls),
  });
  await mastodon.editProfile({ displayName: 'José G.', bio: 'New bio', links: [{ name: 'Blog', value: 'https://example.dev' }] });
  const form = calls[0]!.body as URLSearchParams;
  assert.equal(form.get('display_name'), 'José G.');
  assert.equal(form.get('note'), 'New bio');
  assert.equal(form.get('fields_attributes[0][name]'), 'Blog');
  assert.equal(form.get('fields_attributes[0][value]'), 'https://example.dev');
  assert.equal(calls[0]!.headers.authorization, 'Bearer t');

  // Only what changes is sent: a name alone leaves the note and the fields as they are
  calls.length = 0;
  await mastodon.editProfile({ displayName: 'J' });
  assert.deepEqual([...(calls[0]!.body as URLSearchParams).keys()], ['display_name']);
});

test('a Mastodon token without write:accounts is told to reconnect', async () => {
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch([['PATCH https://mastodon.social/api/v1/accounts/update_credentials', () => Response.json({ error: 'This action is outside the authorized scopes' }, { status: 403 })]], []),
  });
  await assert.rejects(mastodon.editProfile({ bio: 'x' }), (error: unknown) => error instanceof ConnectorError && /connect the account again/.test(error.message) && !error.retryable);
});

test('new Mastodon connections ask for write:accounts', () => {
  assert.match(MASTODON_SCOPES, /\bwrite:accounts\b/);
  assert.match(MASTODON_SCOPES, /\bwrite:statuses\b/);
});

const session = () => Response.json({ did: 'did:plc:1', handle: 'me.bsky.social', accessJwt: 'j' });

test('Bluesky edits the profile record, keeping the picture, the banner and everything else, guarded by swapRecord', async () => {
  const calls: Call[] = [];
  const avatar = { $type: 'blob', ref: { $link: 'bafy-avatar' }, mimeType: 'image/jpeg', size: 1000 };
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', session],
        [
          'GET https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3A1&collection=app.bsky.actor.profile&rkey=self',
          () => Response.json({ uri: 'at://did:plc:1/app.bsky.actor.profile/self', cid: 'cid-1', value: { $type: 'app.bsky.actor.profile', displayName: 'Old', description: 'Old bio', avatar, pinnedPost: { uri: 'at://x', cid: 'y' } } }),
        ],
        ['POST https://bsky.social/xrpc/com.atproto.repo.putRecord', () => Response.json({ uri: 'at://did:plc:1/app.bsky.actor.profile/self', cid: 'cid-2' })],
      ],
      calls,
    ),
  });
  await bluesky.editProfile({ bio: 'New bio' });
  const put = JSON.parse(String(calls.at(-1)!.body));
  assert.equal(put.swapRecord, 'cid-1');
  assert.equal(put.rkey, 'self');
  assert.equal(put.collection, 'app.bsky.actor.profile');
  assert.deepEqual(put.record, { $type: 'app.bsky.actor.profile', displayName: 'Old', description: 'New bio', avatar, pinnedPost: { uri: 'at://x', cid: 'y' } });
});

test('Bluesky creates the profile record when there is none, and an empty name removes it', async () => {
  const calls: Call[] = [];
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', session],
        ['GET https://bsky.social/xrpc/com.atproto.repo.getRecord', () => Response.json({ error: 'RecordNotFound', message: 'Could not locate record' }, { status: 400 })],
        ['POST https://bsky.social/xrpc/com.atproto.repo.putRecord', () => Response.json({})],
      ],
      calls,
    ),
  });
  await bluesky.editProfile({ displayName: '', bio: 'Hello' });
  const put = JSON.parse(String(calls.at(-1)!.body));
  assert.equal(put.swapRecord, undefined);
  assert.deepEqual(put.record, { $type: 'app.bsky.actor.profile', description: 'Hello' });
});

test('Bluesky refuses links and says when the profile changed in between', async () => {
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', session],
        ['GET https://bsky.social/xrpc/com.atproto.repo.getRecord', () => Response.json({ cid: 'c', value: {} })],
        ['POST https://bsky.social/xrpc/com.atproto.repo.putRecord', () => Response.json({ error: 'InvalidSwap' }, { status: 400 })],
      ],
      [],
    ),
  });
  await assert.rejects(bluesky.editProfile({ links: [] }), /no links/);
  await assert.rejects(bluesky.editProfile({ bio: 'x' }), /changed while it was being edited/);
});

test('Bluesky reads the public profile: name, description, picture and banner', async () => {
  const bluesky = new Bluesky({
    identifier: 'me.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch([['GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile', () => Response.json({ displayName: 'José', description: 'Bio', avatar: 'https://cdn.bsky.app/a.jpg' })]], []),
  });
  assert.deepEqual(await bluesky.profile(), { displayName: 'José', bio: 'Bio', links: [], hasAvatar: true, hasBanner: false });
});

const telegramRules = (member: unknown, calls: Call[], extra: Array<[string, () => Response]> = []) =>
  fakeFetch(
    [
      ...extra,
      // getChatMember first: the rules match by prefix, and getChat is a prefix of it
      ['POST https://api.telegram.org/botT/getChatMember', () => Response.json({ ok: true, result: member })],
      ['POST https://api.telegram.org/botT/getChat', () => Response.json({ ok: true, result: { title: 'Shipcast news', description: 'Releases', username: 'shipnews', photo: { small_file_id: 'f' } } })],
      ['POST https://api.telegram.org/botT/getMe', () => Response.json({ ok: true, result: { id: 42, username: 'bot' } })],
    ],
    calls,
  );

test('Telegram reads the channel and whether the bot may change its info', async () => {
  const calls: Call[] = [];
  const allowed = new Telegram({ botToken: 'T', chatId: '@shipnews', fetch: telegramRules({ status: 'administrator', can_change_info: true }, calls) });
  assert.deepEqual(await allowed.profile(), {
    displayName: 'Shipcast news',
    bio: 'Releases',
    links: [{ name: 'Link', value: 'https://t.me/shipnews' }],
    hasAvatar: true,
    editable: { ok: true },
  });
  assert.deepEqual(JSON.parse(String(calls.at(-1)!.body)), { chat_id: '@shipnews', user_id: 42 });
  const refused = new Telegram({ botToken: 'T', chatId: '@shipnews', fetch: telegramRules({ status: 'administrator', can_change_info: false }, []) });
  const profile = await refused.profile();
  assert.equal(profile.editable?.ok, false);
});

test('Telegram sets the title and the description; one already so is not a failure', async () => {
  const calls: Call[] = [];
  const telegram = new Telegram({
    botToken: 'T',
    chatId: '@shipnews',
    fetch: fakeFetch(
      [
        ['POST https://api.telegram.org/botT/setChatTitle', () => Response.json({ ok: true, result: true })],
        ['POST https://api.telegram.org/botT/setChatDescription', () => Response.json({ ok: false, description: 'Bad Request: chat description is not modified' }, { status: 400 })],
      ],
      calls,
    ),
  });
  await telegram.editProfile({ displayName: 'New title', bio: 'Releases' });
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), { chat_id: '@shipnews', title: 'New title' });
  assert.deepEqual(JSON.parse(String(calls[1]!.body)), { chat_id: '@shipnews', description: 'Releases' });
  await assert.rejects(telegram.editProfile({ displayName: ' ' }), /cannot be empty/);
  await assert.rejects(telegram.editProfile({ links: [] }), /username/);
});

test('Telegram says which admin right the bot is missing', async () => {
  const telegram = new Telegram({
    botToken: 'T',
    chatId: '@shipnews',
    fetch: fakeFetch([['POST https://api.telegram.org/botT/setChatTitle', () => Response.json({ ok: false, description: 'Bad Request: not enough rights to change chat title' }, { status: 400 })]], []),
  });
  await assert.rejects(telegram.editProfile({ displayName: 'x' }), /Change channel info/);
});

test('dev.to reads the profile, with its website and location as links', async () => {
  const devto = new Devto({
    apiKey: 'k',
    fetch: fakeFetch(
      [['GET https://dev.to/api/users/me', () => Response.json({ username: 'me', name: 'José', summary: 'Builder', website_url: 'https://example.dev', location: null, profile_image: 'https://media.dev.to/a.png' })]],
      [],
    ),
  });
  assert.deepEqual(await devto.profile(), { displayName: 'José', bio: 'Builder', links: [{ name: 'Website', value: 'https://example.dev' }], hasAvatar: true });
});
