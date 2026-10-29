import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Brand, LaunchConfig } from '@shipcast/schema';
import type { MockLanguageModelV4 } from 'ai/test';
import { aiProvider, AiTaskRunner, generateArticlePack, generatePack, LOCKED_ARTICLE_RULES, LOCKED_LAUNCH_RULES, type AiProviderDefinition, type AiTask, type Launch } from '../src/index.ts';
import { jsonModel, mockRunner, scriptedModel, submitParts } from '../src/testing/index.ts';

/*
 * The AI tasks as the AI settings choose them, on the AI task runner: the task's provider and model,
 * the owner's prompts and tone, the locked rules after them, and an answer that is not this launch's
 * refused. The runner's own loop, validation and errors are in ai-runner.test.ts.
 */

const brand = Brand.parse({ id: 'personal', displayName: 'Me', site: 'https://josegarrido.dev', github: 'yeyo11' });
const config = LaunchConfig.parse({ enabled: true, brand: 'personal' });
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

/** A provider definition over a mock model that records the model id each call is built with */
function choosingProvider(model: MockLanguageModelV4, chosen: Array<string | undefined>): AiProviderDefinition {
  return aiProvider({
    id: 'mock',
    name: 'mock provider',
    listed: false,
    settings: [{ key: 'apiKey', label: 'API key', secret: true }],
    capabilities: { streaming: true, tools: true, structuredOutput: 'native', repoAccess: 'local-tools' },
    defaultModel: () => 'mock-default',
    model: (_settings, id) => {
      chosen.push(id);
      return model;
    },
  });
}

test('a pack is schema-bound, carries the locked rules, runs on the model the settings chose, and reads the clone with read-only tools', async () => {
  const model = scriptedModel(submitParts(pack));
  const chosen: Array<string | undefined> = [];
  const runner = new AiTaskRunner({ resolve: async () => ({ provider: choosingProvider(model, chosen), settings: { apiKey: 'k' }, model: 'claude-opus-5-5' }) });
  const dir = await mkdtemp(join(tmpdir(), 'shipcast-ai-'));
  const result = await generatePack({ runner, launch, config, brand, checkout: { hostPath: dir }, ref: 'v0.9.0' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(chosen.length > 0 && chosen.every((id) => id === 'claude-opus-5-5'), 'the model the settings chose is the one called');

  const call = model.doStreamCalls[0]!;
  const system = call.prompt.find((m) => m.role === 'system');
  for (const rule of LOCKED_LAUNCH_RULES) assert.ok(system?.role === 'system' && system.content.includes(rule));
  assert.deepEqual(
    (call.tools ?? []).map((t) => t.name).sort(),
    ['git', 'list_files', 'read_files', 'repo_overview', 'search', 'submit_answer'],
    'with a checkout on this machine, the model gets read-only tools over it and answers through the submit tool',
  );
});

test('a pack that is not valid even after its repair is refused, never trusted', async () => {
  const bad = { ...pack, bluesky: { lang: 'en', text: 'x'.repeat(400) } };
  const model = scriptedModel(submitParts(bad), submitParts(bad, 'call-2'));
  const dir = await mkdtemp(join(tmpdir(), 'shipcast-ai-'));
  const result = await generatePack({ runner: mockRunner(model), launch, config, brand, checkout: { hostPath: dir }, ref: 'v0.9.0' });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => /not valid, even after a repair: .*bluesky/.test(p)), JSON.stringify(result));
});

test('each task runs with the provider and model its settings choose, and the owner’s prompts and tone', async () => {
  const asked: AiTask[] = [];
  const model = jsonModel({ ...pack, article: { en: { slug: 'notes', ...version }, es: { slug: 'notas', ...version } } });
  const chosen: Array<string | undefined> = [];
  const runner = new AiTaskRunner({
    resolve: async (task) => {
      asked.push(task);
      return { provider: choosingProvider(model, chosen), settings: { apiKey: 'k' }, model: 'local-model' };
    },
  });
  const result = await generateArticlePack(
    { title: 'Notes', markdown: 'Some notes.', lang: 'en', channels: ['bluesky'] },
    brand,
    { aiRunner: runner, aiTexts: async () => ({ prompts: { article: 'Translate it into {{otherLanguages}}, plainly.' }, tone: 'Short sentences.' }), launchesRepo: 'yeyo11/launches' },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(asked, ['article']);
  assert.deepEqual([...new Set(chosen)], ['local-model']);
  const call = model.doStreamCalls[0]!;
  assert.equal(call.tools, undefined, 'an article reads no repo');
  const system = call.prompt.find((m) => m.role === 'system');
  assert.ok(system?.role === 'system' && system.content.includes('How to write: Short sentences.'), 'the tone override replaces brand.yml’s');
  for (const rule of LOCKED_ARTICLE_RULES) assert.ok(system?.role === 'system' && system.content.includes(rule));
  assert.match(JSON.stringify(call.prompt), /Translate it into Spanish, plainly\./);
});
