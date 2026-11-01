import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiError, fakeClient, refusal, runTool } from './fake-api.ts';

const window = { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' };

const ROUTES = {
  'GET /stats/overview': { window, metrics: { views: 10 }, lifetime: { views: 40 }, channels: [], accounts: [], averages: [] },
  'GET /stats/series': { metric: 'views', groupBy: 'channel', bucket: 'day', window, buckets: [], groups: [], other: null },
  'GET /stats/ranking': { by: 'post', window, total: 0, entries: [], next: null, medians: {} },
  'GET /stats/accounts': { from: '2026-10-03', to: '2026-11-01', accounts: [] },
  'GET /accounts/1/growth': { accountId: 1, from: '2026-08-04', to: '2026-11-01', change: {}, points: [] },
  'GET /stats/search': { from: '2026-10-03', to: '2026-11-01', launches: [] },
};

test('with no arguments, every stats tool leaves the period and the filters to the API\'s defaults', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const overview = await runTool(api, 'get_stats_overview', undefined);
  assert.deepEqual((overview as { metrics: unknown }).metrics, { views: 10 });
  await runTool(api, 'get_stats_series', { metric: 'views' });
  await runTool(api, 'get_stats_ranking', {});
  await runTool(api, 'get_stats_accounts', {});
  await runTool(api, 'get_account_growth', { account_id: 1 });
  await runTool(api, 'get_search_index_status', {});
  assert.deepEqual(fake.calls, ['GET /stats/overview', 'GET /stats/series?metric=views', 'GET /stats/ranking', 'GET /stats/accounts', 'GET /accounts/1/growth', 'GET /stats/search']);
});

test('the stats tools map their snake_case arguments onto the API\'s query, lists comma-separated', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const filters = { channels: ['bluesky', 'search'], account_ids: [4, 5], launch_ids: [9] };
  await runTool(api, 'get_stats_overview', { from: '2026-10-01', to: '2026-10-31', compare: 'previous', ...filters });
  await runTool(api, 'get_stats_overview', { compare_from: '2026-09-01', compare_to: '2026-09-30' });
  await runTool(api, 'get_stats_series', { metric: 'reactions', group_by: 'account', bucket: 'week', limit: 5, from: '2026-10-01', ...filters });
  await runTool(api, 'get_stats_ranking', { by: 'launch', order: 'asc', limit: 10, offset: 20, to: '2026-10-31', launch_ids: [9] });
  await runTool(api, 'get_stats_accounts', { from: '2026-10-01', to: '2026-10-31' });
  await runTool(api, 'get_account_growth', { account_id: 1, from: '2026-10-01', to: '2026-10-31' });
  await runTool(api, 'get_search_index_status', { from: '2026-10-01', to: '2026-10-31', launch_ids: [9, 10] });
  assert.deepEqual(fake.calls, [
    'GET /stats/overview?from=2026-10-01&to=2026-10-31&channels=bluesky%2Csearch&accounts=4%2C5&launches=9&compare=previous',
    'GET /stats/overview?compareFrom=2026-09-01&compareTo=2026-09-30',
    'GET /stats/series?metric=reactions&groupBy=account&bucket=week&limit=5&from=2026-10-01&channels=bluesky%2Csearch&accounts=4%2C5&launches=9',
    'GET /stats/ranking?by=launch&order=asc&limit=10&offset=20&to=2026-10-31&launches=9',
    'GET /stats/accounts?from=2026-10-01&to=2026-10-31',
    'GET /accounts/1/growth?from=2026-10-01&to=2026-10-31',
    'GET /stats/search?from=2026-10-01&to=2026-10-31&launches=9%2C10',
  ]);
});

test('arguments that are not valid are refused before the API is called', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const cases: Array<[string, unknown, RegExp]> = [
    ['get_stats_series', {}, /metric/],
    ['get_stats_series', { metric: 'likes' }, /metric/],
    ['get_stats_series', { metric: 'views', group_by: 'post' }, /group_by/],
    ['get_stats_series', { metric: 'views', limit: 51 }, /limit/],
    ['get_stats_ranking', { order: 'up' }, /order/],
    ['get_stats_ranking', { limit: 0 }, /limit/],
    ['get_stats_overview', { compare: 'last-year' }, /compare/],
    ['get_stats_overview', { channels: ['myspace'] }, /channels/],
    ['get_stats_overview', { account_ids: [0] }, /account_ids/],
    ['get_stats_overview', { launch_ids: [] }, /launch_ids/],
    ['get_stats_accounts', { from: 'yesterday' }, /from: a day, YYYY-MM-DD/],
    ['get_account_growth', {}, /account_id/],
    ['get_search_index_status', { launch_ids: Array.from({ length: 51 }, (_, i) => i + 1) }, /launch_ids/],
  ];
  for (const [name, args, message] of cases) assert.match(await refusal(api, name, args), message, `${name} ${JSON.stringify(args)}`);
  assert.deepEqual(fake.calls, []);
});

test('what the API refuses reaches the model in the API\'s words', async () => {
  const { api } = fakeClient({ 'GET /stats/overview': () => apiError(400, 'invalid_input', 'compareFrom and compareTo go together') });
  assert.match(await refusal(api, 'get_stats_overview', { compare_from: '2026-09-01' }), /compareFrom and compareTo go together/);
  const missing = fakeClient({ 'GET /accounts/999/growth': () => apiError(404, 'not_found', 'no such account') });
  assert.match(await refusal(missing.api, 'get_account_growth', { account_id: 999 }), /no such account/);
});
