import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { BingWebmaster, CloudflareAnalytics, SearchConsole, sourceOfReferrer, visitsToMetrics, wcfDate } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

test('a referrer host maps to the channel that sent the visit', () => {
  assert.equal(sourceOfReferrer(null), 'direct');
  assert.equal(sourceOfReferrer('bsky.app'), 'bluesky');
  assert.equal(sourceOfReferrer('go.bsky.app'), 'bluesky');
  assert.equal(sourceOfReferrer('dev.to'), 'devto');
  assert.equal(sourceOfReferrer('l.instagram.com'), 'instagram');
  assert.equal(sourceOfReferrer('out.reddit.com'), 'reddit');
  assert.equal(sourceOfReferrer('www.google.es'), 'search');
  assert.equal(sourceOfReferrer('fosstodon.org'), 'other', 'a Mastodon instance cannot be told apart from any site');
});

test('Cloudflare page visits are summed by source for one path', async () => {
  const calls: Call[] = [];
  const cf = new CloudflareAnalytics({
    apiToken: 'cf',
    accountId: 'acc',
    siteTag: 'site',
    fetch: fakeFetch(
      [
        [
          'POST https://api.cloudflare.com/client/v4/graphql',
          () =>
            Response.json({
              data: {
                viewer: {
                  accounts: [
                    {
                      rumPageloadEventsAdaptiveGroups: [
                        { count: 30, dimensions: { refererHost: 'bsky.app' } },
                        { count: 12, dimensions: { refererHost: '' } },
                        { count: 5, dimensions: { refererHost: 'dev.to' } },
                        { count: 3, dimensions: { refererHost: 'go.bsky.app' } },
                      ],
                    },
                  ],
                },
              },
              errors: null,
            }),
        ],
      ],
      calls,
    ),
  });
  const visits = await cf.pageVisits('/en/claudio/', '2026-10-25', '2026-10-31');
  assert.deepEqual(visits, { views: 50, bySource: { bluesky: 33, direct: 12, devto: 5 } });
  assert.deepEqual(visitsToMetrics(visits), { views: 50, views_bluesky: 33, views_direct: 12, views_devto: 5 });
  const body = JSON.parse(String(calls[0]!.body)) as { variables: { account: string; filter: Record<string, string> } };
  assert.equal(calls[0]!.headers.authorization, 'Bearer cf');
  assert.deepEqual(body.variables, { account: 'acc', filter: { siteTag: 'site', requestPath: '/en/claudio/', date_geq: '2026-10-25', date_leq: '2026-10-31' } });
});

test('a GraphQL error from Cloudflare is raised, not read as zero visits', async () => {
  const cf = new CloudflareAnalytics({
    apiToken: 'cf',
    accountId: 'acc',
    siteTag: 's',
    fetch: fakeFetch([['POST', () => Response.json({ data: null, errors: [{ message: 'not authorized for that account' }] })]], []),
  });
  await assert.rejects(cf.pageVisits('/', '2026-10-25', '2026-10-25'), /Cloudflare: not authorized/);
});

test('Search Console signs a service-account JWT, exchanges it once, and reads one page', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: Call[] = [];
  const sc = new SearchConsole({
    serviceAccount: { client_email: 'shipcast@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    property: 'sc-domain:josegarrido.dev',
    fetch: fakeFetch(
      [
        ['POST https://oauth2.googleapis.com/token', () => Response.json({ access_token: 'goog', expires_in: 3600 })],
        [
          'POST https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Ajosegarrido.dev/searchAnalytics/query',
          () => Response.json({ rows: [{ keys: ['https://josegarrido.dev/en/claudio/'], clicks: 7, impressions: 140, ctr: 0.05, position: 11.2 }] }),
        ],
      ],
      calls,
    ),
  });

  assert.deepEqual(await sc.pageMetrics('https://josegarrido.dev/en/claudio/', '2026-10-25', '2026-10-31'), { clicks: 7, impressions: 140, ctr: 0.05, position: 11.2 });
  await sc.pageMetrics('https://josegarrido.dev/es/claudio/', '2026-10-25', '2026-10-31');
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'the access token is reused until it expires');

  const assertion = new URLSearchParams(String(calls[0]!.body)).get('assertion')!;
  const [header, payload, signature] = assertion.split('.');
  const verified = createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, 'base64url'));
  assert.ok(verified, 'the JWT is signed with the service account key');
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as { iss: string; scope: string; aud: string };
  assert.equal(claims.iss, 'shipcast@project.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/webmasters', 'resubmitting the sitemap is a write');
  assert.equal(calls[1]!.headers.authorization, 'Bearer goog');
});

test('Search Console tells whether a URL is indexed and resubmits the sitemap', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: Call[] = [];
  const sc = new SearchConsole({
    serviceAccount: { client_email: 'shipcast@project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    property: 'sc-domain:josegarrido.dev',
    fetch: fakeFetch(
      [
        ['POST https://oauth2.googleapis.com/token', () => Response.json({ access_token: 'goog', expires_in: 3600 })],
        [
          'POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
          () =>
            Response.json(
              (JSON.parse(String(calls.at(-1)!.body)) as { inspectionUrl: string }).inspectionUrl.includes('/en/')
                ? { inspectionResult: { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-10-25T10:32:27Z' } } }
                : { inspectionResult: { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' } } },
            ),
        ],
        ['PUT https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Ajosegarrido.dev/sitemaps/https%3A%2F%2Fjosegarrido.dev%2Fsitemap-index.xml', () => new Response(null, { status: 204 })],
      ],
      calls,
    ),
  });

  assert.deepEqual(await sc.inspect('https://josegarrido.dev/en/claudio/'), { indexed: true, coverage: 'Submitted and indexed', lastCrawl: '2026-10-25T10:32:27Z' });
  assert.deepEqual(await sc.inspect('https://josegarrido.dev/es/claudio/'), { indexed: false, coverage: 'URL is unknown to Google' });
  assert.deepEqual(JSON.parse(String(calls[1]!.body)), { inspectionUrl: 'https://josegarrido.dev/en/claudio/', siteUrl: 'sc-domain:josegarrido.dev' });
  await sc.submitSitemap('https://josegarrido.dev/sitemap-index.xml');
  assert.equal(calls.at(-1)!.method, 'PUT');
});

test('Bing Webmaster checks the site is verified, reads page traffic and crawl state, and parses WCF dates', async () => {
  const calls: Call[] = [];
  const answers: Record<string, unknown> = {
    GetUserSites: [{ Url: 'https://josegarrido.dev/', IsVerified: true }],
    GetUrlTrafficInfo: { Clicks: 4, Impressions: 120, IsPage: true, Url: 'https://josegarrido.dev/en/claudio/' },
    GetUrlInfo: { DiscoveryDate: '/Date(1792900000000-0700)/', LastCrawledDate: '/Date(1792930000000-0700)/', HttpStatus: 200 },
  };
  const bing = new BingWebmaster({
    apiKey: 'k',
    site: 'https://josegarrido.dev/',
    fetch: fakeFetch([['GET https://ssl.bing.com/webmaster/api.svc/json/', () => Response.json({ d: answers[new URL(calls.at(-1)!.url).pathname.split('/').at(-1)!] })]], calls),
  });

  assert.deepEqual(await bing.check(), { ok: true, account: 'https://josegarrido.dev/ (verified)' });
  assert.equal(new URL(calls[0]!.url).searchParams.get('apikey'), 'k');
  assert.deepEqual(await bing.pageMetrics('https://josegarrido.dev/en/claudio/'), { clicks: 4, impressions: 120 });
  const traffic = new URL(calls[1]!.url).searchParams;
  assert.equal(traffic.get('siteUrl'), 'https://josegarrido.dev/');
  assert.equal(traffic.get('url'), 'https://josegarrido.dev/en/claudio/');
  assert.deepEqual(await bing.inspect('https://josegarrido.dev/en/claudio/'), {
    indexed: true,
    coverage: `Crawled on ${new Date(1792930000000).toISOString().slice(0, 10)}`,
    lastCrawl: new Date(1792930000000).toISOString(),
  });

  answers.GetUrlInfo = { DiscoveryDate: '/Date(-62135596800000)/', LastCrawledDate: '/Date(-62135596800000)/' };
  assert.deepEqual(await bing.inspect('https://josegarrido.dev/es/claudio/'), { indexed: false, coverage: 'Not known to Bing yet' });
  assert.equal(wcfDate('/Date(-62135596800000)/'), undefined, 'Bing answers the year 1 for never');

  answers.GetUserSites = [{ Url: 'https://josegarrido.dev', IsVerified: false }];
  const unverified = await bing.check();
  assert.equal(unverified.ok, false);
  assert.match(unverified.ok ? '' : unverified.problem, /not verified/);
});
