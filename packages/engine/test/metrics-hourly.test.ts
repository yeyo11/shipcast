import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { Bluesky, Brevo, CloudflareAnalytics, ConnectorError, Devto, GitHubDiscussions, GitHubRepoStats, Hashnode, Mastodon, MemoryEtagCache, Telegram } from '@shipcast/connectors';
import { Brand, channelCadence, type Channel } from '@shipcast/schema';
import { batchReader, canonicalKey, collectHourly, collectMetrics, inspectionDue, runChecks, TelemetryStore, trafficProblemKey, trafficReadKey, type MetricSources } from '../src/index.ts';
import { aLaunch, aPublishedLaunch, memoryRegistry, withPosts } from '../src/testing/index.ts';

/*
 * Phase 8's hourly reads against the real connectors over a fake network: a run over 30 pieces on
 * six networks, five launches of two repos, makes one call per batch (and per repo where a repo is
 * what is read), where the six-hourly reads make one per piece. Unchanged values add no row.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const HOUR = 3_600_000;
const CHANNELS: Channel[] = ['bluesky', 'mastodon', 'devto', 'hashnode', 'githubDiscussions', 'newsletter'];

/** A fake of every network the run reaches, each call counted by host and path; `bump` moves one count */
function network() {
  const calls: string[] = [];
  const state = { likes: 1, stars: 10 };
  const reply = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { query?: string; variables?: Record<string, unknown> }) : undefined;
    calls.push(`${url.host}${url.pathname}`);
    if (url.pathname.endsWith('app.bsky.feed.getPosts')) return reply({ posts: url.searchParams.getAll('uris').map((uri) => ({ uri, likeCount: state.likes, repostCount: 0, replyCount: 0, quoteCount: 0 })) });
    if (url.host === 'm.example') return reply(url.searchParams.getAll('id[]').map((id) => ({ id, favourites_count: 2, reblogs_count: 0, replies_count: 0 })));
    if (url.pathname === '/api/articles/me/all') return reply([1, 2, 3, 4, 5].map((n) => ({ id: n, page_views_count: 30, public_reactions_count: 1, comments_count: 0 })));
    if (url.host === 'gql.hashnode.com') return reply({ data: Object.fromEntries(Object.keys(body?.variables ?? {}).map((k) => [`p${k.slice(2)}`, { views: 5, reactionCount: 0, responseCount: 0 }])) });
    if (url.host === 'api.github.com' && url.pathname === '/graphql') {
      const discussion = (id: unknown) => ({ id, upvoteCount: 1, reactions: { totalCount: 0 }, comments: { totalCount: 0, nodes: [] } });
      const ids = body?.variables?.ids as string[] | undefined;
      return reply({ data: ids ? { nodes: ids.map(discussion) } : { node: discussion(body?.variables?.id) } });
    }
    if (url.host === 'api.brevo.com') return reply({ campaigns: [1, 2, 3, 4, 5].map((id) => ({ id, statistics: { globalStats: { sent: 9, delivered: 9, uniqueViews: 3, uniqueClicks: 1, unsubscriptions: 0, hardBounces: 0, softBounces: 0, complaints: 0 } } })) });
    if (url.host === 'api.cloudflare.com') {
      const paths = ((body?.variables?.filter as { requestPath_in?: string[]; requestPath?: string }).requestPath_in ?? [(body?.variables?.filter as { requestPath: string }).requestPath]);
      return reply({ data: { viewer: { accounts: [{ rumPageloadEventsAdaptiveGroups: paths.map((p) => ({ count: 4, dimensions: { requestPath: p, refererHost: 'bsky.app' } })) }] } } });
    }
    if (url.pathname.endsWith('/traffic/views')) return reply({ count: 7, uniques: 3 });
    if (url.pathname.endsWith('/traffic/clones')) return reply({ count: 0, uniques: 0 });
    if (url.pathname.includes('/traffic/popular/') || url.pathname.endsWith('/stargazers/history') || url.pathname.endsWith('/releases')) return reply([]);
    if (url.pathname.startsWith('/repos/')) {
      const etag = `"stars-${state.stars}"`;
      if (new Headers(init?.headers).get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return reply({ stargazers_count: state.stars, forks_count: 1, subscribers_count: 2 }, { headers: { etag, 'content-type': 'application/json' } });
    }
    throw new Error(`unexpected ${url.href}`);
  };
  const count = (match: string) => calls.filter((c) => c.includes(match)).length;
  return { fetch, calls, count, state };
}

function sources(fetch: typeof globalThis.fetch): MetricSources {
  const auth = { token: async () => 'installation-token' };
  const bluesky = new Bluesky({ identifier: 'me.bsky.social', appPassword: 'x', fetch });
  const mastodon = new Mastodon({ instance: 'https://m.example', accessToken: 't', fetch });
  const devto = new Devto({ apiKey: 'k', fetch });
  const hashnode = new Hashnode({ token: 't', fetch });
  const discussions = new GitHubDiscussions({ auth, fetch });
  const brevo = new Brevo({ apiKey: 'k', fetch });
  // What each adapter wires (packages/runtime/src/channels): one piece a call, or many through `read`
  const reader = (c: { metrics(id: string): Promise<Record<string, number>>; metricsMany(ids: string[]): Promise<Map<string, Record<string, number>>> }) => ({ metrics: (id: string) => c.metrics(id), read: batchReader((ids) => c.metricsMany(ids)).read });
  const repo = new GitHubRepoStats({ auth, fetch, etags: new MemoryEtagCache() });
  return {
    posts: { bluesky: reader(bluesky), mastodon: reader(mastodon), devto: reader(devto), hashnode: reader(hashnode), githubDiscussions: reader(discussions), newsletter: reader(brevo) },
    blog: new CloudflareAnalytics({ apiToken: 't', accountId: 'a', siteTag: 's', fetch }),
    githubRepo: repo,
    // The six-hourly reads' GitHub: both reads, every launch
    github: { repoStats: async (r: string) => ({ ...(await repo.counts(r)), ...(await repo.traffic(r)) }) },
  };
}

async function fiveLaunches() {
  const registry = await memoryRegistry();
  for (let n = 1; n <= 5; n++) {
    await aPublishedLaunch(
      registry,
      [
        { channel: 'blog', kind: 'article:en', externalId: `a${n}`, url: `https://josegarrido.dev/en/a${n}/` },
        { channel: 'bluesky', externalId: `at://did:plc:me/app.bsky.feed.post/${n}` },
        { channel: 'mastodon', externalId: `${100 + n}` },
        { channel: 'devto', externalId: `${n}` },
        { channel: 'hashnode', externalId: `h${n}` },
        { channel: 'githubDiscussions', externalId: `D_${n}` },
        { channel: 'newsletter', kind: 'issue:en', externalId: `${n}` },
      ],
      { repo: n <= 3 ? 'yeyo11/claudio' : 'yeyo11/shipcast', ref: `v${n}.0.0` },
    );
  }
  return registry;
}

const rowCount = async (registry: Awaited<ReturnType<typeof memoryRegistry>>) => (await registry.queries.selectRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM metrics`))[0]!.n;

test('30 pieces on 6 networks: one call per batch and per repo, against one per piece before', async () => {
  const before = network();
  await collectMetrics(await fiveLaunches(), brand, sources(before.fetch), new Date());
  const after = network();
  const registry = await fiveLaunches();
  const result = await collectHourly(registry, brand, sources(after.fetch), new Date());
  assert.deepEqual(result.problems, []);

  const perNetwork = (n: ReturnType<typeof network>) => ({
    bluesky: n.count('getPosts'),
    mastodon: n.count('m.example'),
    devto: n.count('articles/me/all'),
    hashnode: n.count('hashnode'),
    discussions: n.count('api.github.com/graphql'),
    brevo: n.count('brevo'),
    cloudflare: n.count('cloudflare'),
    githubCounts: n.calls.filter((c) => /\/repos\/[^/]+\/[^/]+$/.test(c)).length,
    githubTraffic: n.count('/traffic/views'),
  });
  assert.deepEqual(perNetwork(before), { bluesky: 5, mastodon: 5, devto: 5, hashnode: 5, discussions: 5, brevo: 5, cloudflare: 5, githubCounts: 5, githubTraffic: 5 });
  assert.deepEqual(perNetwork(after), { bluesky: 1, mastodon: 1, devto: 1, hashnode: 1, discussions: 1, brevo: 2, cloudflare: 2, githubCounts: 2, githubTraffic: 2 });
  assert.equal(before.calls.length, 60);
  // Brevo's clicks per link are a second call, the blog's days another; each repo's traffic is four, its stars and releases two
  assert.equal(after.calls.length, 23);
});

test('an hour later unchanged values move checked_at and add no row; a changed one adds one; daily sources wait', async () => {
  const net = network();
  const registry = await fiveLaunches();
  const s = sources(net.fetch);
  const t0 = new Date();
  await collectHourly(registry, brand, s, t0);
  const rows = await rowCount(registry);
  const calls = net.calls.length;

  // A minute later nothing is due: no call at all
  await collectHourly(registry, brand, s, new Date(t0.getTime() + 60_000));
  assert.equal(net.calls.length, calls, 'nothing read faster than its cadence');

  // An hour later, nothing changed on the networks
  const t1 = new Date(t0.getTime() + HOUR);
  await collectHourly(registry, brand, s, t1);
  assert.equal(await rowCount(registry), rows, 'no row added');
  assert.equal(net.count('/traffic/views'), 2, 'the traffic is daily: not read again');
  const moved = await registry.queries.selectRows<{ n: number }>(sql`SELECT count(*)::int AS n FROM metrics WHERE checked_at = ${t1.toISOString()}`);
  assert.equal(moved[0]!.n, rows - 5 * 5, 'every hourly reading checked (the traffic\'s four values and the history\'s one on five launches were not read)');

  // A like on Bluesky: one row per piece whose value moved, nothing else
  net.state.likes = 2;
  await collectHourly(registry, brand, s, new Date(t0.getTime() + 2 * HOUR));
  assert.equal(await rowCount(registry), rows + 5);

  // Freshness after an hourly run: every piece within its channel's cadence
  const [fresh] = (await runChecks(registry, new TelemetryStore(registry.database), { now: new Date(t0.getTime() + 2 * HOUR + 5 * 60_000), cadenceHours: 1, cadenceOf: (c) => channelCadence(c)?.hours })).filter((r) => r.name === 'freshness');
  assert.equal(fresh!.value, 1);
  for (const channel of CHANNELS) assert.equal((fresh!.detail as { channels: Record<string, { cadenceHours: number }> }).channels[channel]?.cadenceHours, 1);
});

test('the repo counts are conditional: a 304 when no one starred, and the stars recorded on each launch of the repo', async () => {
  const net = network();
  const registry = await fiveLaunches();
  const s = sources(net.fetch);
  const t0 = new Date();
  await collectHourly(registry, brand, s, t0);
  await collectHourly(registry, brand, s, new Date(t0.getTime() + HOUR));
  const latest = await Promise.all((await registry.launches.recent(10)).map(async (l) => (await registry.metrics.latestMetrics(l.id)).find((m) => m.source === 'github' && m.name === 'stars')?.value));
  assert.deepEqual(latest, [10, 10, 10, 10, 10]);
  assert.ok(net.calls.filter((c) => /\/repos\/[^/]+\/[^/]+$/.test(c)).length === 4, 'two repos, two runs');
});

test('index status: daily until indexed, weekly after, never past 90 days', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const launched = '2026-11-01T00:00:00Z';
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR).toISOString();
  assert.equal(inspectionDue(undefined, launched, now), true, 'never read');
  assert.equal(inspectionDue({ indexed: false, checkedAt: ago(5) }, launched, now), false);
  assert.equal(inspectionDue({ indexed: false, checkedAt: ago(24) }, launched, now), true, 'daily until indexed');
  assert.equal(inspectionDue({ indexed: true, checkedAt: ago(24) }, launched, now), false);
  assert.equal(inspectionDue({ indexed: true, checkedAt: ago(7 * 24) }, launched, now), true, 'weekly once indexed');
  assert.equal(inspectionDue(undefined, '2026-08-01T00:00:00Z', now), false, 'a launch past 90 days is not inspected again');
});

test('a refused traffic read is said, kept for the bell, and asked again next hour; a later answer clears it', async () => {
  const registry = await memoryRegistry();
  await aPublishedLaunch(registry, [], { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  let refuse = true;
  let trafficReads = 0;
  const traffic = {
    views: 7,
    uniqueVisitors: 3,
    clones: 2,
    uniqueCloners: 1,
    days: [{ day: '2026-10-28', views: 5, uniqueVisitors: 2, clones: 2, uniqueCloners: 1 }],
    referrers: [{ name: 'news.ycombinator.com', count: 4, uniques: 2 }],
    paths: [{ name: '/yeyo11/claudio', count: 6, uniques: 3 }],
  };
  const source: MetricSources = {
    githubRepo: {
      counts: async () => ({ stars: 3, forks: 0, watchers: 1 }),
      traffic: async () => {
        trafficReads++;
        if (refuse) throw new ConnectorError('GitHub', "read yeyo11/claudio's traffic: 403 Resource not accessible by integration", 403);
        return traffic;
      },
      history: async () => ({ starsByDay: { '2026-10-27': 2 }, downloadsByTag: { 'v1.0.0': 12, 'v0.9.0': 3 } }),
    },
  };
  const t0 = new Date('2026-10-29T10:00:00Z');
  const first = await collectHourly(registry, brand, source, t0);
  assert.deepEqual(first.problems, ["yeyo11/claudio GitHub traffic: GitHub: read yeyo11/claudio's traffic: 403 Resource not accessible by integration"]);
  assert.match((await registry.cursors.cursor(trafficProblemKey('yeyo11/claudio'))) ?? '', /403/);
  assert.equal(await registry.cursors.cursor(trafficReadKey('yeyo11/claudio')), undefined, 'the cursor does not move');

  refuse = false;
  await collectHourly(registry, brand, source, new Date(t0.getTime() + HOUR));
  assert.equal(trafficReads, 2, 'asked again an hour later, not a day');
  assert.equal(await registry.cursors.cursor(trafficProblemKey('yeyo11/claudio')), undefined);
  const [launch] = await registry.launches.recent(1);
  const read = Object.fromEntries((await registry.metrics.latestMetrics(launch!.id)).filter((m) => m.source === 'github').map((m) => [m.name, m.value]));
  assert.deepEqual(read, {
    stars: 3,
    forks: 0,
    watchers: 1,
    views: 7,
    uniqueVisitors: 3,
    clones: 2,
    uniqueCloners: 1,
    'referrer:news.ycombinator.com': 4,
    'referrer_visitors:news.ycombinator.com': 2,
    'path:/yeyo11/claudio': 6,
    'path_visitors:/yeyo11/claudio': 3,
    downloads: 12,
    downloads_total: 15,
  });
  // Each day under the day it happened, on every launch of the repo
  assert.deepEqual(
    (await registry.metrics.metricDays(launch!.id, 'github')).map((d) => [d.day, d.name, d.value]),
    [
      ['2026-10-27', 'stars', 2],
      ['2026-10-28', 'cloners', 1],
      ['2026-10-28', 'clones', 2],
      ['2026-10-28', 'views', 5],
      ['2026-10-28', 'visitors', 2],
    ],
  );
});

/** A Telegram over a fake getUpdates that hands out `pages` in turn, recording each call's offset */
function pushedTelegram(pages: Array<Array<[number, number, number]>>) {
  const offsets: Array<number | undefined> = [];
  let next = 0;
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    offsets.push((JSON.parse(String(init?.body)) as { offset?: number }).offset);
    // Telegram hands the unconfirmed changes again until a call's offset passes them
    const offset = offsets.at(-1);
    while (next < pages.length && offset !== undefined && pages[next]!.every(([update]) => update < offset)) next++;
    const page = pages[next] ?? [];
    const result = page.map(([update_id, message_id, total_count]) => ({ update_id, message_reaction_count: { chat: { id: -1, username: 'c' }, message_id, date: 1, reactions: [{ total_count }] } }));
    return Response.json({ ok: true, result });
  };
  const telegram = new Telegram({ botToken: 'T', chatId: '@c', fetch });
  const reader = { metrics: async () => ({}), pushed: (ids: string[], store: (page: Map<string, Record<string, number>>) => Promise<void>) => telegram.reactions(ids, store) };
  return { reader, offsets, push: (page: Array<[number, number, number]>) => pages.push(page) };
}

test('a push-only network’s changes are kept for every piece it tells about, due or not, of any launch, and none is made up', async () => {
  const registry = await memoryRegistry();
  const first = await aPublishedLaunch(registry, [{ channel: 'telegram', externalId: '@c:1' }], { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  const second = await aPublishedLaunch(registry, [{ channel: 'telegram', externalId: '@c:2' }], { repo: 'yeyo11/claudio', ref: 'v1.1.0' });
  // A launch that failed on another channel still has its Telegram post out
  const failed = await aLaunch(registry, { repo: 'yeyo11/claudio', ref: 'v1.2.0', status: 'failed' });
  const [partial] = await withPosts(registry, failed.id, [{ channel: 'telegram', externalId: '@c:3' }]);
  const net = pushedTelegram([[[10, 1, 4]]]);
  const source: MetricSources = { posts: { telegram: net.reader } };
  const t0 = new Date('2026-10-29T10:00:00Z');
  await collectHourly(registry, brand, source, t0);
  const values = async (postId: number) => (await registry.metrics.postMetrics(postId)).map((m) => [m.name, m.value]);
  assert.deepEqual(await values(first.posts[0]!.id), [['reactions', 4]]);
  assert.deepEqual(await values(second.posts[0]!.id), [], 'a piece never told about has no reading, not a made-up 0');

  // Half an hour on, no piece is due, but what Telegram pushed is read and kept all the same
  net.push([[11, 2, 7], [12, 3, 2]]);
  await collectHourly(registry, brand, source, new Date(t0.getTime() + HOUR / 2));
  assert.deepEqual(await values(second.posts[0]!.id), [['reactions', 7]]);
  assert.deepEqual(await values(partial!.id), [['reactions', 2]], 'a piece of a launch that is not published counts too');

  // An hour on, silence: a piece with numbers keeps them, its check moved; the rest stay unread
  const t1 = new Date(t0.getTime() + HOUR);
  await collectHourly(registry, brand, source, t1);
  assert.deepEqual(
    (await registry.metrics.postMetrics(first.posts[0]!.id)).map((m) => [m.name, m.value, m.checkedAt]),
    [['reactions', 4, t1.toISOString()]],
  );
  assert.equal((await registry.metrics.latestMetrics(first.launch.id)).find((m) => m.source === 'telegram')?.value, 4, 'the piece is still in its launch’s sum');
});

test('a push-only network’s changes are confirmed only once they are kept', async () => {
  const registry = await memoryRegistry();
  const { posts } = await aPublishedLaunch(registry, [{ channel: 'telegram', externalId: '@c:1' }]);
  const net = pushedTelegram([[[10, 1, 4]]]);
  const record = registry.metrics.recordMetrics.bind(registry.metrics);
  let down = true;
  registry.metrics.recordMetrics = async (...args) => {
    if (down) throw new Error('the database is down');
    return record(...args);
  };
  const result = await collectHourly(registry, brand, { posts: { telegram: net.reader } }, new Date('2026-10-29T10:00:00Z'));
  assert.match(result.problems.join('\n'), /database/);
  assert.deepEqual(net.offsets, [undefined], 'nothing confirmed');

  down = false;
  await collectHourly(registry, brand, { posts: { telegram: net.reader } }, new Date('2026-10-29T11:00:00Z'));
  assert.deepEqual((await registry.metrics.postMetrics(posts[0]!.id)).map((m) => [m.name, m.value]), [['reactions', 4]], 'handed again, and kept this time');
  assert.deepEqual(net.offsets, [undefined, undefined, 11]);
});

test('a traffic read GitHub fails for a while is said but not kept for the bell', async () => {
  const registry = await memoryRegistry();
  await aPublishedLaunch(registry, [], { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  const source: MetricSources = {
    githubRepo: {
      counts: async () => ({ stars: 3, forks: 0, watchers: 1 }),
      traffic: async () => {
        throw new ConnectorError('GitHub', 'read the traffic: 502', 502);
      },
      history: async () => ({ starsByDay: {}, downloadsByTag: {} }),
    },
  };
  const result = await collectHourly(registry, brand, source, new Date('2026-10-29T10:00:00Z'));
  assert.equal(result.problems.length, 1);
  assert.equal(await registry.cursors.cursor(trafficProblemKey('yeyo11/claudio')), undefined);
});

test('a page Google files under another canonical is kept for the bell, and forgotten once Google agrees', async () => {
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, [
    { channel: 'blog', kind: 'article:en', externalId: 'a', url: 'https://josegarrido.dev/en/a/' },
    { channel: 'blog', kind: 'article:es', externalId: 'b', url: 'https://josegarrido.dev/es/b/' },
  ]);
  let canonical = 'https://dev.to/me/a-1';
  const search: MetricSources['search'] = {
    pageMetrics: async () => ({ clicks: 0, impressions: 0 }),
    inspect: async (url) => (url.includes('/en/') ? { indexed: true, coverage: 'Submitted and indexed', googleCanonical: canonical } : { indexed: false, coverage: 'URL is unknown to Google' }),
  };
  const t0 = new Date('2026-11-03T09:00:00.000Z');
  await collectHourly(registry, brand, { search }, t0);
  assert.deepEqual(JSON.parse((await registry.cursors.cursor(canonicalKey(launch.id)))!), [{ url: 'https://josegarrido.dev/en/a/', googleCanonical: 'https://dev.to/me/a-1' }], 'a page not indexed has no canonical: not a mismatch');

  canonical = 'https://josegarrido.dev/en/a/';
  await collectHourly(registry, brand, { search }, new Date(t0.getTime() + 8 * 24 * HOUR));
  assert.equal(await registry.cursors.cursor(canonicalKey(launch.id)), undefined);
});

test('a source that counts per day keeps each day under it: Search Console’s days make the launch’s totals, the blog’s paths add up per day', async () => {
  const registry = await memoryRegistry();
  const { launch } = await aPublishedLaunch(registry, [
    { channel: 'blog', kind: 'article:en', externalId: 'a', url: 'https://josegarrido.dev/en/a/' },
    { channel: 'blog', kind: 'article:es', externalId: 'b', url: 'https://josegarrido.dev/es/b/' },
  ]);
  const search: MetricSources['search'] = {
    pageMetrics: async () => assert.fail('the days replace the since-launch total'),
    pageMetricsByDay: async (url) =>
      url.includes('/en/')
        ? [
            { day: '2026-11-01', clicks: 2, impressions: 100, ctr: 0.02, position: 4 },
            { day: '2026-11-02', clicks: 1, impressions: 50, ctr: 0.02, position: 10 },
          ]
        : [{ day: '2026-11-02', clicks: 1, impressions: 50, ctr: 0.02, position: 7 }],
  };
  const blog: MetricSources['blog'] = {
    pageVisits: async () => assert.fail('read many at once'),
    pageVisitsMany: async (paths) => new Map(paths.map((p) => [p, { views: 9, visits: 6, bySource: { direct: 9 } }])),
    pageVisitsByDay: async (paths) => new Map(paths.map((p) => [p, { '2026-11-01': { views: 4, visits: 3 }, '2026-11-02': { views: 5, visits: 3 } }])),
  };
  const result = await collectHourly(registry, brand, { search, blog }, new Date('2026-11-03T09:00:00.000Z'));
  assert.deepEqual(result.problems, []);
  const latest = Object.fromEntries((await registry.metrics.latestMetrics(launch.id)).filter((m) => m.source === 'search').map((m) => [m.name, m.value]));
  assert.deepEqual(latest, { clicks: 4, ctr: 0.02, impressions: 200, position: 6.25 }, 'the position weighted by each day’s impressions');
  assert.deepEqual(
    (await registry.metrics.metricDays(launch.id)).map((d) => [d.source, d.day, d.name, d.value]),
    [
      ['blog', '2026-11-01', 'views', 8],
      ['blog', '2026-11-01', 'visits', 6],
      ['search', '2026-11-01', 'clicks', 2],
      ['search', '2026-11-01', 'impressions', 100],
      ['blog', '2026-11-02', 'views', 10],
      ['blog', '2026-11-02', 'visits', 6],
      ['search', '2026-11-02', 'clicks', 2],
      ['search', '2026-11-02', 'impressions', 100],
    ],
  );
});
