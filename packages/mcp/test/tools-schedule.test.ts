import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiError, fakeClient, named, refusal, runTool } from './fake-api.ts';

const scheduled = { id: 20, launchId: 3, channel: 'bluesky', kind: 'post', status: 'scheduled', scheduledAt: '2026-11-03T16:00:00.000Z' };

const ROUTES = {
  'POST /launches/3/schedule': { posts: [scheduled] },
  'PATCH /posts/20/schedule': { post: { ...scheduled, scheduledAt: '2026-11-04T08:00:00.000Z' } },
  'PATCH /posts/12/schedule': () => apiError(409, 'refused', 'post 12 is live, not scheduled'),
  'DELETE /posts/20/schedule': { post: scheduled },
  'GET /recommendations': { channel: 'bluesky', timezone: 'Europe/Madrid', slots: [], history: { posts: 0, used: 0, median: null, what: null }, audience: false },
  'GET /settings/timezone': { timezone: 'Europe/Madrid' },
  'PATCH /settings/timezone': ({ body }: { body: string }) => {
    const { timezone } = JSON.parse(body) as { timezone: string };
    return timezone.startsWith('+') ? apiError(400, 'invalid', 'timezone is an IANA zone such as Europe/Madrid') : Response.json({ timezone });
  },
};

test('the schedule tools make their one API call each, with the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  await runTool(api, 'schedule_launch', { launch_id: 3, times: { bluesky: '2026-11-03T17:00:00+01:00', mastodon: '2026-11-03T16:00Z' } });
  await runTool(api, 'reschedule_post', { post_id: 20, at: '2026-11-04T09:00:00+01:00' });
  await runTool(api, 'cancel_scheduled_post', { post_id: 20 });
  await runTool(api, 'recommend_times', { channel: 'bluesky' });
  await runTool(api, 'recommend_times', { channel: 'mastodon', days: 14, count: 3 });
  assert.deepEqual(await runTool(api, 'get_timezone', {}), { timezone: 'Europe/Madrid' });
  assert.deepEqual(await runTool(api, 'set_timezone', { timezone: 'America/New_York' }), { timezone: 'America/New_York' });
  assert.deepEqual(fake.calls, [
    'POST /launches/3/schedule {"times":{"bluesky":"2026-11-03T17:00:00+01:00","mastodon":"2026-11-03T16:00Z"}}',
    'PATCH /posts/20/schedule {"at":"2026-11-04T09:00:00+01:00"}',
    'DELETE /posts/20/schedule',
    'GET /recommendations?channel=bluesky',
    'GET /recommendations?channel=mastodon&days=14&count=3',
    'GET /settings/timezone',
    'PATCH /settings/timezone {"timezone":"America/New_York"}',
  ]);
});

test('a time without its offset, a channel with no time and an empty schedule never reach the API', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'schedule_launch', { launch_id: 3, times: { bluesky: '2026-11-03T17:00:00' } }), /Invalid arguments for schedule_launch: times\.bluesky: an ISO 8601 date-time with its offset/);
  assert.match(await refusal(api, 'schedule_launch', { launch_id: 3, times: { blog: '2026-11-03T17:00:00Z' } }), /Invalid arguments for schedule_launch/);
  assert.match(await refusal(api, 'schedule_launch', { launch_id: 3, times: {} }), /needs at least one channel and its time/);
  assert.match(await refusal(api, 'reschedule_post', { post_id: 20, at: 'tomorrow' }), /Invalid arguments for reschedule_post: at:/);
  assert.match(await refusal(api, 'recommend_times', { channel: 'reddit' }), /Invalid arguments for recommend_times/);
  assert.match(await refusal(api, 'recommend_times', { channel: 'bluesky', days: 31 }), /Invalid arguments for recommend_times/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('the API\'s refusals reach the model: a piece already out, a zone given as an offset', async () => {
  const { api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'reschedule_post', { post_id: 12, at: '2026-11-04T09:00:00Z' }), /post 12 is live, not scheduled/);
  assert.match(await refusal(api, 'set_timezone', { timezone: '+01:00' }), /IANA zone/);
});

test('the schedule tools are annotated for what they change', () => {
  for (const name of ['recommend_times', 'get_timezone']) assert.equal(named(name).hints.readOnlyHint, true, name);
  for (const name of ['schedule_launch', 'reschedule_post', 'cancel_scheduled_post']) {
    assert.equal(named(name).hints.readOnlyHint, false, name);
    assert.equal(named(name).hints.destructiveHint, true, `${name} changes what goes public, and when`);
  }
  assert.equal(named('reschedule_post').hints.openWorldHint, true, 'a time now or past publishes on the next run');
  assert.equal(named('cancel_scheduled_post').hints.openWorldHint, false, 'cancelling touches no network');
  assert.deepEqual(named('set_timezone').hints, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
});
