import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bluesky, Brevo, ConnectorError, Devto, Instagram, linkFacets, Mastodon, richText } from '../src/index.ts';
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

test('Bluesky shows a link without its query while its facet keeps it whole: the tags cost no graphemes', () => {
  const tagged = 'https://josegarrido.dev/es/claudio/?utm_source=bluesky&utm_medium=social&utm_campaign=claudio-v1-0-0';
  const { text, facets } = richText(`Lanzado 🚀 claudio: ${tagged}. Y https://github.com/yeyo11/claudio`);
  assert.equal(text, 'Lanzado 🚀 claudio: https://josegarrido.dev/es/claudio/. Y https://github.com/yeyo11/claudio');
  const bytes = new TextEncoder().encode(text);
  const shown = facets.map((f) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd)));
  assert.deepEqual(shown, ['https://josegarrido.dev/es/claudio/', 'https://github.com/yeyo11/claudio'], 'each facet covers the link as shown');
  assert.deepEqual(
    facets.map((f) => f.features),
    [[{ $type: 'app.bsky.richtext.facet#link', uri: tagged }], [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://github.com/yeyo11/claudio' }]],
  );
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
  const record = JSON.parse(String(calls[2]!.body)) as { repo: string; record: { text: string; langs: string[]; facets: unknown[]; embed: { external: { uri: string; thumb: unknown } } } };
  assert.equal(record.repo, 'did:plc:abc');
  assert.equal(record.record.text, 'claudio is out https://josegarrido.dev/en/claudio/', 'the link shown without its query');
  assert.deepEqual((record.record.facets[0] as { features: Array<{ uri: string }> }).features[0]!.uri, 'https://josegarrido.dev/en/claudio/?ref=bluesky', 'the facet keeps the whole link');
  assert.equal(record.record.embed.external.uri, 'https://josegarrido.dev/en/claudio/');
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

test('Instagram publishes a single video as a Reel: a container, waited on until processed, then published, waits until it is processed, publishes and reads the permalink', async () => {
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
  const published = await instagram.publish({ caption: 'claudio. Link in bio.', media: [{ kind: 'video', url: 'https://josegarrido.dev/launches/claudio/v0.8.2/demo.mp4' }] });
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
  await assert.rejects(instagram.publish({ caption: 'c', media: [{ kind: 'image', url: 'https://x.dev/og.jpg' }] }), /could not be processed \(ERROR\); check that its URL is public/);
});

test('Instagram publishes a carousel: one container per piece in order, then the carousel; a story and a comment after', async () => {
  const calls: Call[] = [];
  let n = 0;
  const instagram = new Instagram({
    userId: '1784',
    accessToken: 'tok',
    pollMs: 1,
    sleep: async () => {},
    fetch: fakeFetch(
      [
        [`POST ${G}/1784/media_publish`, () => Response.json({ id: 'post-1' })],
        [`POST ${G}/1784/media`, () => Response.json({ id: `c${++n}` })],
        [`POST ${G}/post-1/comments`, () => Response.json({ id: 'comment-1' })],
        [`GET ${G}/c`, () => Response.json({ status_code: 'FINISHED' })],
        [`GET ${G}/post-1`, () => Response.json({ permalink: 'https://www.instagram.com/p/xyz/' })],
      ],
      calls,
    ),
  });
  const published = await instagram.publish({
    caption: 'claudio. Link in bio.',
    media: [
      { kind: 'image', url: 'https://x.dev/instagram-01.jpg' },
      { kind: 'video', url: 'https://x.dev/instagram-02.mp4' },
      { kind: 'image', url: 'https://x.dev/instagram-03.jpg' },
    ],
  });
  assert.deepEqual(published, { externalId: 'post-1', url: 'https://www.instagram.com/p/xyz/' });
  const created = calls.filter((c) => c.url === `${G}/1784/media`).map((c) => new URLSearchParams(String(c.body)));
  assert.deepEqual(created.slice(0, 3).map((p) => [p.get('is_carousel_item'), p.get('image_url') ?? p.get('video_url'), p.get('media_type')]), [
    ['true', 'https://x.dev/instagram-01.jpg', null],
    ['true', 'https://x.dev/instagram-02.mp4', 'VIDEO'],
    ['true', 'https://x.dev/instagram-03.jpg', null],
  ]);
  assert.equal(created[3]!.get('media_type'), 'CAROUSEL');
  assert.equal(created[3]!.get('children'), 'c1,c2,c3');
  assert.equal(created[3]!.get('caption'), 'claudio. Link in bio.');

  await instagram.publishStory({ kind: 'image', url: 'https://x.dev/instagram-story.jpg' });
  assert.equal(new URLSearchParams(String(calls.filter((c) => c.url === `${G}/1784/media`).at(-1)!.body)).get('media_type'), 'STORIES');
  assert.deepEqual(await instagram.comment('post-1', 'Full write-up in my bio'), { id: 'comment-1' });
  assert.equal(new URLSearchParams(String(calls.at(-1)!.body)).get('message'), 'Full write-up in my bio');
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
        ['GET https://api.brevo.com/v3/emailCampaigns/77?statistics=globalStats&excludeHtmlContent=true', () => Response.json({ statistics: { globalStats: { sent: 8, delivered: 8, uniqueViews: 5, uniqueClicks: 2, unsubscriptions: 0, hardBounces: 0, softBounces: 1, complaints: 0 } } })],
        ['GET https://api.brevo.com/v3/emailCampaigns/78?statistics=globalStats&excludeHtmlContent=true', () => Response.json({ statistics: { globalStats: { sent: 4, delivered: 4, uniqueViews: 1, uniqueClicks: 1, unsubscriptions: 1, hardBounces: 0, softBounces: 0, complaints: 0 } } })],
        ['GET https://api.brevo.com/v3/emailCampaigns/77?statistics=linksStats', () => Response.json({ statistics: {} })],
        ['GET https://api.brevo.com/v3/emailCampaigns/78?statistics=linksStats', () => Response.json({ statistics: {} })],
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
  assert.equal(created.replyTo, 'hola@josegarrido.dev', 'replies go to the sender, not to the account default');
  assert.equal(calls[0]!.headers['api-key'], 'k');
  assert.deepEqual(await brevo.metrics('77,78'), { sent: 12, delivered: 12, opens: 6, clicks: 3, unsubscribes: 1, bounces: 1, complaints: 0 });
});

test('Brevo keeps every open, MPP’s and the trackable ones apart from unique opens, and the clicks per link', async () => {
  const calls: Call[] = [];
  const global = { sent: 10, delivered: 9, uniqueViews: 4, viewed: 11, trackableViews: 2, appleMppOpens: 3, uniqueClicks: 2, clickers: 5, unsubscriptions: 0, hardBounces: 0, softBounces: 0, complaints: 0 };
  const brevo = new Brevo({
    apiKey: 'k',
    fetch: fakeFetch(
      [
        ['GET https://api.brevo.com/v3/emailCampaigns?status=sent&statistics=globalStats', () => Response.json({ campaigns: [{ id: 7, statistics: { globalStats: global } }, { id: 9, statistics: {} }] })],
        // Brevo's schema says a number per link and its example `{ nbClick }`: both are read
        ['GET https://api.brevo.com/v3/emailCampaigns?status=sent&statistics=linksStats', () => Response.json({ campaigns: [{ id: 7, statistics: { linksStats: { 'https://site.dev/en/a/?utm_source=newsletter': { nbClick: 3 }, 'https://site.dev/en/a/?utm_content=button': 1, 'https://brevo.com/unsubscribe': 1 } } }] })],
        ['GET https://api.brevo.com/v3/emailCampaigns/9?statistics=globalStats', () => Response.json({ statistics: { globalStats: { ...global, viewed: undefined, appleMppOpens: undefined } } })],
        ['GET https://api.brevo.com/v3/emailCampaigns/9?statistics=linksStats', () => Response.json({ statistics: { linksStats: {} } })],
      ],
      calls,
    ),
  });
  const read = await brevo.metricsMany(['7', '9']);
  assert.deepEqual(read.get('7'), {
    sent: 10,
    delivered: 9,
    opens: 4,
    opens_total: 11,
    opens_trackable: 2,
    opens_mpp: 3,
    clicks: 2,
    clicks_total: 5,
    unsubscribes: 0,
    bounces: 0,
    complaints: 0,
    'link:https://site.dev/en/a/': 4,
    'link:https://brevo.com/unsubscribe': 1,
  });
  assert.equal(read.get('9')?.opens_mpp, undefined, 'a count Brevo leaves out is not a zero');
  assert.ok(calls.filter((c) => c.url.includes('/emailCampaigns?')).every((c) => c.url.includes('excludeHtmlContent=true')), 'the list never brings the campaigns’ HTML');
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
