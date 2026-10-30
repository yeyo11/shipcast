import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UmamiAnalytics } from '../src/index.ts';
import { fakeFetch, sequence, type Call } from './fake.ts';

const SITE = 'https://umami.example/api/websites/w1';

test('Umami reads a campaign by source with an API key: the totals in one call, each source’s days in one each', async () => {
  const calls: Call[] = [];
  const umami = new UmamiAnalytics({
    url: 'https://umami.example/',
    websiteId: 'w1',
    apiKey: 'umami_key',
    fetch: fakeFetch(
      [
        [
          `GET ${SITE}/metrics/expanded`,
          () =>
            Response.json([
              { name: 'bluesky', pageviews: 30, visits: 20, visitors: 18, bounces: 4, totaltime: 900 },
              { name: 'newsletter', pageviews: 7, visits: 5, visitors: 5, bounces: 1, totaltime: 100 },
              { name: null, pageviews: 99, visits: 99, visitors: 99, bounces: 0, totaltime: 0 },
            ]),
        ],
        [
          `GET ${SITE}/pageviews`,
          sequence(
            () => Response.json({ pageviews: [{ x: '2026-10-25 00:00:00', y: 10 }, { x: '2026-10-26 00:00:00', y: 20 }], sessions: [{ x: '2026-10-25 00:00:00', y: 6 }, { x: '2026-10-26 00:00:00', y: 12 }] }),
            () => Response.json({ pageviews: [{ x: '2026-10-26T00:00:00Z', y: 7 }], sessions: [{ x: '2026-10-26T00:00:00Z', y: 5 }] }),
          ),
        ],
      ],
      calls,
    ),
  });
  const visits = await umami.campaignVisits('claudio-v1-0-0', '2026-10-25', '2026-10-30');
  assert.deepEqual(visits.bySource, { bluesky: { views: 30, visits: 20, visitors: 18 }, newsletter: { views: 7, visits: 5, visitors: 5 } });
  assert.deepEqual(visits.days, {
    bluesky: { '2026-10-25': { views: 10, visitors: 6 }, '2026-10-26': { views: 20, visitors: 12 } },
    newsletter: { '2026-10-26': { views: 7, visitors: 5 } },
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer umami_key'));
  const expanded = new URL(calls[0]!.url);
  assert.deepEqual(Object.fromEntries(expanded.searchParams), {
    startAt: String(Date.parse('2026-10-25T00:00:00Z')),
    endAt: String(Date.parse('2026-10-31T00:00:00Z') - 1),
    type: 'utmSource',
    utmCampaign: 'claudio-v1-0-0',
  });
  const sources = calls.slice(1).map((c) => new URL(c.url).searchParams);
  assert.deepEqual(sources.map((p) => p.get('utmSource')).sort(), ['bluesky', 'newsletter']);
  assert.ok(sources.every((p) => p.get('unit') === 'day' && p.get('timezone') === 'UTC' && p.get('utmCampaign') === 'claudio-v1-0-0'));
});

test('Umami with no visits for a campaign asks nothing more', async () => {
  const calls: Call[] = [];
  const umami = new UmamiAnalytics({ url: 'https://umami.example/api', websiteId: 'w1', apiKey: 'k', fetch: fakeFetch([[`GET ${SITE}/metrics/expanded`, () => Response.json([])]], calls) });
  assert.deepEqual(await umami.campaignVisits('quiet-launch', '2026-10-25', '2026-10-25'), { bySource: {}, days: {} });
  assert.equal(calls.length, 1);
});

test('Umami signs in with a username and password once, and again when the token expires', async () => {
  const calls: Call[] = [];
  let tokens = 0;
  const umami = new UmamiAnalytics({
    url: 'https://umami.example',
    websiteId: 'w1',
    username: 'admin',
    password: 'secret',
    fetch: fakeFetch(
      [
        ['POST https://umami.example/api/auth/login', () => Response.json({ token: `t${++tokens}`, user: { id: 'u' } })],
        [`GET ${SITE}/stats`, sequence(() => Response.json({ pageviews: 50, visits: 31, visitors: 25 }), () => new Response('{"error":{"code":"unauthorized"}}', { status: 401 }), () => Response.json({ pageviews: 51, visits: 32, visitors: 25 }))],
      ],
      calls,
    ),
  });
  assert.deepEqual(await umami.profileStats(new Date('2026-10-30T12:00:00Z')), { extra: { visits7d: 31 } });
  assert.deepEqual(await umami.profileStats(new Date('2026-10-30T12:00:00Z')), { extra: { visits7d: 32 } });
  assert.deepEqual(
    calls.map((c) => `${c.method} ${new URL(c.url).pathname} ${c.headers.authorization ?? ''}`.trim()),
    ['POST /api/auth/login', 'GET /api/websites/w1/stats Bearer t1', 'GET /api/websites/w1/stats Bearer t1', 'POST /api/auth/login', 'GET /api/websites/w1/stats Bearer t2'],
  );
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), { username: 'admin', password: 'secret' });
});

test('Umami’s check names the website, and says what is wrong in words', async () => {
  const ok = new UmamiAnalytics({ url: 'https://umami.example', websiteId: 'w1', apiKey: 'k', fetch: fakeFetch([[`GET ${SITE}`, () => Response.json({ id: 'w1', name: 'Blog', domain: 'josegarrido.dev' })]], []) });
  assert.deepEqual(await ok.check(), { ok: true, account: 'Blog (josegarrido.dev) on umami.example' });
  const refused = new UmamiAnalytics({ url: 'https://umami.example', websiteId: 'w1', apiKey: 'k', fetch: fakeFetch([[`GET ${SITE}`, () => new Response('{}', { status: 401 })]], []) });
  const check = await refused.check();
  assert.equal(check.ok, false);
  assert.match(!check.ok ? check.problem : '', /Umami rejected the credential/);
  const twoFactor = new UmamiAnalytics({ url: 'https://umami.example', websiteId: 'w1', username: 'a', password: 'b', fetch: fakeFetch([['POST https://umami.example/api/auth/login', () => Response.json({ requiresTwoFactor: true, partialToken: 'p' })]], []) });
  const second = await twoFactor.check();
  assert.match(!second.ok ? second.problem : '', /API key/);
  assert.throws(() => new UmamiAnalytics({ url: 'https://umami.example', websiteId: 'w1', username: 'only' }), /API key, or a username and a password/);
});
