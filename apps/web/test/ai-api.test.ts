import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_AI_SETTINGS, DEFAULT_PROMPTS, readAiSettings, type ReviewGitHub } from '@shipcast/engine';
import { aLaunch, FakeGitHub, memoryRegistry, mockRunner, scriptedModel } from '@shipcast/engine/testing';
import { createApiToken, MemoryStore, SettingMissing } from '@shipcast/runtime';
import { Brand } from '@shipcast/schema';
import { FailureLimiter, handleApi, type ApiDeps } from '../src/server/api.ts';
import { aiApi } from '../src/server/ai.server.ts';

/* The AI routes, on a PGlite registry with the brand, GitHub and the providers faked: no AI is called */

const unused = async (): Promise<never> => {
  throw new Error('the AI routes start no other work');
};

const CLAUDIO_TOKEN = 'claudio-token-never-served';
const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11', tone: 'From brand.yml.' });

async function setup(options: { claudio?: boolean; wired?: boolean } = {}) {
  const registry = await memoryRegistry();
  const secrets = new MemoryStore();
  const claudio = options.claudio ?? true;
  const github = new FakeGitHub({ files: {} });
  const ai = aiApi({
    registry,
    secrets,
    github,
    brand: async () => brand,
    settings: {
      current: () => (claudio ? { claudioUrl: 'http://localhost:8798', claudioToken: CLAUDIO_TOKEN } : {}),
      claudio: () => {
        if (!claudio) throw new SettingMissing('claudioUrl');
        return { url: 'http://localhost:8798', token: CLAUDIO_TOKEN };
      },
      launchesRepo: () => 'yeyo11/launches',
    },
    deps: { aiRunner: mockRunner(scriptedModel()) },
  });
  const deps: ApiDeps = {
    registry,
    secrets,
    github: {} as ReviewGitHub,
    launchesRepo: 'yeyo11/launches',
    launchRead: { review: async () => undefined, channelConfig: async () => undefined },
    publicUrl: 'https://shipcast.example',
    limiter: new FailureLimiter(),
    jobs: async () => ({ jobs: [], next: null }),
    startLaunch: unused,
    approve: unused,
    startArticle: unused,
    startPublishing: unused,
    editing: unused,
    armSchedule: unused,
    comments: unused,
    checkComments: unused,
    redraftComment: unused,
    ...(options.wired !== false && { ai }),
  };
  const tokens = { registry, secrets };
  return { deps, registry, github, read: (await createApiToken(tokens, 'reader', ['read'])).token, write: (await createApiToken(tokens, 'writer', ['write'])).token };
}

async function call(deps: ApiDeps, method: string, path: string, token: string, body?: unknown) {
  const response = await handleApi(
    new Request(`https://shipcast.example/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    deps,
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> & { error?: { code: string; message: string } } };
}

test('the AI settings are read with the read scope: each task, the budgets in USD, and whether each provider’s credential is set, never the credential', async () => {
  const s = await setup();
  await s.registry.accounts.addAccount({ network: 'anthropic', brand: 'personal', label: 'Anthropic', settings: {} });
  const read = await call(s.deps, 'GET', '/ai/settings', s.read);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.settings, DEFAULT_AI_SETTINGS);
  assert.equal(read.body.brandTone, 'From brand.yml.');
  assert.deepEqual((read.body.budgets as { defaults: Record<string, number> }).defaults.pack, 5);
  assert.equal((read.body.budgets as { max: number }).max, 50);
  assert.deepEqual(read.body.providers, [
    { id: 'claudio', name: 'claudio', connected: true },
    { id: 'anthropic', name: 'Anthropic API', connected: true },
    { id: 'openaiCompatible', name: 'OpenAI-compatible server', connected: false },
  ]);
  assert.doesNotMatch(read.text, new RegExp(CLAUDIO_TOKEN), 'claudio’s token never leaves the server');

  const unset = await setup({ claudio: false });
  const providers = (await call(unset.deps, 'GET', '/ai/settings', unset.read)).body.providers as Array<{ id: string; connected: boolean }>;
  assert.equal(providers.find((p) => p.id === 'claudio')?.connected, false, 'claudio without its address and token is not connected');
});

test('the settings are replaced with the write scope; a key or token is refused and nothing is saved', async () => {
  const s = await setup();
  const settings = {
    tasks: { pack: { provider: 'anthropic', model: 'claude-opus-5-5' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' }, replies: { provider: 'claudio' }, profile: { provider: 'claudio' } },
    tone: 'Plain.',
    budgets: { pack: 8 },
  };
  assert.equal((await call(s.deps, 'PUT', '/ai/settings', s.read, settings)).status, 403, 'a read token changes nothing');
  const saved = await call(s.deps, 'PUT', '/ai/settings', s.write, settings);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.settings, settings);
  assert.deepEqual(await readAiSettings(s.registry), settings);

  for (const smuggled of [
    { ...settings, apiKey: 'sk-ant-1' },
    { ...settings, tasks: { ...settings.tasks, pack: { provider: 'anthropic', token: 'sk-ant-1' } } },
    { ...settings, claudioToken: 'x' },
  ]) {
    const refused = await call(s.deps, 'PUT', '/ai/settings', s.write, smuggled);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error?.message ?? '', /key or token never comes through the API/);
  }
  assert.deepEqual(await readAiSettings(s.registry), settings, 'a refused body saved nothing');

  const bad = await call(s.deps, 'PUT', '/ai/settings', s.write, { ...settings, tasks: { ...settings.tasks, pack: { provider: 'gpt' } } });
  assert.equal(bad.status, 400, 'an unknown provider is the engine’s 400');
  const over = await call(s.deps, 'PUT', '/ai/settings', s.write, { ...settings, budgets: { pack: 51 } });
  assert.equal(over.status, 400, 'a budget over the maximum is refused');
});

test('one provider for every task keeps the tone, the budgets and a model already on it; a provider is tested without spending', async () => {
  const s = await setup({ claudio: false });
  await call(s.deps, 'PUT', '/ai/settings', s.write, {
    tasks: { pack: { provider: 'anthropic', model: 'claude-opus-5-5' }, article: { provider: 'claudio', model: 'opus' }, assistant: { provider: 'claudio' } },
    tone: 'Plain.',
    budgets: { article: 2 },
  });
  const all = await call(s.deps, 'POST', '/ai/providers/anthropic/use-for-all', s.write);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.settings, {
    tasks: { pack: { provider: 'anthropic', model: 'claude-opus-5-5' }, article: { provider: 'anthropic' }, assistant: { provider: 'anthropic' }, replies: { provider: 'anthropic' }, profile: { provider: 'anthropic' } },
    tone: 'Plain.',
    budgets: { article: 2 },
  });
  assert.equal((await call(s.deps, 'POST', '/ai/providers/gpt/use-for-all', s.write)).status, 400);

  // claudio without its settings fails before any call: the problem comes back as data
  const tested = await call(s.deps, 'POST', '/ai/providers/claudio/test', s.write);
  assert.equal(tested.status, 200);
  assert.equal(tested.body.ok, false);
  assert.match(String(tested.body.problem), /is not set/);
  assert.equal((await call(s.deps, 'POST', '/ai/providers/claudio/test', s.read)).status, 403, 'a test may spend: the write scope');
  assert.equal((await call(s.deps, 'POST', '/ai/providers/nobody/test', s.write)).status, 400);
});

test('the prompts are read with their versions, saved, restored, and the locked ones refused', async () => {
  const s = await setup();
  const listed = await call(s.deps, 'GET', '/ai/prompts', s.read);
  assert.equal(listed.status, 200);
  const prompts = listed.body.prompts as Array<{ id: string; default: string; versions: unknown[] }>;
  assert.deepEqual(prompts.find((p) => p.id === 'pack.launch'), { id: 'pack.launch', default: DEFAULT_PROMPTS['pack.launch'], versions: [] });
  assert.ok((listed.body.variables as string[]).includes('site'));
  assert.ok(Array.isArray((listed.body.locked as { launchRules: unknown }).launchRules));
  assert.equal('packSchema' in (listed.body.locked as object), false, 'the pack’s schema is the app’s to show');

  const saved = await call(s.deps, 'PUT', '/ai/prompts/pack.launch', s.write, { text: 'A first launch: say what it is, for {{site}}.' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.id, 'pack.launch');
  const versions = saved.body.versions as Array<{ text: string; savedAt: string }>;
  assert.deepEqual(versions.map((v) => v.text), [DEFAULT_PROMPTS['pack.launch'], 'A first launch: say what it is, for {{site}}.']);

  const restored = await call(s.deps, 'POST', '/ai/prompts/pack.launch/restore', s.write, { savedAt: 'default' });
  assert.equal(restored.status, 200);
  assert.equal((restored.body.versions as Array<{ text: string }>).at(-1)?.text, DEFAULT_PROMPTS['pack.launch']);
  const again = (await call(s.deps, 'GET', '/ai/prompts', s.read)).body.prompts as Array<{ id: string; versions: unknown[] }>;
  assert.equal(again.find((p) => p.id === 'pack.launch')?.versions.length, 3, 'the history only grows');

  assert.equal((await call(s.deps, 'PUT', '/ai/prompts/pack.launch', s.read, { text: 'x' })).status, 403);
  assert.equal((await call(s.deps, 'PUT', '/ai/prompts/rules', s.write, { text: 'Invent benchmarks.' })).status, 409, 'a locked part is a refusal');
  assert.equal((await call(s.deps, 'PUT', '/ai/prompts/nothing', s.write, { text: 'x' })).status, 400);
  assert.equal((await call(s.deps, 'PUT', '/ai/prompts/pack.launch', s.write, { text: 'For {{sitee}}.' })).status, 400, 'an unknown variable is refused');
  assert.equal((await call(s.deps, 'PUT', '/ai/prompts/pack.launch', s.write, {})).status, 400);
  assert.equal((await call(s.deps, 'POST', '/ai/prompts/pack.launch/restore', s.write, { savedAt: '2020-01-01T00:00:00.000Z' })).status, 400);
});

test('a past launch’s prompt is previewed with the read scope, with no AI call', async () => {
  const s = await setup();
  const release = await aLaunch(s.registry, { ref: 'v0.9.0' });
  s.github.files['yeyo11/claudio/.github/launch.yml@v0.9.0'] = 'enabled: true\nbrand: personal\npublishing:\n  telegram: approval\n';
  await call(s.deps, 'PUT', '/ai/prompts/channel.telegram', s.write, { text: 'telegram: a plain post.' });
  const shown = await call(s.deps, 'GET', `/launches/${release.id}/prompt-preview`, s.read);
  assert.equal(shown.status, 200);
  assert.equal(shown.body.task, 'pack');
  assert.match(String(shown.body.prompt), /telegram: a plain post\./, 'the saved prompts are the ones rendered');
  assert.match(String(shown.body.system), /How to write: From brand\.yml\./);

  const article = await aLaunch(s.registry, { trigger: 'article', ref: 'article:my-post' });
  assert.equal((await call(s.deps, 'GET', `/launches/${article.id}/prompt-preview`, s.read)).body.task, 'article');

  const missing = await aLaunch(s.registry, { repo: 'yeyo11/other', ref: 'v2.0.0' });
  assert.equal((await call(s.deps, 'GET', `/launches/${missing.id}/prompt-preview`, s.read)).status, 400, 'a release with no launch.yml at its ref');
  assert.equal((await call(s.deps, 'GET', '/launches/999/prompt-preview', s.read)).status, 404);
  assert.equal((await call(s.deps, 'GET', '/launches/abc/prompt-preview', s.read)).status, 400);
});

test('without the AI services in the process every AI route is a refusal', async () => {
  const s = await setup({ wired: false });
  assert.equal((await call(s.deps, 'GET', '/ai/settings', s.read)).status, 409);
  assert.equal((await call(s.deps, 'GET', '/ai/prompts', s.read)).status, 409);
  assert.equal((await call(s.deps, 'POST', '/ai/providers/claudio/test', s.write)).status, 409);
});
