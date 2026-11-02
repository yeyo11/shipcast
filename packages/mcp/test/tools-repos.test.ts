import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_GUIDES } from '../src/tools/index.ts';
import { apiError, fakeClient, named, READ_ONLY, refusal, runTool, type FakeRoutes } from './fake-api.ts';

const preflight = { repo: 'yeyo11/claudio', ref: 'v1.1.0', ok: false, checks: [{ id: 'readme', ok: false, required: true, detail: 'No README at v1.1.0: add one that says what the project does.' }] };

const ROUTES: FakeRoutes = {
  'GET /repos': { owner: 'yeyo11', repos: [{ repo: 'yeyo11/claudio', description: null, pushedAt: '2026-10-30T10:00:00Z' }] },
  'GET /repos/releases': ({ url }) =>
    url.searchParams.get('repo') === 'yeyo11/nothing'
      ? apiError(404, 'not_found', 'GitHub has no repo yeyo11/nothing that Shipcast can read')
      : Response.json({ repo: 'yeyo11/claudio', releases: [{ tag: 'v1.0.0', name: 'First', publishedAt: '2026-10-01T10:00:00Z', prerelease: false, launch: { id: 3, status: 'published' } }] }),
  'GET /repos/preflight': preflight,
};

test('the repos tools make their one read each, in the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  await runTool(api, 'list_repos', {});
  const releases = await runTool(api, 'list_releases', { repo: 'yeyo11/claudio' });
  const checked = await runTool(api, 'check_repo', { repo: 'yeyo11/claudio', ref: 'v1.1.0' });
  await runTool(api, 'check_repo', { repo: 'yeyo11/claudio' });
  assert.deepEqual(fake.calls, ['GET /repos', 'GET /repos/releases?repo=yeyo11%2Fclaudio', 'GET /repos/preflight?repo=yeyo11%2Fclaudio&ref=v1.1.0', 'GET /repos/preflight?repo=yeyo11%2Fclaudio']);
  assert.match(JSON.stringify(releases), /"launch":\{"id":3,"status":"published"\}/);
  assert.deepEqual(checked, preflight);
});

test('the repos tools only read, so a read-only token is enough', async () => {
  const { api } = fakeClient(ROUTES, READ_ONLY);
  for (const name of ['list_repos', 'list_releases', 'check_repo']) assert.equal(named(name).hints.readOnlyHint, true, name);
  await runTool(api, 'list_repos', {});
  await runTool(api, 'check_repo', { repo: 'yeyo11/claudio' });
});

test('a repo is owner/name before the API is called, and the API\'s refusal reaches the model', async () => {
  const { fake, api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'list_releases', { repo: 'claudio' }), /Invalid arguments for list_releases/);
  assert.match(await refusal(api, 'check_repo', { repo: 'yeyo11/claudio', ref: '' }), /Invalid arguments for check_repo/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
  assert.match(await refusal(api, 'list_releases', { repo: 'yeyo11/nothing' }), /GitHub has no repo yeyo11\/nothing/);
});

test('the guide sends the model to check_repo before launch_repo, and to list_releases for what was launched', () => {
  const guide = TOOL_GUIDES.find((g) => g.startsWith('Repos:'));
  assert.ok(guide);
  assert.match(guide, /check_repo .*before launch_repo/);
  assert.match(guide, /list_releases .*a release launches only once/);
  assert.match(named('check_repo').description, /step before launch_repo/);
  assert.match(named('list_releases').description, /already launched/);
});
