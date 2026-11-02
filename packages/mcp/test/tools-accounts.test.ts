import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedJob, apiError, fakeClient, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const ROUTES: FakeRoutes = {
  'POST /accounts/1/check': { account: { id: 1, network: 'mastodon', status: 'ok', identity: '@me@m.example', problem: null } },
  'POST /accounts/1/sync': acceptedJob('j5'),
  'POST /accounts/9/sync': () => apiError(404, 'not_found', 'no such account'),
  'PATCH /accounts/1': { account: { id: 1, label: 'Personal' } },
  'POST /accounts/1/primary': { account: { id: 1, primary: true } },
};

test('list_accounts reads the connected accounts', async () => {
  const { fake, api } = fakeClient();
  const answer = await runTool(api, 'list_accounts', {});
  assert.equal((answer as { accounts: Array<{ network: string }> }).accounts[0]?.network, 'mastodon');
  assert.deepEqual(fake.calls, ['GET /accounts']);
});

test('the account tools make their one API call each, in the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const checked = await runTool(api, 'check_account', { account_id: 1 });
  assert.equal((checked as { account: { status: string } }).account.status, 'ok');
  await runTool(api, 'rename_account', { account_id: 1, label: '  Personal ' });
  await runTool(api, 'make_primary_account', { account_id: 1 });
  assert.deepEqual(fake.calls, ['POST /accounts/1/check', 'PATCH /accounts/1 {"label":"Personal"}', 'POST /accounts/1/primary']);
});

test('sync_account answers the job and where to read its numbers, and an unknown account is the API\'s refusal', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const started = await runTool(api, 'sync_account', { account_id: 1 });
  assert.match(JSON.stringify(started), /"job":"j5".*list_jobs.*get_account_growth/);
  assert.match(await refusal(api, 'sync_account', { account_id: 9 }), /no such account/);
  assert.deepEqual(fake.calls, ['POST /accounts/1/sync', 'POST /accounts/9/sync']);
});

test('the account tools check their input before calling the API', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'rename_account', { account_id: 1, label: '   ' }), /Invalid arguments for rename_account/);
  assert.match(await refusal(api, 'rename_account', { account_id: 1, label: 'x'.repeat(201) }), /Invalid arguments for rename_account/);
  assert.match(await refusal(api, 'check_account', { account_id: 0 }), /Invalid arguments for check_account/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});
