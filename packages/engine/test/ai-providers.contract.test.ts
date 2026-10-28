import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiError } from '@shipcast/schema';
import { streamText } from 'ai';
import { AI_PROVIDER_DEFINITIONS, AI_PROVIDERS, aiProviderTables, fakeAiProvider, taskChoiceFor, type AiProviderDefinition, type AiProviderSettings } from '../src/index.ts';

/** Every provider module the contract runs over: the registry's, and the fake a test adds */
const ALL: readonly AiProviderDefinition[] = [...AI_PROVIDER_DEFINITIONS, fakeAiProvider];

/** Settings with a value in every field: a URL where one is asked, a recognisable secret in each secret */
function settingsOf(definition: AiProviderDefinition): Record<string, string> {
  return Object.fromEntries(
    definition.settings.map((f) => [f.key, f.secret ? `SECRET-${definition.id}-${f.key}-7f3a` : /url/i.test(f.key) ? 'https://ai.example:8443' : 'some-model']),
  );
}

const secretsOf = (definition: AiProviderDefinition, settings: AiProviderSettings): string[] =>
  definition.settings.filter((f) => f.secret).map((f) => settings[f.key] ?? '').filter(Boolean);

interface Seen {
  url: string;
  headers: Headers;
  body: string;
}

/** A fetch that records each request and refuses it the way a provider refuses a key, echoing it back */
function refusingFetch(seen: Seen[], status = 401, echo = ''): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' });
    return new Response(JSON.stringify({ error: { message: `invalid credentials ${echo}`, type: 'authentication_error' } }), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

for (const definition of ALL) {
  test(`${definition.id}: its capabilities hold together`, () => {
    const { capabilities } = definition;
    if (capabilities.repoAccess === 'remote-workspace') assert.ok(definition.requestHeaders, 'a remote agent is told where to work by its headers');
    if (capabilities.repoAccess === 'local-tools') assert.equal(capabilities.tools, true, 'local repo tools need a provider that takes tools');
    if (capabilities.structuredOutput === 'none') assert.equal(capabilities.tools, true, 'without a response format, the answer comes through the submit tool');
    assert.ok(definition.name.trim());
    assert.equal(new Set(definition.settings.map((f) => f.key)).size, definition.settings.length);
  });

  test(`${definition.id}: builds a model that calls through the fetch it is given, the secret only in a header`, async () => {
    const settings = settingsOf(definition);
    const seen: Seen[] = [];
    const model = definition.model(settings, undefined, { fetch: refusingFetch(seen) });
    assert.ok(typeof model === 'object' && model.modelId, 'a model, with the default model id when the settings name none');
    assert.equal(typeof model === 'object' && model.modelId, definition.defaultModel(settings));
    const result = streamText({ model, prompt: 'Say hello', maxRetries: 0 });
    let failure: unknown;
    for await (const part of result.fullStream) if (part.type === 'error') failure = part.error;
    assert.ok(failure, 'a refused key is an error, not an empty answer');
    assert.equal(seen.length, 1);
    const [call] = seen;
    for (const secret of secretsOf(definition, settings)) {
      assert.doesNotMatch(call!.url, new RegExp(secret), 'no secret in the URL, where logs and labels would see it');
      assert.ok([...call!.headers.values()].some((v) => v.includes(secret)), 'the key goes in a header');
    }
  });

  test(`${definition.id}: a missing required setting names the field, never another setting's value`, () => {
    const required = definition.settings.find((f) => f.secret && !f.optional) ?? definition.settings.find((f) => !f.optional);
    if (!required) return;
    const settings = { ...settingsOf(definition), [required.key]: '' };
    assert.throws(
      () => definition.model(settings, 'm'),
      (error: unknown) => {
        assert.ok(error instanceof AiError);
        assert.equal(error.code, 'ai_not_connected');
        assert.equal(error.retryable, false);
        for (const secret of secretsOf(definition, settings)) assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
  });
}

test('the AI settings offer the registry’s listed providers, in order', () => {
  assert.deepEqual([...AI_PROVIDERS], ['claudio', 'anthropic', 'openaiCompatible']);
  assert.ok(!(AI_PROVIDERS as readonly string[]).includes('openai'), 'the OpenAI API is only chosen by Action mode');
});

test('a new provider is its module and a registry line: it is then offered by the AI settings', () => {
  const tables = aiProviderTables([...AI_PROVIDER_DEFINITIONS, fakeAiProvider]);
  assert.deepEqual(tables.listed, ['claudio', 'anthropic', 'openaiCompatible', 'fake']);
  assert.equal(tables.names.fake, 'Fake provider');
  const choice = taskChoiceFor(tables.listed as [string, ...string[]]);
  assert.deepEqual(choice.parse({ provider: 'fake', model: 'fake-model' }), { provider: 'fake', model: 'fake-model' });
  assert.equal(taskChoiceFor(AI_PROVIDERS).safeParse({ provider: 'fake' }).success, false, 'not offered until its line is in the registry');
});
