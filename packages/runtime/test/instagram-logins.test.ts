import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Brand } from '@shipcast/schema';
import { buildConnector, isVariants, NETWORK_SPECS, networkOf, oauthSpecOf, oauthSpecsOf, type SettingsValues } from '../src/index.ts';
import { instagramAdapter, instagramLoginOf } from '../src/channels/instagram.ts';

/*
 * Instagram signs in through Instagram Login (the owner's account since before) or Unified Login (a
 * new Meta app can no longer set up the first). Each account keeps the login it was connected with,
 * whatever Settings says now.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.test', github: 'someone', languages: { blog: ['en'] } });
const network = networkOf(instagramAdapter)!;

/** A fetch that answers by URL prefix and records every URL asked */
function recording(routes: Array<[string, unknown]>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(route[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('an account connected before keeps graph.instagram.com and its 30-day refresh', async () => {
  const settings = { userId: '17841416971174400', refreshedAt: '2026-10-24T00:00:00Z' };
  assert.equal(instagramLoginOf(settings), 'instagram');
  assert.ok(network.refresh!.refresher(settings, 't'));
  const calls: string[] = [];
  const http = recording([['https://graph.instagram.com/v25.0/me?', { user_id: '17841416971174400', id: '1', username: 'someone' }]], calls);
  const built = buildConnector('instagram', { settings, secrets: { accessToken: 't' } }, brand, http);
  const check = await built.check();
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.startsWith('https://graph.instagram.com/v25.0/me?'), calls[0]);
});

test('a unified account reads graph.facebook.com and is never refreshed', async () => {
  const settings = { login: 'unified', userId: '17841416971174401', businessId: '123' };
  assert.equal(instagramLoginOf(settings), 'unified');
  assert.equal(network.refresh!.refresher(settings, 't'), undefined);
  const calls: string[] = [];
  const http = recording([['https://graph.facebook.com/v27.0/17841416971174401?', { id: '17841416971174401', username: 'someone' }]], calls);
  const built = buildConnector('instagram', { settings, secrets: { accessToken: 't' } }, brand, http);
  const check = await built.check();
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.startsWith('https://graph.facebook.com/v27.0/17841416971174401?'), calls[0]);
});

test('switching the setting leaves existing accounts on their own login', async () => {
  const chosen = oauthSpecOf(network, { instagramLogin: 'unified' } as SettingsValues);
  assert.equal(chosen?.variant, 'unified');
  const settings = { userId: '17841416971174400', refreshedAt: '2026-10-24T00:00:00Z' };
  assert.equal(instagramLoginOf(settings), 'instagram');
  assert.ok(network.refresh!.refresher(settings, 't'));
  const calls: string[] = [];
  const http = recording([['https://graph.instagram.com/v25.0/me?', { user_id: '17841416971174400', id: '1', username: 'someone' }]], calls);
  await buildConnector('instagram', { settings, secrets: { accessToken: 't' } }, brand, http).check();
  assert.ok(calls[0]!.startsWith('https://graph.instagram.com/'), calls[0]);
});

test('the setting offers Instagram Login, the fallback, and Unified Login on the Meta app', () => {
  const oauth = network.oauth!;
  assert.ok(isVariants(oauth));
  assert.equal(oauth.setting, 'instagramLogin');
  assert.equal(oauth.fallback, 'instagram');
  assert.deepEqual(oauth.variants.instagram?.app, { id: 'instagram', term: 'app', name: 'Instagram' });
  assert.equal(oauth.variants.instagram?.label, 'Instagram Login');
  assert.deepEqual(oauth.variants.unified?.app, { id: 'meta', term: 'app', name: 'Meta' });
  assert.equal(oauth.variants.unified?.config, 'instagramConfigId');
  assert.equal(oauth.variants.unified?.label, 'Unified Login');
});

test('Unified Login asks by configuration and fails clearly without one', () => {
  const unified = oauthSpecOf(network, { instagramLogin: 'unified' } as SettingsValues)!.spec;
  const url = new URL(unified.authorizeUrl({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/callback', 'st'));
  assert.equal(url.host, 'www.facebook.com');
  assert.equal(url.searchParams.get('config_id'), 'cfg1');
  assert.equal(url.searchParams.get('client_id'), 'app1');
  assert.throws(() => unified.authorizeUrl({ clientId: 'app1', clientSecret: 's' }, 'https://example.test/callback', 'st'), /configuration id/);
});

const unifiedRoutes = (accounts: unknown[]): Array<[string, unknown]> => [
  ['https://graph.facebook.com/v27.0/oauth/access_token?', { access_token: 'system-user-token' }],
  ['https://graph.facebook.com/v27.0/me/assigned_instagram_accounts?', { data: accounts }],
  ['https://graph.facebook.com/v27.0/me?', { client_business_id: '123' }],
];

test('unified sign-in makes one account per Instagram account shared', async () => {
  const unified = oauthSpecOf(network, { instagramLogin: 'unified' } as SettingsValues)!.spec;
  const calls: string[] = [];
  const http = recording(unifiedRoutes([{ id: '17841416971174401', username: 'first' }, { id: '17841416971174402' }]), calls);
  const accounts = await unified.exchange({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/callback', 'code', http);
  assert.deepEqual(accounts, [
    { label: '@first', credentials: { settings: { login: 'unified', userId: '17841416971174401', businessId: '123' }, secrets: { accessToken: 'system-user-token' } } },
    { label: '17841416971174402', credentials: { settings: { login: 'unified', userId: '17841416971174402', businessId: '123' }, secrets: { accessToken: 'system-user-token' } } },
  ]);
});

test('unified sign-in with no Instagram account shared says so', async () => {
  const unified = oauthSpecOf(network, { instagramLogin: 'unified' } as SettingsValues)!.spec;
  const http = recording(unifiedRoutes([]), []);
  await assert.rejects(unified.exchange({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/callback', 'code', http), /no Instagram professional account/);
});

test('a facebook account reads graph.facebook.com and is never refreshed', async () => {
  const settings = { login: 'facebook', userId: '17841416971174401', pageId: '100000000000001' };
  assert.equal(instagramLoginOf(settings), 'facebook');
  assert.equal(network.refresh!.refresher(settings, 't'), undefined);
  const calls: string[] = [];
  const http = recording([['https://graph.facebook.com/v27.0/17841416971174401?', { id: '17841416971174401', username: 'someone' }]], calls);
  const built = buildConnector('instagram', { settings, secrets: { accessToken: 't' } }, brand, http);
  const check = await built.check();
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.startsWith('https://graph.facebook.com/v27.0/17841416971174401?'), calls[0]);
});

const facebookRoutes = (pages: unknown[]): Array<[string, unknown]> => [
  ['https://graph.facebook.com/v27.0/oauth/access_token?', { access_token: 'user-token', expires_in: 5000 }],
  ['https://graph.facebook.com/v27.0/me/accounts?', { data: pages }],
];

test('the setting offers Facebook Login on the Meta app and its configuration', () => {
  const oauth = network.oauth!;
  assert.ok(isVariants(oauth));
  assert.deepEqual(oauth.variants.facebook?.app, { id: 'meta', term: 'app', name: 'Meta' });
  assert.equal(oauth.variants.facebook?.config, 'instagramConfigId');
  assert.equal(oauth.variants.facebook?.label, 'Facebook Login (Instagram linked to a Page)');
});

test('facebook sign-in keeps one account per Page with Instagram, with the Page token', async () => {
  const facebook = oauthSpecOf(network, { instagramLogin: 'facebook' } as SettingsValues)!.spec;
  const http = recording(
    facebookRoutes([
      { id: '100000000000001', name: 'First', access_token: 'pt1', instagram_business_account: { id: '17841416971174401', username: 'first' } },
      { id: '100000000000002', name: 'Second', access_token: 'pt2' },
    ]),
    [],
  );
  const accounts = await facebook.exchange({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/callback', 'code', http);
  assert.deepEqual(accounts, [
    { label: '@first', credentials: { settings: { login: 'facebook', userId: '17841416971174401', pageId: '100000000000001' }, secrets: { accessToken: 'pt1' } } },
  ]);
});

test('Pages with no Instagram account say what to link', async () => {
  const facebook = oauthSpecOf(network, { instagramLogin: 'facebook' } as SettingsValues)!.spec;
  const http = recording(facebookRoutes([{ id: '100000000000002', name: 'Second', access_token: 'pt2' }]), []);
  await assert.rejects(
    facebook.exchange({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/callback', 'code', http),
    /none of the Pages you shared has an Instagram professional account linked/,
  );
});

test('Facebook Login asks by configuration and fails clearly without one', () => {
  const facebook = oauthSpecOf(network, { instagramLogin: 'facebook' } as SettingsValues)!.spec;
  const url = new URL(facebook.authorizeUrl({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/callback', 'st'));
  assert.equal(url.searchParams.get('config_id'), 'cfg1');
  assert.throws(() => facebook.authorizeUrl({ clientId: 'app1', clientSecret: 's' }, 'https://example.test/callback', 'st'), /configuration id/);
});

test('every spec that shares an app agrees on what the app is called', () => {
  const apps = new Map<string, { term: string; name: string }>();
  for (const spec of NETWORK_SPECS.flatMap((n) => oauthSpecsOf(n))) {
    const seen = apps.get(spec.app.id);
    if (seen) assert.deepEqual({ term: spec.app.term, name: spec.app.name }, seen, `the ${spec.app.id} app`);
    else apps.set(spec.app.id, { term: spec.app.term, name: spec.app.name });
  }
  assert.ok(apps.has('meta'));
});
