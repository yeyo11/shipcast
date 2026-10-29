import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { BingWebmaster, Brevo, CloudflareAnalytics, SearchConsole } from '../src/index.ts';
import { fakeFetch, type Call } from './fake.ts';

/* The numbers each measurement or newsletter account's card leads with, read with the daily sync */

test('Brevo counts the contacts who can still receive it in the brand’s own lists only, added up', async () => {
  const calls: Call[] = [];
  const brevo = new Brevo({
    apiKey: 'k',
    fetch: fakeFetch(
      [
        ['GET https://api.brevo.com/v3/contacts/lists/3', () => Response.json({ uniqueSubscribers: 5, totalBlacklisted: 1 })],
        ['GET https://api.brevo.com/v3/contacts/lists/4', () => Response.json({ uniqueSubscribers: 4, totalBlacklisted: 0 })],
      ],
      calls,
    ),
  });
  assert.deepEqual(await brevo.profileStats([3, 4, 3]), { followers: 8 });
  assert.deepEqual(calls.map((c) => c.url), ['https://api.brevo.com/v3/contacts/lists/3', 'https://api.brevo.com/v3/contacts/lists/4'], 'each list once, and no other list of the account');
  assert.deepEqual(await brevo.profileStats([]), {}, 'without lists in brand.yml there are no readers to count');
});

test('Cloudflare counts the whole site’s visits of the last seven days, with no path filter', async () => {
  const calls: Call[] = [];
  const cf = new CloudflareAnalytics({
    apiToken: 't',
    accountId: 'a',
    siteTag: 's',
    fetch: fakeFetch([['POST https://api.cloudflare.com/client/v4/graphql', () => Response.json({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: [{ count: 30, dimensions: {} }, { count: 12, dimensions: { refererHost: 'bsky.app' } }] }] } } })]], calls),
  });
  assert.deepEqual(await cf.profileStats(), { extra: { visits7d: 42 } });
  const filter = (JSON.parse(String(calls[0]?.body)) as { variables: { filter: Record<string, unknown> } }).variables.filter;
  assert.equal('requestPath' in filter, false);
});

test('Search Console and Bing count the site’s clicks and impressions of the last 28 days', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: Call[] = [];
  const sc = new SearchConsole({
    serviceAccount: { client_email: 'x@y.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    property: 'sc-domain:example.dev',
    fetch: fakeFetch(
      [
        ['POST https://oauth2.googleapis.com/token', () => Response.json({ access_token: 'goog', expires_in: 3600 })],
        ['POST https://searchconsole.googleapis.com/', () => Response.json({ rows: [{ clicks: 9, impressions: 310 }] })],
      ],
      calls,
    ),
  });
  assert.deepEqual(await sc.profileStats(), { extra: { clicks28d: 9, impressions28d: 310 } });
  assert.equal('dimensions' in (JSON.parse(String(calls[1]?.body)) as object), false, 'the whole site, not a page');

  const day = (back: number) => `/Date(${Date.now() - back * 86_400_000})/`;
  const bing = new BingWebmaster({
    apiKey: 'k',
    site: 'https://example.dev/',
    fetch: fakeFetch([['GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats', () => Response.json({ d: [{ Date: day(3), Clicks: 2, Impressions: 40 }, { Date: day(10), Clicks: 1, Impressions: 20 }, { Date: day(60), Clicks: 50, Impressions: 900 }] })]], []),
  });
  assert.deepEqual(await bing.profileStats(), { extra: { clicks28d: 3, impressions28d: 60 } });
});
