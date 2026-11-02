import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClient, refusal, runTool } from './fake-api.ts';

test('the launch tools make their one API call each', async () => {
  const { fake, api } = fakeClient();
  await runTool(api, 'list_launches', { limit: 5, status: 'published' });
  await runTool(api, 'get_launch', { launch_id: 3 });
  const launched = await runTool(api, 'launch_repo', { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  assert.match(JSON.stringify(launched), /"job":"j1".*list_jobs/);
  await runTool(api, 'approve_drafts', { launch_id: 3, confirm: true });
  await runTool(api, 'approve_drafts', { launch_id: 3, versions: { '11': 2 }, confirm: true });
  await runTool(api, 'write_article', { title: 'Hello', markdown: 'Body', lang: 'en', channels: ['devto'] });
  await runTool(api, 'write_article', { title: 'Shot', markdown: '![The setup](/articles/shot/0123456789abcdef.png)', lang: 'en', images: [{ sha256: `0123456789abcdef${'0'.repeat(48)}`, name: '0123456789abcdef.png' }] });
  await runTool(api, 'retry_channel', { launch_id: 3, channel: 'devto' });
  assert.deepEqual(fake.calls, [
    'GET /launches?limit=5&status=published',
    'GET /launches/3',
    'POST /launches {"repo":"yeyo11/claudio","ref":"v1.0.0","direct":false}',
    'POST /launches/3/approve',
    'POST /launches/3/approve {"versions":{"11":2}}',
    'POST /articles {"title":"Hello","markdown":"Body","lang":"en","channels":["devto"],"direct":false}',
    `POST /articles {"title":"Shot","markdown":"![The setup](/articles/shot/0123456789abcdef.png)","lang":"en","channels":[],"images":[{"sha256":"0123456789abcdef${'0'.repeat(48)}","name":"0123456789abcdef.png"}],"direct":false}`,
    'POST /launches/3/retry/devto',
  ]);
});

test('approving, and publishing without a review, need confirm: true', async () => {
  const { fake, api } = fakeClient();
  for (const args of [{ launch_id: 3 }, { launch_id: 3, confirm: false }]) {
    assert.match(await refusal(api, 'approve_drafts', args), /Nothing was changed\. Approving launch 3, which publishes it, cannot be undone.*approve_drafts again with confirm: true/);
  }
  assert.match(await refusal(api, 'launch_repo', { repo: 'yeyo11/claudio', direct: true }), /without reviewing its drafts cannot be undone.*launch_repo again with confirm: true/);
  assert.match(await refusal(api, 'write_article', { title: 'Hello', markdown: 'Body', lang: 'en', direct: true }), /write_article again with confirm: true/);
  assert.deepEqual(fake.calls, [], 'the API was never called');

  await runTool(api, 'launch_repo', { repo: 'yeyo11/claudio', direct: true, confirm: true });
  assert.deepEqual(fake.calls, ['POST /launches {"repo":"yeyo11/claudio","direct":true}']);
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
