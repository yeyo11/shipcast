import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorError, exchangeFacebookCode, facebookDialogUrl, listPages, longLivedUserToken, tokenlessProblem, unifiedAccess } from '../src/index.ts';
import { type Call, fakeFetch, sequence } from './fake.ts';

const app = { appId: '1', appSecret: 'shh' };
const reply = (body: string, status = 200) => () => new Response(body, { status });

test('the dialog asks by configuration, never by scope', () => {
  const url = new URL(facebookDialogUrl({ appId: '1', configId: '42' }, 'https://x/auth/instagram/callback', 's'));
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v27.0/dialog/oauth');
  assert.equal(url.searchParams.get('config_id'), '42');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.has('scope'), false);
});

test('the code is exchanged by GET on graph.facebook.com', async () => {
  const calls: Call[] = [];
  const http = fakeFetch([['GET https://graph.facebook.com/v27.0/oauth/access_token', reply('{"access_token":"t","token_type":"bearer","expires_in":5183944}')]], calls);
  const token = await exchangeFacebookCode(app, 'https://x/cb', 'c0de', http);
  assert.deepEqual(token, { accessToken: 't', expiresIn: 5183944 });
  const url = new URL(calls[0]!.url);
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(url.pathname, '/v27.0/oauth/access_token');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['client_id', 'client_secret', 'code', 'redirect_uri']);
});

test('a token without expires_in has no expiry', async () => {
  const http = fakeFetch([['GET https://graph.facebook.com/', reply('{"access_token":"t","token_type":"bearer"}')]], []);
  assert.deepEqual(await exchangeFacebookCode(app, 'https://x/cb', 'c', http), { accessToken: 't', expiresIn: undefined });
});

test('the long-lived token is an fb_exchange_token grant', async () => {
  const calls: Call[] = [];
  const http = fakeFetch([['GET https://graph.facebook.com/v27.0/oauth/access_token', reply('{"access_token":"long","expires_in":100}')]], calls);
  assert.deepEqual(await longLivedUserToken(app, 'short', http), { accessToken: 'long', expiresIn: 100 });
  const params = new URL(calls[0]!.url).searchParams;
  assert.equal(params.get('grant_type'), 'fb_exchange_token');
  assert.equal(params.get('fb_exchange_token'), 'short');
});

test('unified access reads the business and its Instagram accounts, ids as text', async () => {
  const calls: Call[] = [];
  const http = fakeFetch(
    [
      ['GET https://graph.facebook.com/v27.0/oauth/access_token', reply('{"access_token":"bisu"}')],
      ['GET https://graph.facebook.com/v27.0/me/assigned_instagram_accounts', reply('{"data":[{"id":"17841416971174401","username":"me"}]}')],
      ['GET https://graph.facebook.com/v27.0/me?', reply('{"client_business_id":"123","id":"9"}')],
    ],
    calls,
  );
  const access = await unifiedAccess(app, 'https://x/cb', 'c', http);
  assert.deepEqual(access.instagram, [{ id: '17841416971174401', username: 'me' }]);
  assert.equal(access.businessId, '123');
  assert.equal(access.accessToken, 'bisu');
  assert.ok(calls.slice(1).every((c) => new URL(c.url).searchParams.get('access_token') === 'bisu'));
});

test('listPages follows paging.next and keeps each Page token and its Instagram account', async () => {
  const calls: Call[] = [];
  const next = 'https://graph.facebook.com/v27.0/me/accounts?after=abc&access_token=ut';
  const http = fakeFetch(
    [
      [`GET ${next}`, reply('{"data":[{"id":"2","name":"B","access_token":"pt2"}]}')],
      [
        'GET https://graph.facebook.com/v27.0/me/accounts',
        reply(JSON.stringify({ data: [{ id: '17841400000000001', name: 'A', access_token: 'pt1', instagram_business_account: { id: '17841416971174402', username: 'a' } }], paging: { next } })),
      ],
    ],
    calls,
  );
  const { pages, tokenless } = await listPages('ut', http);
  assert.deepEqual(tokenless, []);
  assert.deepEqual(pages.map((p) => [p.pageId, p.pageToken, p.instagram?.id]), [['17841400000000001', 'pt1', '17841416971174402'], ['2', 'pt2', undefined]]);
  assert.match(decodeURIComponent(calls[0]!.url), /fields=id,name,access_token,instagram_business_account\{id,username\}/);
});

test('a Page that came without its token is left out and named, and the others still come', async () => {
  const http = fakeFetch(
    [
      [
        'GET https://graph.facebook.com/v27.0/me/accounts',
        reply(
          JSON.stringify({
            data: [
              { id: '100000000000001', name: 'Mine', access_token: 'pt1' },
              { id: '100000000000002', name: 'Agency', instagram_business_account: { id: '17841416971174402' } },
              { id: '100000000000003', name: 'Plain' },
            ],
          }),
        ),
      ],
    ],
    [],
  );
  const { pages, tokenless } = await listPages('ut', http);
  assert.deepEqual(pages.map((p) => p.pageId), ['100000000000001']);
  assert.deepEqual(tokenless, [{ name: 'Agency', instagram: true }, { name: 'Plain', instagram: false }]);
  assert.match(tokenlessProblem(['Agency']), /no Page token for “Agency”.*that Page.*it was left out/);
  assert.match(tokenlessProblem(['Agency', 'Plain']), /“Agency”, “Plain”.*those Pages.*they were left out/);
});

test('a Unified Login configuration that issues a user token is told to issue a system-user one', async () => {
  const http = fakeFetch(
    [
      ['GET https://graph.facebook.com/v27.0/oauth/access_token', reply('{"access_token":"user"}')],
      ['GET https://graph.facebook.com/v27.0/me?', reply('{"id":"9"}')],
    ],
    [],
  );
  await assert.rejects(
    () => unifiedAccess(app, 'https://x/cb', 'c', http),
    (e: unknown) => e instanceof ConnectorError && /issued a user token/.test(e.message) && /system-user \(business integration\) token/.test(e.message),
  );
});

test('an id that is a number is refused', async () => {
  const http = fakeFetch([['GET ', reply('{"data":[{"id":17841400000000001,"name":"A","access_token":"p"}]}')]], []);
  await assert.rejects(() => listPages('ut', http), ConnectorError);
});

test("a refused exchange says Meta's own message", async () => {
  const http = fakeFetch([['GET ', sequence(reply('{"error":{"message":"Invalid verification code"}}', 400))]], []);
  await assert.rejects(() => exchangeFacebookCode(app, 'https://x/cb', 'bad', http), (e: unknown) => e instanceof ConnectorError && /Invalid verification code/.test(e.message) && e.network === 'Meta');
});
