import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClient, refusal, runTool } from './fake-api.ts';

test('list_jobs reads a page of jobs, with its size and the cursor of the previous page', async () => {
  const { fake, api } = fakeClient({ 'GET /jobs': { jobs: [{ id: 'j1', title: 'Drafting', state: 'active', log: [], link: null, startedAt: '2026-10-25T10:00:00.000Z' }], next: 'page2' } });
  const page = await runTool(api, 'list_jobs', undefined);
  assert.equal((page as { next: string }).next, 'page2');
  await runTool(api, 'list_jobs', { limit: 5, cursor: 'page2' });
  assert.match(await refusal(api, 'list_jobs', { limit: 0 }), /Invalid arguments for list_jobs/);
  assert.deepEqual(fake.calls, ['GET /jobs', 'GET /jobs?limit=5&cursor=page2']);
});
