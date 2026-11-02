import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedJob, apiError, fakeClient, refusal, runTool } from './fake-api.ts';

/* The drafts tools against the fake API: each one call, the article path in the query, publish_again behind confirm */

const ARTICLE = 'src/content/posts/en/claudio.md';
const preview = { branch: 'preview/launch-3-abc', number: 40, pullRequest: 'https://github.com/yeyo11/launches/pull/40', sha: 'c1', at: '2026-11-01T10:00:00.000Z' };

const routes = {
  'GET /launches/3/draft': { draft: { path: ARTICLE, label: 'Article (en)', kind: 'article', content: '# Claudio\n' }, open: true },
  'PUT /launches/3/draft': { path: ARTICLE },
  'POST /launches/3/site-preview': { preview },
  'GET /launches/3/site-preview': { preview: { ...preview, url: 'https://preview-abc.workers.dev' } },
  'POST /launches/3/publish': acceptedJob('j7'),
};

test('the drafts tools make their one API call each', async () => {
  const { fake, api } = fakeClient(routes);
  const read = await runTool(api, 'get_draft', { launch_id: 3, path: ARTICLE });
  assert.equal((read as { draft: { content: string } }).draft.content, '# Claudio\n');
  await runTool(api, 'edit_draft', { launch_id: 3, path: ARTICLE, content: '# Claudio, edited\n' });
  await runTool(api, 'preview_on_site', { launch_id: 3 });
  const found = await runTool(api, 'get_site_preview', { launch_id: 3 });
  assert.equal((found as { preview: { url: string } }).preview.url, 'https://preview-abc.workers.dev');
  const published = await runTool(api, 'publish_again', { launch_id: 3, confirm: true });
  assert.match(JSON.stringify(published), /"job":"j7".*list_jobs/);
  assert.deepEqual(fake.calls, [
    'GET /launches/3/draft?path=src%2Fcontent%2Fposts%2Fen%2Fclaudio.md',
    `PUT /launches/3/draft {"path":"${ARTICLE}","content":"# Claudio, edited\\n"}`,
    'POST /launches/3/site-preview',
    'GET /launches/3/site-preview',
    'POST /launches/3/publish',
  ]);
});

test('publish_again needs confirm: true, and calls nothing without it', async () => {
  const { fake, api } = fakeClient(routes);
  for (const args of [{ launch_id: 3 }, { launch_id: 3, confirm: false }]) {
    assert.match(await refusal(api, 'publish_again', args), /Nothing was changed\. Publishing launch 3 cannot be undone.*publish_again again with confirm: true/);
  }
  assert.deepEqual(fake.calls, []);
});

test('the API’s refusals reach the model in its words', async () => {
  const { api } = fakeClient({
    'PUT /launches/3/draft': () => apiError(409, 'refused', 'src/content/posts/en/claudio.md is on the site already: the article is not edited here after its commit'),
    'POST /launches/3/publish': () => apiError(409, 'refused', 'the launch is published'),
    'POST /launches/3/site-preview': () => apiError(409, 'refused', 'this launch was decided in its pull request, which had its own preview'),
  });
  assert.match(await refusal(api, 'edit_draft', { launch_id: 3, path: ARTICLE, content: 'x' }), /after its commit \(409 refused\)\. .*tell the user why/);
  assert.match(await refusal(api, 'publish_again', { launch_id: 3, confirm: true }), /the launch is published \(409 refused\)/);
  assert.match(await refusal(api, 'preview_on_site', { launch_id: 3 }), /had its own preview \(409 refused\)/);
});

test('the drafts tools refuse what the API would, before calling it', async () => {
  const { fake, api } = fakeClient(routes);
  for (const [name, args] of [
    ['get_draft', { launch_id: 3 }],
    ['get_draft', { launch_id: 3, path: '' }],
    ['get_draft', { launch_id: 3, path: 'x'.repeat(301) }],
    ['edit_draft', { launch_id: 3, path: ARTICLE }],
    ['edit_draft', { launch_id: 3, path: ARTICLE, content: 'x'.repeat(200_001) }],
    ['get_site_preview', { launch_id: 0 }],
    ['preview_on_site', {}],
  ] as const) {
    assert.match(await refusal(api, name, args), new RegExp(`Invalid arguments for ${name}`), `${name} ${JSON.stringify(args).slice(0, 80)}`);
  }
  assert.deepEqual(fake.calls, []);
});
