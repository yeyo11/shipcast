import assert from 'node:assert/strict';
import { test } from 'node:test';
import { savePrompt, writeAiSettings } from '@shipcast/engine';
import { memoryRegistry } from '@shipcast/engine/testing';
import { Brand } from '@shipcast/schema';
import { accountSecretKey, aiSetup, AiNotConnected, buildConnector, MemoryStore, NETWORKS, type AiDeps } from '../src/index.ts';

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
