import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiClient, invoke, redact, ShipcastApiError, toolByName, TOOLS, type ShipcastTool } from '../src/index.ts';
import { fakeApi, READ_ONLY, TOKEN } from './fake-api.ts';

const BASE = 'https://shipcast.example';

function setup(token = TOKEN) {
  const fake = fakeApi();
  const api = createApiClient({ baseUrl: BASE, token, fetch: async (url, init) => fake.handle(new Request(url, init)) });
  return { fake, api };
}

const named = (name: string): ShipcastTool => {
  const tool = toolByName(name);
  assert.ok(tool, name);
  return tool;
};

test('the tools are the ones the plan names, each with a description and hints', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    'list_launches',
    'get_launch',
    'launch_repo',
    'approve_drafts',
    'write_article',
    'retry_channel',
    'list_accounts',
    'list_jobs',
    'get_capabilities',
    'edit_post',
    'delete_post',
  ]);
  for (const tool of TOOLS) {
    assert.ok(tool.description.length > 60, `${tool.name} has a description a model can use`);
    assert.ok(!(tool.hints.readOnlyHint && tool.hints.destructiveHint), `${tool.name} is not both read-only and destructive`);
  }
  const readOnly = TOOLS.filter((t) => t.hints.readOnlyHint).map((t) => t.name);
  assert.deepEqual(readOnly, ['list_launches', 'get_launch', 'list_accounts', 'list_jobs', 'get_capabilities']);
  assert.deepEqual(TOOLS.filter((t) => t.hints.destructiveHint).map((t) => t.name), ['edit_post', 'delete_post']);
});

test('each tool makes its one API call', async () => {
  const { fake, api } = setup();
  const run = async (name: string, args: unknown) => {
    const outcome = await invoke(named(name), api, args);
    assert.ok(outcome.ok, `${name}: ${outcome.ok ? '' : outcome.message}`);
    return outcome.value;
  };
  await run('list_launches', { limit: 5, status: 'published' });
  await run('get_launch', { launch_id: 3 });
  const launched = await run('launch_repo', { repo: 'yeyo11/claudio', ref: 'v1.0.0' });
  assert.match(JSON.stringify(launched), /"job":"j1".*list_jobs/);
  await run('approve_drafts', { launch_id: 3 });
  await run('write_article', { title: 'Hello', markdown: 'Body', lang: 'en', channels: ['devto'] });
  await run('retry_channel', { launch_id: 3, channel: 'devto' });
  await run('list_accounts', {});
  await run('list_jobs', undefined);
  await run('get_capabilities', {});
  await run('edit_post', { post_id: 12, text: 'Fixed', image_url: 'https://img.example/a.png' });
  await run('delete_post', { post_id: 12, confirm: true });
  assert.deepEqual(fake.calls, [
    'GET /launches?limit=5&status=published',
    'GET /launches/3',
    'POST /launches {"repo":"yeyo11/claudio","ref":"v1.0.0","direct":false}',
    'POST /launches/3/approve',
    'POST /articles {"title":"Hello","markdown":"Body","lang":"en","channels":["devto"],"direct":false}',
    'POST /launches/3/retry/devto',
    'GET /accounts',
    'GET /jobs',
    'GET /capabilities',
    'PATCH /posts/12 {"text":"Fixed","imageUrl":"https://img.example/a.png"}',
    'DELETE /posts/12',
  ]);
});

test('the schemas refuse what the API would, before calling it', async () => {
  const { fake, api } = setup();
  for (const [name, args] of [
    ['launch_repo', { repo: 'not a repo' }],
    ['get_launch', { launch_id: -1 }],
    ['get_launch', {}],
    ['list_launches', { limit: 500 }],
    ['retry_channel', { launch_id: 3, channel: 'myspace' }],
    ['write_article', { title: 'x', markdown: 'y', lang: 'fr' }],
    ['edit_post', { post_id: 12, link: 'not a url' }],
  ] as const) {
    const outcome = await invoke(named(name), api, args);
    assert.equal(outcome.ok, false, `${name} ${JSON.stringify(args)}`);
    assert.match(outcome.ok ? '' : outcome.message, new RegExp(`Invalid arguments for ${name}`));
  }
  assert.deepEqual(fake.calls, []);
});

test('delete_post deletes nothing without confirm: true, and edit_post needs a field', async () => {
  const { fake, api } = setup();
  for (const args of [{ post_id: 12 }, { post_id: 12, confirm: false }]) {
    const outcome = await invoke(named('delete_post'), api, args);
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.message, /Nothing was deleted.*confirm: true/);
  }
  const edit = await invoke(named('edit_post'), api, { post_id: 12 });
  assert.match(edit.ok ? '' : edit.message, /at least one field/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('API errors become messages that say what to do next', async () => {
  const { api } = setup();
  const message = async (name: string, args: unknown, using = api) => {
    const outcome = await invoke(named(name), using, args);
    assert.equal(outcome.ok, false);
    return outcome.ok ? '' : outcome.message;
  };
  assert.match(await message('get_launch', { launch_id: 99 }), /no such launch \(404 not_found\)\. .*list_launches/);
  assert.match(await message('launch_repo', { repo: 'yeyo11/old' }), /launched already \(409 refused\)\. .*Do not retry/);
  assert.match(await message('edit_post', { post_id: 13, text: 'x' }), /Text is too long \(502 upstream\)/);
  assert.match(await message('launch_repo', { repo: 'yeyo11/claudio' }, setup(READ_ONLY).api), /lacks the write scope \(403 insufficient_scope\)\. .*read,write/);
  assert.match(await message('list_jobs', {}, setup('shipcast_1_wrong').api), /\(401 unauthorized\)\. .*token create/);

  const limited = await api.call('GET', '/slow').catch((e: unknown) => e);
  assert.ok(limited instanceof ShipcastApiError);
  assert.equal(limited.retryAfter, 120);
});

test('failures that never reach the API, and the token never shows in a message', async () => {
  const down = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: async () => { throw new Error(`connect ECONNREFUSED (sent ${TOKEN})`); } });
  const outcome = await invoke(named('list_jobs'), down, {});
  assert.match(outcome.ok ? '' : outcome.message, /could not reach Shipcast at https:\/\/shipcast\.example.*\(unreachable\)\. Check SHIPCAST_API_URL/);
  assert.ok(!(outcome.ok ? '' : outcome.message).includes(TOKEN));

  const html = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: async () => new Response('<html>', { status: 200 }) });
  const bad = await invoke(named('list_jobs'), html, {});
  assert.match(bad.ok ? '' : bad.message, /without JSON.*\(200 bad_response\)/);

  const { api } = setup();
  const echoed = await api.call('GET', '/echo-token').catch((e: unknown) => e);
  assert.ok(echoed instanceof ShipcastApiError);
  assert.equal(echoed.message, 'the header was Bearer [token]');
  assert.equal(redact('a b a', 'a'), '[token] b [token]');
});
