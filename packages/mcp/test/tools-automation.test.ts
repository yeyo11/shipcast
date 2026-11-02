import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_GUIDES } from '../src/index.ts';
import { guide } from '../src/tools/automation.ts';
import { acceptedJob, apiError, fakeClient, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const state = { mode: 'poll', intervalSeconds: 300, running: false, lastRound: null, lastDelivery: null, webhookUrl: 'https://shipcast.example/api/github/webhook', hasSecret: true, appWebhooks: false, triggers: [] };

const ROUTES: FakeRoutes = {
  'GET /automation': state,
  'PATCH /automation': ({ body }) => Response.json({ mode: 'poll', intervalSeconds: 300, ...(JSON.parse(body) as object) }),
  'PUT /automation/triggers': ({ body }) => Response.json(JSON.parse(body) as object),
  'POST /automation/round': acceptedJob('round-1'),
};

const releases = { id: 'releases', event: 'release', repos: 'yeyo11/*', channels: ['blog', 'bluesky'] };

test('the automation tools make their one API call each, in the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.equal((await runTool(api, 'get_automation', {}) as { hasSecret: boolean }).hasSecret, true);
  await runTool(api, 'set_automation', { mode: 'webhook', interval_seconds: 600, confirm: true });
  await runTool(api, 'set_triggers', { rules: [releases], confirm: true });
  await runTool(api, 'run_round_now', { confirm: true });
  assert.deepEqual(fake.calls, [
    'GET /automation',
    'PATCH /automation {"mode":"webhook","intervalSeconds":600}',
    'PUT /automation/triggers {"rules":[{"id":"releases","event":"release","repos":"yeyo11/*","channels":["blog","bluesky"]}]}',
    'POST /automation/round',
  ]);
});

test('turning automation or a rule on needs confirm: true; turning it off or the interval alone does not', async () => {
  const { fake, api } = fakeClient(ROUTES);
  for (const args of [{ mode: 'poll' }, { mode: 'webhook', confirm: false }]) {
    assert.match(await refusal(api, 'set_automation', args), /Nothing was changed\. Turning automation on .* without the user.*set_automation again with confirm: true/);
  }
  assert.match(await refusal(api, 'set_triggers', { rules: [releases] }), /Nothing was changed\. Saving enabled trigger rules .*set_triggers again with confirm: true/);
  assert.match(await refusal(api, 'set_automation', {}), /needs mode, interval_seconds or both/);
  assert.match(await refusal(api, 'set_automation', { interval_seconds: 30 }), /Invalid arguments for set_automation/);
  assert.match(await refusal(api, 'set_triggers', { rules: [{ ...releases, id: 'Releases!' }], confirm: true }), /Invalid arguments for set_triggers/);
  assert.deepEqual(fake.calls, [], 'the API was never called');

  await runTool(api, 'set_automation', { mode: 'off' });
  await runTool(api, 'set_automation', { interval_seconds: 120 });
  await runTool(api, 'set_triggers', { rules: [] });
  await runTool(api, 'set_triggers', { rules: [{ ...releases, enabled: false }] });
  assert.deepEqual(fake.calls, [
    'PATCH /automation {"mode":"off"}',
    'PATCH /automation {"intervalSeconds":120}',
    'PUT /automation/triggers {"rules":[]}',
    'PUT /automation/triggers {"rules":[{"id":"releases","enabled":false,"event":"release","repos":"yeyo11/*","channels":["blog","bluesky"]}]}',
  ]);
});

test('run_round_now says it may publish, needs confirm: true, answers its job, and passes on a refusal', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'run_round_now', {}), /Nothing was changed\. Running a round, which may publish what is due, cannot be undone.*run_round_now again with confirm: true/);
  assert.deepEqual(fake.calls, []);
  assert.match(JSON.stringify(await runTool(api, 'run_round_now', { confirm: true })), /"job":"round-1".*list_jobs.*get_automation/);
  const busy = fakeClient({ ...ROUTES, 'POST /automation/round': () => apiError(409, 'refused', 'a round is running already') });
  assert.match(await refusal(busy.api, 'run_round_now', { confirm: true }), /a round is running already/);
});

test('the area has its line in the server\'s instructions', () => {
  assert.ok(guide.length > 0);
  assert.ok(TOOL_GUIDES.includes(guide));
});
