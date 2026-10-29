import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savePrompt, writeAiSettings } from '@shipcast/engine';
import { fakeClaudio, fakeJson, memoryRegistry } from '@shipcast/engine/testing';
import { AiError, Brand } from '@shipcast/schema';
import { accountSecretKey, aiProviderCheck, aiRunnerFor, aiRunSetup, aiSetup, AiNotConnected, Flags, buildConnector, MemoryStore, NETWORKS, type AiDeps } from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });

async function deps(): Promise<AiDeps> {
  return { env: {}, registry: await memoryRegistry(), secrets: new MemoryStore(), claudio: () => ({ url: 'http://claudio:8798', token: 't' }), brand: async () => brand };
}

test('each task gets the provider, model, prompts and tone its settings choose', async () => {
  const d = await deps();
  const account = await d.registry.accounts.addAccount({ network: 'anthropic', brand: 'personal', label: 'Anthropic API', settings: {} });
  await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ apiKey: 'sk-ant-test' }), 'Anthropic API');
  await writeAiSettings(d.registry, { tasks: { pack: { provider: 'claudio' }, article: { provider: 'anthropic', model: 'claude-opus-5-5' }, assistant: { provider: 'claudio' } }, tone: 'Plain.' });
  await savePrompt(d.registry, 'channel.devto', 'devto: tags only.');

  const setup = aiSetup(d);
  const pack = await setup('pack');
  assert.equal(pack.provider.id, 'claudio');
  assert.equal(pack.model, undefined);
  const article = await setup('article');
  assert.equal(article.provider.id, 'anthropic');
  assert.equal(article.model, 'claude-opus-5-5');
  assert.equal(article.tone, 'Plain.');
  assert.deepEqual(article.prompts, { 'channel.devto': 'devto: tags only.' });
});

test('a provider chosen without a connected account fails the task with what to do', async () => {
  const d = await deps();
  await writeAiSettings(d.registry, { tasks: { pack: { provider: 'openaiCompatible' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' } } });
  await assert.rejects(aiSetup(d)('pack'), (e) => e instanceof AiNotConnected && /Channels page/.test(e.message));
  assert.equal((await aiSetup(d)('article')).provider.id, 'claudio');
});

test('the AI providers are networks of the catalog, their keys checked before they are kept', async () => {
  for (const id of ['anthropic', 'openaiCompatible']) assert.ok(NETWORKS.find((n) => n.id === id)?.ai);
  const calls: string[] = [];
  const http = (async (url: string | URL, init?: RequestInit) => {
    calls.push(`${String(url)} ${JSON.stringify(init?.headers ?? {})}`);
    return new Response(JSON.stringify({ data: [] }), { status: String(url).includes('bad') ? 401 : 200 });
  }) as typeof fetch;
  const anthropic = await buildConnector('anthropic', { settings: {}, secrets: { apiKey: 'sk-ant-1' } }, brand, http).check();
  assert.deepEqual(anthropic, { ok: true, account: 'Anthropic API' });
  assert.match(calls[0]!, /api\.anthropic\.com\/v1\/models.*"x-api-key":"sk-ant-1"/);
  const local = await buildConnector('openaiCompatible', { settings: { baseUrl: 'http://localhost:11434/v1/', model: 'qwen3' }, secrets: { apiKey: '' } }, brand, http).check();
  assert.deepEqual(local, { ok: true, account: 'qwen3 on localhost:11434' });
  assert.equal(calls[1], 'http://localhost:11434/v1/models {}', 'no key, no authorization header');
  const bad = await buildConnector('openaiCompatible', { settings: { baseUrl: 'http://bad.example/v1', model: 'm' }, secrets: {} }, brand, http).check();
  assert.equal(bad.ok, false);
});

test('the AI task runner reads the same settings and keychain as the old providers', async () => {
  const d = await deps();
  const account = await d.registry.accounts.addAccount({ network: 'anthropic', brand: 'personal', label: 'Anthropic API', settings: {} });
  await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ apiKey: 'sk-ant-test' }), 'Anthropic API');
  await writeAiSettings(d.registry, { tasks: { pack: { provider: 'claudio' }, article: { provider: 'anthropic', model: 'claude-opus-5-5' }, assistant: { provider: 'openaiCompatible' } } });

  const setup = aiRunSetup(d);
  const pack = await setup('pack');
  assert.equal(pack.provider.id, 'claudio');
  assert.deepEqual(pack.settings, { url: 'http://claudio:8798', token: 't' }, 'claudio’s settings are still its URL and token');
  const article = await setup('article');
  assert.equal(article.provider.id, 'anthropic');
  assert.equal(article.model, 'claude-opus-5-5');
  assert.equal(article.settings.apiKey, 'sk-ant-test');
  await assert.rejects(setup('assistant'), (e) => e instanceof AiError && e.code === 'ai_not_connected' && /Channels page/.test(e.message));
  assert.ok(aiRunnerFor({ ...d, archives: { tarballUrl: async () => 'https://codeload.github.com/o/r/tar.gz/v1' } }));
});

test('the runner’s setup carries the spend limits the owner set in the AI settings, and none until then', async () => {
  const d = await deps();
  const setup = aiRunSetup(d);
  assert.equal((await setup('pack')).budgets, undefined);
  await writeAiSettings(d.registry, { tasks: { pack: { provider: 'claudio' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' } }, budgets: { pack: 6, 'assistant-check': 1.5 } });
  assert.deepEqual((await setup('assistant')).budgets, { pack: 6, 'assistant-check': 1.5 });
});

test('the ai-runner flag is off unless it is set', () => {
  assert.equal(Flags.fromEnv({}).on('ai-runner'), false);
  assert.equal(Flags.fromEnv({ SHIPCAST_FLAGS: 'ai-runner' }).on('ai-runner'), true);
});

test('ai-runner: testing a provider asks Claudio’s readiness, and says when Claude is not signed in', async () => {
  const claudio = await fakeClaudio({ ready: (_, res) => fakeJson(res, 503, { ready: false, reason: 'signed-out' }) });
  try {
    const d = { ...(await deps()), claudio: () => ({ url: claudio.url, token: 't' }) };
    const runner = aiRunnerFor({ ...d, archives: { tarballUrl: async () => assert.fail('no archive') } });
    const checked = await aiProviderCheck(runner, 'claudio', d);
    assert.equal(checked.ok, false);
    assert.match(checked.ok ? '' : checked.problem, /is not signed in to Claude: sign in on Claudio/);
    assert.deepEqual(claudio.seen.map((s) => `${s.method} ${s.path}`), ['GET /api/ready'], 'no model call to say it');
  } finally {
    await claudio.close();
  }
  const ready = await fakeClaudio();
  try {
    const d = { ...(await deps()), claudio: () => ({ url: ready.url, token: 't' }) };
    assert.equal((await aiProviderCheck(aiRunnerFor({ ...d, archives: { tarballUrl: async () => '' } }), 'claudio', d)).ok, true);
  } finally {
    await ready.close();
  }
});

test('ai-runner: a provider without a readiness is tested with one cheap call, its failure in AiError’s words', async () => {
  const d = await deps();
  const missing = await aiProviderCheck(aiRunnerFor({ ...d, archives: { tarballUrl: async () => '' } }), 'anthropic', d);
  assert.deepEqual(missing.ok ? undefined : missing.code, 'ai_not_connected');
  assert.match(missing.ok ? '' : missing.problem, /no account is connected: connect one on the Channels page/);

  const account = await d.registry.accounts.addAccount({ network: 'anthropic', brand: 'personal', label: 'Anthropic API', settings: {} });
  await d.secrets.set(accountSecretKey(account.id), JSON.stringify({ apiKey: 'sk-ant-revoked' }), 'Anthropic API');
  const asked: string[] = [];
  const refusing = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, { status: 401 });
  }) as typeof fetch;
  const withFetch = { ...d, fetch: refusing };
  const refused = await aiProviderCheck(aiRunnerFor({ ...withFetch, archives: { tarballUrl: async () => '' } }), 'anthropic', withFetch);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok ? '' : refused.code, 'ai_not_connected');
  assert.match(refused.ok ? '' : refused.problem, /refused its credentials \(401\): reconnect the AI provider/);
  assert.doesNotMatch(refused.ok ? '' : refused.problem, /sk-ant-revoked/);
  assert.match(asked[0] ?? '', /api\.anthropic\.com\/v1\/messages/);
});
