import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClient, refusal, runTool } from './fake-api.ts';

test('the launch tools make their one API call each', async () => {
  const { fake, api } = fakeClient();
  await runTool(api, 'list_launches', { limit: 5, status: 'published' });
  await runTool(api, 'get_launch', { launch_id: 3 });
  const launched = await runTool(api, 'launch_repo', { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  assert.match(JSON.stringify(launched), /"job":"j1".*list_jobs/);
  await runTool(api, 'approve_drafts', { launch_id: 3 });
  await runTool(api, 'write_article', { title: 'Hello', markdown: 'Body', lang: 'en', channels: ['devto'] });
  await runTool(api, 'retry_channel', { launch_id: 3, channel: 'devto' });
  assert.deepEqual(fake.calls, [
    'GET /launches?limit=5&status=published',
    'GET /launches/3',
    'POST /launches {"repo":"yeyo11/claudio","ref":"v1.0.0","direct":false}',
    'POST /launches/3/approve',
    'POST /articles {"title":"Hello","markdown":"Body","lang":"en","channels":["devto"],"direct":false}',
    'POST /launches/3/retry/devto',
  ]);
});

test('list_launches passes every filter GET /launches takes', async () => {
  const { fake, api } = fakeClient();
  await runTool(api, 'list_launches', { limit: 10, cursor: 'abc', status: 'failed', trigger: 'manual', kind: 'minor', repo: 'yeyo11/claudio', q: 'mcp server', sort: 'oldest' });
  await runTool(api, 'list_launches', {});
  assert.deepEqual(fake.calls, ['GET /launches?limit=10&cursor=abc&status=failed&trigger=manual&kind=minor&repo=yeyo11%2Fclaudio&q=mcp+server&sort=oldest', 'GET /launches']);
});

test('the launch tools refuse what the API would, before calling it', async () => {
  const { fake, api } = fakeClient();
  for (const [name, args] of [
    ['launch_repo', { repo: 'not a repo' }],
    ['get_launch', { launch_id: -1 }],
    ['get_launch', {}],
    ['list_launches', { limit: 500 }],
    ['list_launches', { trigger: 'cron' }],
    ['list_launches', { kind: 'patch' }],
    ['list_launches', { sort: 'random' }],
    ['list_launches', { repo: 'claudio' }],
    ['list_launches', { q: 'x'.repeat(201) }],
    ['retry_channel', { launch_id: 3, channel: 'myspace' }],
    ['write_article', { title: 'x', markdown: 'y', lang: 'fr' }],
  ] as const) {
    assert.match(await refusal(api, name, args), new RegExp(`Invalid arguments for ${name}`), `${name} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(fake.calls, []);
});
