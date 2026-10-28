import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Brand, LaunchConfig } from '@shipcast/schema';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { generateArticlePack, generatePack, LOCKED_ARTICLE_RULES, LOCKED_LAUNCH_RULES, SdkProvider, type AiSetup, type AiTask, type Launch } from '../src/index.ts';

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const config = LaunchConfig.parse({ enabled: true, brand: 'personal' });
type GenerateResult = Extract<Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>, { content: unknown }>;
const at = '2026-10-25T00:00:00.000Z';
const launch: Launch = { id: 1, repo: 'yeyo11/claudio', ref: 'v0.9.0', trigger: 'release', kind: 'launch', brand: 'personal', status: 'detected', detail: null, createdAt: at, updatedAt: at };

const version = { title: 'claudio', description: 'Claude Code as a service.', markdown: 'Body.' };
const pack = {
  schemaVersion: 1,
  kind: 'launch',
  project: { name: 'claudio', repo: 'https://github.com/yeyo11/claudio', version: 'v0.9.0' },
  analysis: { summary: 's', implemented: ['REST API'], planned: [], documentedOnly: [], limitations: [] },
  article: { en: { slug: 'claudio', ...version }, es: { slug: 'claudio-como-servicio', ...version } },
  devto: { tags: ['claude'] },
  bluesky: { lang: 'en', text: 'claudio https://josegarrido.dev/en/claudio/?ref=bluesky' },
  mastodon: { lang: 'en', text: 'claudio #claude https://josegarrido.dev/en/claudio/?ref=mastodon' },
  githubDiscussions: { title: 'claudio 0.9', body: 'What shipped. https://josegarrido.dev/en/claudio/?ref=github' },
  instagram: { caption: 'claudio. Link in bio. #claude', summary: 'Claude Code as a service.', slides: [{ title: 'Chats', text: 'From anywhere.' }, { title: 'Agents', text: 'In parallel.' }] },
};

function answer(text: string): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
    warnings: [],
  };
}

function mockProvider(model: MockLanguageModelV4, chosen: Array<string | undefined> = []): SdkProvider {
  return new SdkProvider({
    id: 'test',
    model: (id) => {
      chosen.push(id);
      return model;
    },
  });
}

test('a pack generated through the AI SDK is schema-bound, carries the locked rules and is checked like any other', async () => {
  const model = new MockLanguageModelV4({ doGenerate: answer(JSON.stringify(pack)) });
  const chosen: Array<string | undefined> = [];
  const dir = await mkdtemp(join(tmpdir(), 'shipcast-ai-'));
  const result = await generatePack({ ai: mockProvider(model, chosen), model: 'claude-opus-5-5', launch, config, brand, checkout: { hostPath: dir, providerPath: '/workspace/x' } });
  assert.equal(result.ok, true);
  assert.deepEqual(chosen, ['claude-opus-5-5'], 'the model the settings chose is the one called');

  const call = model.doGenerateCalls[0]!;
  assert.equal(call.responseFormat?.type, 'json');
  assert.equal((call.responseFormat?.type === 'json' ? (call.responseFormat.schema as { type?: string }) : undefined)?.type, 'object', "the pack's JSON Schema is the contract");
  const system = call.prompt.find((m) => m.role === 'system');
  for (const rule of LOCKED_LAUNCH_RULES) assert.ok(system?.role === 'system' && system.content.includes(rule));
  assert.deepEqual(
    (call.tools ?? []).map((t) => t.name).sort(),
    ['git', 'list_files', 'read_files', 'repo_overview', 'search'],
    'with a checkout on this machine, the model gets read-only tools over it',
  );
});

test('an AI SDK answer that is not a valid pack is refused, never trusted', async () => {
  const model = new MockLanguageModelV4({ doGenerate: answer(JSON.stringify({ ...pack, bluesky: { lang: 'en', text: 'x'.repeat(400) } })) });
  const result = await generatePack({ ai: mockProvider(model), launch, config, brand, checkout: { hostPath: '', providerPath: '' } });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.startsWith('bluesky.text:')));
  assert.equal(model.doGenerateCalls[0]!.tools, undefined, 'no checkout, no tools');
});

test('each task runs with the provider, model and prompts its settings choose', async () => {
  const asked: AiTask[] = [];
  const model = new MockLanguageModelV4({ doGenerate: answer(JSON.stringify({ ...pack, article: { en: { slug: 'notes', ...version }, es: { slug: 'notas', ...version } } })) });
  const chosen: Array<string | undefined> = [];
  const setup = async (task: AiTask): Promise<AiSetup> => {
    asked.push(task);
    return { provider: mockProvider(model, chosen), model: 'local-model', prompts: { article: 'Translate it into {{otherLanguages}}, plainly.' }, tone: 'Short sentences.' };
  };
  const fallback = new SdkProvider({ id: 'test', model: () => assert.fail('the fallback provider is not used when settings exist') });
  const result = await generateArticlePack(
    { title: 'Notes', markdown: 'Some notes.', lang: 'en', channels: ['bluesky'] },
    brand,
    { ai: fallback, aiSetup: setup, launchesRepo: 'yeyo11/launches' },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(asked, ['article']);
  assert.deepEqual(chosen, ['local-model']);
  const call = model.doGenerateCalls[0]!;
  const system = call.prompt.find((m) => m.role === 'system');
  assert.ok(system?.role === 'system' && system.content.includes('How to write: Short sentences.'), 'the tone override replaces brand.yml’s');
  for (const rule of LOCKED_ARTICLE_RULES) assert.ok(system?.role === 'system' && system.content.includes(rule));
  assert.match(JSON.stringify(call.prompt), /Translate it into Spanish, plainly\./);
});

test('streamText yields the model’s text as it comes', async () => {
  const model = new MockLanguageModelV4({
    doStream: {
      stream: convertArrayToReadableStream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Hello, ' },
        { type: 'text-delta', id: 't', delta: 'world' },
        { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: answer('').usage },
      ]),
    },
  });
  let text = '';
  for await (const chunk of mockProvider(model).streamText({ prompt: 'Say hello' })) text += chunk;
  assert.equal(text, 'Hello, world');
});

test('a stream that fails is an error, not an empty answer', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => {
      throw new Error('404 route not found');
    },
  });
  const read = async () => {
    for await (const _ of mockProvider(model).streamText({ prompt: 'Say hello' })) void _;
  };
  await assert.rejects(read(), /404 route not found/);
});
