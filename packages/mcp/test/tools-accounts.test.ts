import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClient, runTool } from './fake-api.ts';

test('list_accounts reads the connected accounts', async () => {
  const { fake, api } = fakeClient();
  const answer = await runTool(api, 'list_accounts', {});
  assert.equal((answer as { accounts: Array<{ network: string }> }).accounts[0]?.network, 'mastodon');
  assert.deepEqual(fake.calls, ['GET /accounts']);
});
