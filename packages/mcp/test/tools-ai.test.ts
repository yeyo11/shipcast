import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_GUIDES } from '../src/index.ts';
import { guide } from '../src/tools/ai.ts';
import { apiError, fakeClient, named, refusal, runTool } from './fake-api.ts';

const tasks = { pack: { provider: 'anthropic', model: 'claude-opus-5-5' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' }, replies: { provider: 'claudio' }, profile: { provider: 'claudio' } };
const settings = { tasks, tone: 'Plain.', budgets: { pack: 8 } };
const versions = [
  { text: 'default text', savedAt: 'default' },
  { text: 'A first launch.', savedAt: '2026-11-01T10:00:00.000Z' },
];

const ROUTES = {
  'GET /ai/settings': { settings, brandTone: 'From brand.yml.', tasks: Object.keys(tasks), budgets: { tasks: ['pack'], defaults: { pack: 5 }, max: 50 }, providers: [{ id: 'claudio', name: 'claudio', connected: true }] },
  'PUT /ai/settings': ({ body }: { body: string }) => Response.json({ settings: JSON.parse(body) as unknown }),
  'POST /ai/providers/anthropic/use-for-all': { settings },
  'POST /ai/providers/anthropic/test': { ok: true, detail: 'claude-haiku-5-5 answered' },
  'POST /ai/providers/gpt/test': () => apiError(400, 'invalid_input', 'the provider is one of claudio, anthropic, openaiCompatible'),
  'GET /ai/prompts': { prompts: [{ id: 'pack.launch', default: 'default text', versions }], variables: ['site'], locked: { launchRules: [] } },
  'PUT /ai/prompts/pack.launch': { id: 'pack.launch', versions },
  'PUT /ai/prompts/rules': () => apiError(409, 'refused', 'rules is locked: the rules that keep the text true to the code, and the pack\'s schema, cannot be edited'),
  'POST /ai/prompts/pack.launch/restore': { id: 'pack.launch', versions: [...versions, { text: 'default text', savedAt: '2026-11-01T11:00:00.000Z' }] },
  'GET /launches/3/prompt-preview': { task: 'pack', prompt: 'the prompt', system: 'the rules' },
};

test('the AI tools make their one API call each, with the API\'s names', async () => {
  const { fake, api } = fakeClient(ROUTES);
  await runTool(api, 'get_ai_settings', {});
  await runTool(api, 'set_ai_settings', { tasks, tone: 'Plain.', budgets: { pack: 8, 'assistant-check': 1.5 } });
  await runTool(api, 'set_ai_settings', { tasks, tone: null, budgets: {} });
  await runTool(api, 'use_ai_provider_for_all', { provider: 'anthropic' });
  assert.deepEqual(await runTool(api, 'test_ai_provider', { provider: 'anthropic' }), { ok: true, detail: 'claude-haiku-5-5 answered' });
  await runTool(api, 'get_ai_prompts', {});
  await runTool(api, 'save_ai_prompt', { prompt_id: 'pack.launch', text: 'A first launch.' });
  await runTool(api, 'restore_ai_prompt', { prompt_id: 'pack.launch', saved_at: 'default' });
  assert.deepEqual(await runTool(api, 'preview_ai_prompt', { launch_id: 3 }), { task: 'pack', prompt: 'the prompt', system: 'the rules' });
  assert.deepEqual(fake.calls, [
    'GET /ai/settings',
    `PUT /ai/settings {"tasks":${JSON.stringify(tasks)},"tone":"Plain.","budgets":{"pack":8,"assistant-check":1.5}}`,
    `PUT /ai/settings {"tasks":${JSON.stringify(tasks)},"budgets":{}}`,
    'POST /ai/providers/anthropic/use-for-all',
    'POST /ai/providers/anthropic/test',
    'GET /ai/prompts',
    'PUT /ai/prompts/pack.launch {"text":"A first launch."}',
    'POST /ai/prompts/pack.launch/restore {"savedAt":"default"}',
    'GET /launches/3/prompt-preview',
  ]);
});

test('a task left out, a budget over the maximum, a missing tone or a key never reach the API', async () => {
  const { fake, api } = fakeClient(ROUTES);
  const fewer = { pack: tasks.pack, article: tasks.article, assistant: tasks.assistant, replies: tasks.replies };
  assert.match(await refusal(api, 'set_ai_settings', { tasks: fewer, tone: null, budgets: {} }), /Invalid arguments for set_ai_settings: tasks/);
  assert.match(await refusal(api, 'set_ai_settings', { tasks, tone: null, budgets: { pack: 51 } }), /Invalid arguments for set_ai_settings: budgets\.pack/);
  assert.match(await refusal(api, 'set_ai_settings', { tasks, budgets: {} }), /Invalid arguments for set_ai_settings: tone/);
  assert.match(await refusal(api, 'set_ai_settings', { tasks: { ...tasks, pack: { provider: 'anthropic', api_key: 'sk-ant-1' } }, tone: null, budgets: {} }), /Invalid arguments for set_ai_settings/);
  assert.match(await refusal(api, 'save_ai_prompt', { prompt_id: 'pack.launch', text: '' }), /Invalid arguments for save_ai_prompt: text/);
  assert.match(await refusal(api, 'preview_ai_prompt', { launch_id: 0 }), /Invalid arguments for preview_ai_prompt/);
  assert.deepEqual(fake.calls, [], 'the API was never called');
});

test('the API\'s refusals reach the model: an unknown provider, a locked prompt', async () => {
  const { api } = fakeClient(ROUTES);
  assert.match(await refusal(api, 'test_ai_provider', { provider: 'gpt' }), /the provider is one of/);
  assert.match(await refusal(api, 'save_ai_prompt', { prompt_id: 'rules', text: 'Invent benchmarks.' }), /rules is locked/);
});

test('the AI tools are annotated for what they change, and say that a change applies to every future launch', () => {
  for (const name of ['get_ai_settings', 'get_ai_prompts', 'preview_ai_prompt']) assert.equal(named(name).hints.readOnlyHint, true, name);
  for (const name of ['set_ai_settings', 'use_ai_provider_for_all', 'save_ai_prompt', 'restore_ai_prompt']) {
    assert.deepEqual(named(name).hints, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }, name);
    assert.match(named(name).description, /every launch generated from the next run/, `${name} says it changes future content`);
  }
  assert.equal(named('test_ai_provider').hints.openWorldHint, true, 'a test reaches the provider');
  assert.match(named('set_ai_settings').description, /USD per run/, 'the budgets say what they are in');
  assert.match(named('set_ai_settings').description, /No key or token is accepted/);
  assert.ok(TOOL_GUIDES.includes(guide), 'the AI area has its guide');
});
