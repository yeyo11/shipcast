import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Published } from '@shipcast/connectors';
import type { PublishContext, TextPostPublisher } from '@shipcast/engine';
import { Brand, type LinkTracking } from '@shipcast/schema';
import { buildConnector, networkOf, oauthSpecOf, type OAuthSpec, type SettingsValues } from '../src/index.ts';
import { facebookAdapter } from '../src/channels/facebook.ts';

/*
 * Facebook Pages: Facebook Login for Business on the Meta app gives one account per Page the owner
 * shares, each with its own Page token; a launch's post links the article in the Page's language,
 * tagged as a visit from Facebook.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://example.test', github: 'someone', languages: { blog: ['en', 'es'], facebook: 'es' } });
const network = networkOf(facebookAdapter)!;
const spec = (): OAuthSpec => oauthSpecOf(network, {} as SettingsValues)!.spec;

/** A fetch that answers by URL prefix and records every call, with its form body */
function recording(routes: Array<[string, unknown]>, calls: Array<{ url: string; body?: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.body !== undefined && { body: String(init.body) }) });
    const route = routes.find(([prefix]) => url.startsWith(prefix));
    if (!route) return new Response(JSON.stringify({ error: { message: `unexpected ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(route[1]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

const loginRoutes = (pages: unknown[]): Array<[string, unknown]> => [
  ['https://graph.facebook.com/v27.0/oauth/access_token?', { access_token: 'user-token', expires_in: 5000 }],
  ['https://graph.facebook.com/v27.0/me/accounts?', { data: pages }],
];

test('the sign-in is the Meta app with the Facebook configuration, and its tokens are never refreshed', () => {
  const oauth = spec();
  assert.deepEqual(oauth.app, { id: 'meta', term: 'app', name: 'Meta' });
  assert.equal(oauth.config, 'facebookConfigId');
  assert.deepEqual(oauth.errorParams, ['error_description', 'error_reason', 'error_message']);
  assert.equal(network.refresh, undefined);
  const url = new URL(oauth.authorizeUrl({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/auth/facebook/callback', 'st'));
  assert.equal(url.host, 'www.facebook.com');
  assert.equal(url.searchParams.get('config_id'), 'cfg1');
  assert.throws(() => oauth.authorizeUrl({ clientId: 'app1', clientSecret: 's' }, 'https://example.test/auth/facebook/callback', 'st'), /configuration id/);
});

test('a sign-in sharing two Pages makes two accounts, each with its own Page token', async () => {
  const http = recording(
    loginRoutes([
      { id: '100000000000001', name: 'First Page', access_token: 'pt1' },
      { id: '100000000000002', name: 'Second Page', access_token: 'pt2', instagram_business_account: { id: '17841416971174401' } },
    ]),
    [],
  );
  const accounts = await spec().exchange({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/auth/facebook/callback', 'code', http);
  assert.deepEqual(accounts, [
    { label: 'First Page', credentials: { settings: { pageId: '100000000000001' }, secrets: { accessToken: 'pt1' } } },
    { label: 'Second Page', credentials: { settings: { pageId: '100000000000002' }, secrets: { accessToken: 'pt2' } } },
  ]);
});

test('a sign-in that shares no Page says so', async () => {
  const http = recording(loginRoutes([]), []);
  await assert.rejects(spec().exchange({ clientId: 'app1', clientSecret: 's', configId: 'cfg1' }, 'https://example.test/auth/facebook/callback', 'code', http), /no Facebook Page/);
});

test("the publisher hands the Page a link tagged as a visit from Facebook, the launch's campaign", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const http = recording(
    [
      ['https://graph.facebook.com/v27.0/100000000000001/feed', { id: '100000000000001_200' }],
      ['https://graph.facebook.com/v27.0/100000000000001_200?', { permalink_url: 'https://www.facebook.com/100000000000001/posts/200' }],
    ],
    calls,
  );
  const connection = buildConnector('facebook', { settings: { pageId: '100000000000001' }, secrets: { accessToken: 'pt1' } }, brand, http);
  const publisher = facebookAdapter.publisher(connection.connector as never) as TextPostPublisher;
  const tracking: LinkTracking = { site: 'https://example.test', campaign: 'claudio-v1-0-0' };
  await publisher.publish({ text: 'A post', link: 'https://example.test/es/hola/?ref=facebook', imageUrl: 'https://example.test/og.jpg' }, tracking);
  const body = new URLSearchParams(calls[0]!.body);
  const link = new URL(body.get('link')!);
  assert.equal(link.origin + link.pathname, 'https://example.test/es/hola/');
  assert.equal(link.searchParams.get('utm_source'), 'facebook');
  assert.equal(link.searchParams.get('utm_medium'), 'social');
  assert.equal(link.searchParams.get('utm_campaign'), 'claudio-v1-0-0');
  assert.equal(link.searchParams.get('ref'), null);
  assert.equal(body.get('message'), 'A post');
});

test("a launch's post links the article in the Page's language, and hands the publisher the launch's tracking", async () => {
  const pack = {
    schemaVersion: 1,
    kind: 'launch',
    project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v1.0.0' },
    analysis: { summary: 's', implemented: ['x'], planned: [], documentedOnly: [], limitations: [] },
    article: { en: { slug: 'hello', title: 'T', description: 'D', markdown: 'B' }, es: { slug: 'hola', title: 'T', description: 'D', markdown: 'B' } },
    facebook: { text: 'Una publicación' },
  };
  const tracking: LinkTracking = { site: brand.site, campaign: 'claudio-v1-0-0' };
  const context = {
    pack,
    brand,
    dir: 'launches/claudio/v1.0.0',
    read: async () => undefined,
    articleUrl: 'https://example.test/en/hello/',
    tracking,
    mediaUrl: (file: string) => `https://example.test/media/${file}`,
  } as unknown as PublishContext;
  const sent: Array<{ post: { text: string; link: string; imageUrl: string }; tracking: LinkTracking | undefined }> = [];
  const publisher: TextPostPublisher = {
    publish: async (post, t): Promise<Published> => {
      sent.push({ post, tracking: t });
      return { externalId: '1', url: 'https://www.facebook.com/1' };
    },
  };
  const run = facebookAdapter.strategy!.run(context, publisher);
  assert.ok(run, 'a pack with a Facebook piece publishes it');
  await run();
  assert.deepEqual(sent, [{ post: { text: 'Una publicación', link: 'https://example.test/es/hola/?ref=facebook', imageUrl: 'https://example.test/media/og.jpg' }, tracking }]);

  // A brand whose Page language the pack lacks links the lead article, as every channel does
  const english = Brand.parse({ ...brand, languages: { blog: ['en', 'es'], facebook: 'fr' } });
  sent.length = 0;
  await facebookAdapter.strategy!.run({ ...context, brand: english }, publisher)!();
  assert.equal(sent[0]!.post.link, 'https://example.test/en/hello/?ref=facebook');
});
