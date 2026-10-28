import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAiProvider } from '../src/index.ts';
import { mockAiProvider, mockRunner, scriptedModel, textParts } from '../src/testing/index.ts';

/* Testing a provider on the runner: one cheap call with the provider being tested, never the settings' choice */

test('a provider without a readiness answers one word through the runner, on its own setup', async () => {
  const tested = scriptedModel(textParts('O', 'K'));
  const settingsChoice = scriptedModel(textParts('never'));
  const checked = await checkAiProvider(mockRunner(settingsChoice), { provider: mockAiProvider(tested), settings: { apiKey: 'k' } });
  assert.deepEqual(checked, { ok: true, detail: 'it answered “OK”' });
  assert.equal(settingsChoice.doStreamCalls.length, 0);
  assert.equal(tested.doStreamCalls[0]!.maxOutputTokens, 16, 'spends next to nothing');
});

test('a readiness of its own is asked instead of a model', async () => {
  const model = scriptedModel(textParts('never'));
  const provider = { ...mockAiProvider(model), ready: async () => ({ ready: false as const, reason: 'signed-out', message: 'the mock provider is not signed in' }) };
  assert.deepEqual(await checkAiProvider(mockRunner(model), { provider, settings: {} }), { ok: false, code: 'signed-out', problem: 'the mock provider is not signed in' });
  assert.equal(model.doStreamCalls.length, 0);
});
