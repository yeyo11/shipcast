import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, Brevo, ConnectorError, Devto, Instagram, linkFacets, Mastodon } from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

test('dev.to publishes the article as published, tagged, with the blog as canonical URL', async () => {
  const calls: Call[] = [];
  const devto = new Devto({
    apiKey: 'k',
    fetch: fakeFetch([['POST https://dev.to/api/articles', () => Response.json({ id: 42, url: 'https://dev.to/yeyo11/claudio-1a2b' }, { status: 201 })]], calls),
  });
  const published = await devto.publish({
    title: 'claudio',
    markdown: 'Body',
    tags: ['claude', 'ai'],
    canonicalUrl: 'https://josegarrido.dev/en/claudio/',
    mainImage: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.jpg',
  });
  assert.deepEqual(published, { externalId: '42', url: 'https://dev.to/yeyo11/claudio-1a2b' });
  assert.equal(calls[0]!.headers['api-key'], 'k');
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), {
    article: {
      title: 'claudio',
      body_markdown: 'Body',
      published: true,
      tags: ['claude', 'ai'],
      canonical_url: 'https://josegarrido.dev/en/claudio/',
      main_image: 'https://josegarrido.dev/launches/claudio/v0.8.2/og.jpg',
    },
  });
});

test('dev.to reads views from the author list, paging until the article appears', async () => {
  const calls: Call[] = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i, page_views_count: 0, public_reactions_count: 0, comments_count: 0 }));
  const devto = new Devto({
    apiKey: 'k',
    fetch: fakeFetch(
      [
        ['GET https://dev.to/api/articles/me/all?per_page=100&page=1', () => Response.json(page1)],
        ['GET https://dev.to/api/articles/me/all?per_page=100&page=2', () => Response.json([{ id: 4242, page_views_count: 310, public_reactions_count: 12, comments_count: 3 }])],
      ],
      calls,
    ),
  });
  assert.deepEqual(await devto.metrics('4242'), { views: 310, reactions: 12, comments: 3 });
  assert.equal(calls.length, 2);
});

test('a refused request is a ConnectorError that says it will not pass on a retry', async () => {
  const devto = new Devto({ apiKey: 'bad', fetch: fakeFetch([['POST', () => new Response('{"error":"unauthorized"}', { status: 401 })]], []) });
  await assert.rejects(
    devto.publish({ title: 't', markdown: 'm', tags: [], canonicalUrl: 'https://x.dev/' }),
    (e) => e instanceof ConnectorError && e.status === 401 && !e.retryable && /dev\.to: publish: 401/.test(e.message),
  );
});

test('Bluesky link facets count UTF-8 bytes, so accents and emoji before a link do not shift it', () => {
  const text = 'Lanzado 🚀 claudio: https://josegarrido.dev/es/claudio/?ref=bluesky.';
  const [facet] = linkFacets(text);
  const bytes = new TextEncoder().encode(text);
  const linked = new TextDecoder().decode(bytes.slice(facet!.index.byteStart, facet!.index.byteEnd));
  assert.equal(linked, 'https://josegarrido.dev/es/claudio/?ref=bluesky', 'the trailing period is not part of the link');
  assert.deepEqual(facet!.features, [{ $type: 'app.bsky.richtext.facet#link', uri: linked }]);
});

test('Bluesky logs in once, uploads the card image and posts with facets, language and card', async () => {
  const calls: Call[] = [];
  const bluesky = new Bluesky({
    identifier: 'yeyo11.bsky.social',
    appPassword: 'pw',
    fetch: fakeFetch(
      [
        ['POST https://bsky.social/xrpc/com.atproto.server.createSession', () => Response.json({ did: 'did:plc:abc', handle: 'yeyo11.bsky.social', accessJwt: 'jwt' })],
        ['POST https://bsky.social/xrpc/com.atproto.repo.uploadBlob', () => Response.json({ blob: { ref: 'b1' } })],
        ['POST https://bsky.social/xrpc/com.atproto.repo.createRecord', () => Response.json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', cid: 'c' })],
      ],
      calls,
    ),
  });
  const published = await bluesky.publish({
    text: 'claudio is out https://josegarrido.dev/en/claudio/?ref=bluesky',
    lang: 'en',
    link: { url: 'https://josegarrido.dev/en/claudio/', title: 'claudio', description: 'd', thumb: { bytes: new Uint8Array([1]), mimeType: 'image/jpeg' } },
  });
  assert.deepEqual(published, { externalId: 'at://did:plc:abc/app.bsky.feed.post/3kxyz', url: 'https://bsky.app/profile/yeyo11.bsky.social/post/3kxyz' });
  const record = JSON.parse(String(calls[2]!.body)) as { repo: string; record: { langs: string[]; facets: unknown[]; embed: { external: { thumb: unknown } } } };
  assert.equal(record.repo, 'did:plc:abc');
  assert.deepEqual(record.record.langs, ['en']);
  assert.equal(record.record.facets.length, 1);
  assert.deepEqual(record.record.embed.external.thumb, { ref: 'b1' });
  assert.equal(calls[2]!.headers.authorization, 'Bearer jwt');
});

test('Bluesky metrics come from the public AppView, without logging in', async () => {
  const calls: Call[] = [];
  const bluesky = new Bluesky({
    identifier: 'x',
    appPassword: 'y',
    fetch: fakeFetch([['GET https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts', () => Response.json({ posts: [{ likeCount: 9, repostCount: 2, replyCount: 1 }] })]], calls),
  });
  assert.deepEqual(await bluesky.metrics('at://did:plc:abc/app.bsky.feed.post/3kxyz'), { likes: 9, reposts: 2, replies: 1, quotes: 0 });
  assert.equal(calls.length, 1);
});

test('Mastodon uploads the described image, then posts publicly with an idempotency key', async () => {
  const calls: Call[] = [];
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social/',
    accessToken: 'tok',
    fetch: fakeFetch(
      [
        ['POST https://mastodon.social/api/v2/media', () => Response.json({ id: 'm1' })],
        ['POST https://mastodon.social/api/v1/statuses', () => Response.json({ id: '111', url: 'https://mastodon.social/@yeyo11/111' })],
      ],
      calls,
    ),
  });
  const published = await mastodon.publish({
    text: 'claudio #claude',
    lang: 'en',
    image: { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'og.jpg', description: 'claudio launch image' },
    idempotencyKey: 'launch-7-mastodon',
  });
  assert.deepEqual(published, { externalId: '111', url: 'https://mastodon.social/@yeyo11/111' });
  assert.equal((calls[0]!.body as FormData).get('description'), 'claudio launch image');
  assert.equal(calls[1]!.headers['idempotency-key'], 'launch-7-mastodon');
  assert.deepEqual(JSON.parse(String(calls[1]!.body)), { status: 'claudio #claude', language: 'en', visibility: 'public', media_ids: ['m1'] });
});

test('Mastodon metrics read favourites, boosts and replies', async () => {
  const mastodon = new Mastodon({
    instance: 'https://mastodon.social',
    accessToken: 't',
    fetch: fakeFetch([['GET https://mastodon.social/api/v1/statuses/111', () => Response.json({ favourites_count: 4, reblogs_count: 2, replies_count: 1 })]], []),
  });
  assert.deepEqual(await mastodon.metrics('111'), { favourites: 4, boosts: 2, replies: 1 });
});

const G = 'https://graph.instagram.com/v25.0';

test('Instagram creates a Reel container, waits until it is processed, publishes and reads the permalink', async () => {
  const calls: Call[] = [];
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 'tok',
    pollMs: 1,
    sleep: async () => {},
    fetch: fakeFetch(
      [
        [`POST ${G}/1784/media_publish`, () => Response.json({ id: 'media-9' })],
        [`POST ${G}/1784/media`, () => Response.json({ id: 'container-1' })],
        [`GET ${G}/container-1`, sequence(() => Response.json({ status_code: 'IN_PROGRESS' }), () => Response.json({ status_code: 'FINISHED' }))],
        [`GET ${G}/media-9`, () => Response.json({ permalink: 'https://www.instagram.com/reel/abc/' })],
      ],
      calls,
    ),
  });
  const published = await instagram.publish({ caption: 'claudio. Link in bio.', media: { kind: 'reel', url: 'https://josegarrido.dev/launches/claudio/v0.8.2/demo.mp4' } });
  assert.deepEqual(published, { externalId: 'media-9', url: 'https://www.instagram.com/reel/abc/' });
  const created = new URLSearchParams(String(calls[0]!.body));
  assert.equal(created.get('media_type'), 'REELS');
  assert.equal(created.get('video_url'), 'https://josegarrido.dev/launches/claudio/v0.8.2/demo.mp4');
  assert.equal(created.get('caption'), 'claudio. Link in bio.');
  assert.equal(calls.filter((c) => c.url.startsWith(`${G}/container-1`)).length, 2, 'it waited for processing');
  assert.equal(new URLSearchParams(String(calls.find((c) => c.url.endsWith('/media_publish'))!.body)).get('creation_id'), 'container-1');
});

test('Instagram stops on a media it could not fetch, instead of publishing nothing', async () => {
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 'tok',
    sleep: async () => {},
    fetch: fakeFetch(
      [
        [`POST ${G}/1784/media`, () => Response.json({ id: 'c1' })],
        [`GET ${G}/c1`, () => Response.json({ status_code: 'ERROR' })],
      ],
      [],
    ),
  });
  await assert.rejects(instagram.publish({ caption: 'c', media: { kind: 'image', url: 'https://x.dev/og.jpg' } }), /could not be processed \(ERROR\); check that its URL is public/);
});

test('Instagram insights become plain numbers, and the token refreshes', async () => {
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 'tok',
    fetch: fakeFetch(
      [
        [`GET ${G}/media-9/insights`, () => Response.json({ data: [{ name: 'reach', values: [{ value: 120 }] }, { name: 'likes', total_value: { value: 14 } }] })],
        ['GET https://graph.instagram.com/refresh_access_token', () => Response.json({ access_token: 'new', expires_in: 5184000 })],
      ],
      [],
    ),
  });
  assert.deepEqual(await instagram.metrics('media-9'), { reach: 120, likes: 14 });
  assert.deepEqual(await instagram.refreshToken(), { accessToken: 'new', expiresIn: 5184000 });
});

test('Brevo creates the campaign for the list and sends it now; its numbers add up across languages', async () => {
  const calls: Call[] = [];
  const brevo = new Brevo({
    apiKey: 'k',
    fetch: fakeFetch(
      [
        ['GET https://api.brevo.com/v3/contacts/lists/3', () => Response.json({ uniqueSubscribers: 10, totalBlacklisted: 2 })],
        ['POST https://api.brevo.com/v3/emailCampaigns/77/sendNow', () => new Response(null, { status: 204 })],
        ['POST https://api.brevo.com/v3/emailCampaigns', () => Response.json({ id: 77 }, { status: 201 })],
        ['GET https://api.brevo.com/v3/emailCampaigns/77?statistics=globalStats', () => Response.json({ statistics: { globalStats: { sent: 8, delivered: 8, uniqueViews: 5, uniqueClicks: 2, unsubscriptions: 0, hardBounces: 0, softBounces: 1, complaints: 0 } } })],
        ['GET https://api.brevo.com/v3/emailCampaigns/78?statistics=globalStats', () => Response.json({ statistics: { globalStats: { sent: 4, delivered: 4, uniqueViews: 1, uniqueClicks: 1, unsubscriptions: 1, hardBounces: 0, softBounces: 0, complaints: 0 } } })],
      ],
      calls,
    ),
  });
  assert.equal(await brevo.subscribers(3), 8);
  const sent = await brevo.send({ name: 'claudio v0.8.2 (en)', subject: 's', previewText: 'p', html: '<p>hi</p>', sender: { name: 'Me', email: 'hola@josegarrido.dev' }, listId: 3 });
  assert.deepEqual(sent, { externalId: '77', url: 'https://app.brevo.com/marketing-campaign/report/77' });
  const created = JSON.parse(String(calls.find((c) => c.method === 'POST' && c.url.endsWith('/emailCampaigns'))!.body));
  assert.deepEqual(created.recipients, { listIds: [3] });
  assert.equal(created.htmlContent, '<p>hi</p>');
  assert.equal(calls[0]!.headers['api-key'], 'k');
  assert.deepEqual(await brevo.metrics('77,78'), { sent: 12, delivered: 12, opens: 6, clicks: 3, unsubscribes: 1, bounces: 1, complaints: 0 });
});

test('Brevo refusing to send leaves a draft and says not to retry, so no second campaign is made', async () => {
  const brevo = new Brevo({
    apiKey: 'k',
    fetch: fakeFetch(
      [
        ['POST https://api.brevo.com/v3/emailCampaigns/5/sendNow', () => Response.json({ code: 'not_enough_credits' }, { status: 503 })],
        ['POST https://api.brevo.com/v3/emailCampaigns', () => Response.json({ id: 5 }, { status: 201 })],
      ],
      [],
    ),
  });
  await assert.rejects(
    brevo.send({ name: 'n', subject: 's', previewText: 'p', html: '<p>hi</p>', sender: { name: 'Me', email: 'a@b.dev' }, listId: 1 }),
    (e: unknown) => e instanceof ConnectorError && !e.retryable && /left as a draft/.test(e.message),
  );
});
