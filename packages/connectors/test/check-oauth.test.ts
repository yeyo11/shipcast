import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Bluesky,
  Brevo,
  checkProblem,
  ConnectorError,
  Devto,
  exchangeInstagramCode,
  exchangeMastodonCode,
  Instagram,
  instagramAuthorizeUrl,
  Mastodon,
  mastodonAuthorizeUrl,
  registerMastodonApp,
} from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

test('a failed check is said in words, not as a status code', () => {
  assert.match((checkProblem(new ConnectorError('dev.to', 'x', 401)) as { problem: string }).problem, /rejected the credential/);
  assert.match((checkProblem(new ConnectorError('dev.to', 'x', 403)) as { problem: string }).problem, /lacks a permission/);
  assert.match((checkProblem(new ConnectorError('dev.to', 'x', 503)) as { problem: string }).problem, /having trouble/);
  assert.match((checkProblem(new TypeError('fetch failed')) as { problem: string }).problem, /could not reach/);
});

test('each connector checks its credential with one read', async () => {
  const calls: Call[] = [];
  const devto = new Devto({ apiKey: 'k', fetch: fakeFetch([['GET https://dev.to/api/users/me', () => Response.json({ username: 'yeyo11' })]], calls) });
  assert.deepEqual(await devto.check(), { ok: true, account: '@yeyo11' });

  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch([['GET https://mastodon.social/api/v1/accounts/verify_credentials', () => Response.json({ acct: 'yeyo11' })]], calls),
  });
  assert.deepEqual(await mastodon.check(), { ok: true, account: '@yeyo11@mastodon.social' });

  const bluesky = new Bluesky({
    identifier: 'yeyo11.bsky.social',
    appPassword: 'p',
    fetch: fakeFetch([['POST https://bsky.social/xrpc/com.atproto.server.createSession', () => new Response('{"error":"AuthenticationRequired"}', { status: 401 })]], calls),
  });
  const failed = await bluesky.check();
  assert.equal(failed.ok, false);

  const brevo = new Brevo({ apiKey: 'k', fetch: fakeFetch([['GET https://api.brevo.com/v3/account', () => Response.json({ email: 'me@example.com' })]], calls) });
  assert.deepEqual(await brevo.check(), { ok: true, account: 'me@example.com' });
});

test('an Instagram token for another account fails its check', async () => {
  const make = (userId: string) =>
    new Instagram({
      userId,
      accessToken: 't',
      fetch: fakeFetch([['GET https://graph.instagram.com/v25.0/me?', () => Response.json({ user_id: '178', id: '99', username: 'yeyo11dev' })]], []),
    });
  assert.deepEqual(await make('178').check(), { ok: true, account: '@yeyo11dev' });
  assert.equal((await make('555').check()).ok, false);
});

test('Mastodon: the app is registered on the instance, then the code becomes a token', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://mastodon.social/api/v1/apps', () => Response.json({ client_id: 'cid', client_secret: 'cs' })],
      ['POST https://mastodon.social/oauth/token', () => Response.json({ access_token: 'tok' })],
    ],
    calls,
  );
  const app = await registerMastodonApp('https://mastodon.social/', 'https://app.example/auth/mastodon/callback', http);
  assert.deepEqual(app, { clientId: 'cid', clientSecret: 'cs' });
  assert.equal(JSON.parse(String(calls[0]!.body)).redirect_uris, 'https://app.example/auth/mastodon/callback');

  const url = new URL(mastodonAuthorizeUrl('https://mastodon.social', 'cid', 'https://app.example/cb', 'st'));
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('state'), 'st');
  assert.match(url.searchParams.get('scope') ?? '', /write:media/);

  assert.equal(await exchangeMastodonCode('https://mastodon.social', app, 'https://app.example/cb', 'code', http), 'tok');
  assert.equal(new URLSearchParams(String(calls[1]!.body)).get('grant_type'), 'authorization_code');
});

test('Instagram: the code becomes a long-lived token in two steps', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://api.instagram.com/oauth/access_token', () => Response.json({ access_token: 'short', user_id: 178 })],
      ['GET https://graph.instagram.com/access_token?', () => Response.json({ access_token: 'long', expires_in: 5_184_000 })],
    ],
    calls,
  );
  const url = new URL(instagramAuthorizeUrl('app', 'https://app.example/auth/instagram/callback', 'st'));
  assert.match(url.searchParams.get('scope') ?? '', /instagram_business_manage_comments/);

  const token = await exchangeInstagramCode({ appId: 'app', appSecret: 'sec' }, 'https://app.example/auth/instagram/callback', 'abc#_', http);
  assert.deepEqual(token, { userId: '178', accessToken: 'long', expiresIn: 5_184_000 });
  assert.equal((calls[0]!.body as FormData).get('code'), 'abc', 'the #_ Instagram appends is dropped');
  assert.equal(new URL(calls[1]!.url).searchParams.get('grant_type'), 'ig_exchange_token');
});

test('Instagram: a Business Login answer inside data is read too', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['POST https://api.instagram.com/oauth/access_token', () => Response.json({ data: [{ access_token: 'short', user_id: '178', permissions: 'instagram_business_basic' }] })],
      ['GET https://graph.instagram.com/access_token?', () => Response.json({ access_token: 'long', expires_in: 5_184_000 })],
    ],
    calls,
  );
  const token = await exchangeInstagramCode({ appId: 'app', appSecret: 'sec' }, 'https://app.example/cb', 'abc', http);
  assert.deepEqual(token, { userId: '178', accessToken: 'long', expiresIn: 5_184_000 });
  assert.equal(new URL(calls[1]!.url).searchParams.get('access_token'), 'short');
});
