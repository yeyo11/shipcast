import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { memoryRegistry } from '@shipcast/engine/testing';
import { AI_TASK_DEFINITIONS } from '@shipcast/schema';
import { createRuntime, MemoryStore, SettingMissing } from '../src/index.ts';

const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const BOOTSTRAP = {
  SHIPCAST_DATABASE_URL: 'postgres://shipcast:x@127.0.0.1:5432/shipcast',
  SHIPCAST_GITHUB_APP_ID: '1',
  SHIPCAST_GITHUB_APP_SLUG: 'shipcast-test',
  SHIPCAST_GITHUB_APP_CLIENT_ID: 'Iv23app',
  SHIPCAST_GITHUB_APP_CLIENT_SECRET: 's',
  SHIPCAST_GITHUB_APP_PRIVATE_KEY: pem,
  SHIPCAST_ALLOWED_GITHUB: 'yeyo11',
};

/** GitHub, for the reads a start and a brand make; anything else is a test failure */
function fakeGitHub(seen: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}`;
    seen.push(key);
    if (key === 'GET /repos/yeyo11/launches/installation' || key === 'GET /users/yeyo11/installation') {
      return Response.json({ id: 9, account: { login: 'yeyo11' }, repository_selection: 'all', permissions: {} });
    }
    if (key === 'POST /app/installations/9/access_tokens') return Response.json({ token: 'ghs_t', expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    if (key === 'GET /repos/yeyo11/launches/contents/brand.yml') {
      return new Response('id: personal\ndisplayName: Me\nsite: https://josegarrido.dev\ngithub: yeyo11\n');
    }
    throw new Error(`unexpected ${key}`);
  }) as typeof fetch;
}

test('the runtime starts with only the bootstrap: what needs a setting says which one', async () => {
  const lines: string[] = [];
  const seen: string[] = [];
  const runtime = await createRuntime({ env: BOOTSTRAP, root: '/repo', registry: await memoryRegistry(), secrets: new MemoryStore(), fetch: fakeGitHub(seen), log: (l) => lines.push(l) });
  assert.deepEqual(lines, [], 'nothing to import');
  assert.deepEqual(runtime.settings.missing(), ['launchesRepo', 'claudioUrl', 'claudioToken']);
  assert.deepEqual(runtime.access, { kind: 'app', slug: 'shipcast-test', bot: 'shipcast-test[bot]' });
  assert.equal(runtime.pipeline.launchesRepo, '');
  await assert.rejects(runtime.brand(), (e) => e instanceof SettingMissing && /launches repo is not set/.test(e.message));
  // The runner is always built; a task reads the provider when it runs, before any call
  assert.equal(runtime.pipeline.aiRunner, runtime.aiRunner);
  await assert.rejects(runtime.aiRunner.run(AI_TASK_DEFINITIONS.article, { prompt: 'x' }), SettingMissing, 'claudio is the default provider and has no URL yet');
  // Before a launches repo is set the App finds the owner's own installation
  assert.equal((await runtime.githubApp!.installation()).id, 9);
  assert.ok(seen.includes('GET /users/yeyo11/installation'));
  assert.deepEqual(seen.filter((s) => s.startsWith('POST')), [], 'no token is minted until a request needs one');

  // A setting saved (as the Settings page does) is read by the next thing that runs, with no restart
  await runtime.settings.write({ launchesRepo: 'yeyo11/launches', claudioUrl: 'http://claudio:8798', claudioToken: 't' });
  await runtime.refresh();
  assert.equal(runtime.pipeline.launchesRepo, 'yeyo11/launches');
  assert.equal((await runtime.brand()).github, 'yeyo11');
  assert.ok(seen.includes('POST /app/installations/9/access_tokens'), 'the brand is read with an installation token');
  assert.deepEqual(runtime.settings.claudio(), { url: 'http://claudio:8798', token: 't' }, 'what the runner reads for claudio when the next task runs');
});

test('an install from before the settings keeps working: its .env values are imported at start, once', async () => {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const env = { ...BOOTSTRAP, SHIPCAST_LAUNCHES_REPO: 'yeyo11/launches', SHIPCAST_CLAUDIO_URL: 'http://claudio:8798', SHIPCAST_CLAUDIO_TOKEN: 'secret-value' };
  const lines: string[] = [];
  const first = await createRuntime({ env, root: '/repo', registry, secrets, fetch: fakeGitHub([]), log: (l) => lines.push(l) });
  assert.deepEqual(first.settings.missing(), []);
  assert.equal(first.pipeline.launchesRepo, 'yeyo11/launches');
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /imported SHIPCAST_LAUNCHES_REPO, SHIPCAST_CLAUDIO_URL, SHIPCAST_CLAUDIO_TOKEN from \.env/);
  assert.ok(!lines[0]!.includes('secret-value'), 'never a value in the log');

  lines.length = 0;
  await createRuntime({ env, root: '/repo', registry, secrets, fetch: fakeGitHub([]), log: (l) => lines.push(l) });
  assert.deepEqual(lines, [], 'the second start imports nothing');
});

test('without an App the engine runs on the old token, as before', async () => {
  const seen: string[] = [];
  const runtime = await createRuntime({
    env: { SHIPCAST_DATABASE_URL: BOOTSTRAP.SHIPCAST_DATABASE_URL, GITHUB_TOKEN_PERSONAL: 'ghp', SHIPCAST_LAUNCHES_REPO: 'yeyo11/launches' },
    root: '/repo',
    registry: await memoryRegistry(),
    secrets: new MemoryStore(),
    fetch: fakeGitHub(seen),
  });
  assert.deepEqual(runtime.access, { kind: 'token' });
  assert.equal(runtime.githubApp, undefined);
  assert.equal(runtime.userTokens, undefined);
  assert.equal((await runtime.brand()).id, 'personal');
  assert.deepEqual(seen, ['GET /repos/yeyo11/launches/contents/brand.yml']);
});
