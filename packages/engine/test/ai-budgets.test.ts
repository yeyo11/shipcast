import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_BUDGET_TASKS, AI_TASK_DEFINITIONS, DEFAULT_AI_BUDGETS_USD, MAX_AI_BUDGET_USD } from '@shipcast/schema';
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test';
import { aiBudgetUsd, AiTaskRunner, claudioAiProvider, InvalidAiSettings, readAiSettings, writeAiSettings, type AiRunSetup } from '../src/index.ts';
import { memoryRegistry, mockAiProvider } from '../src/testing/index.ts';

/*
 * Each AI task's spend ceiling: a default next to the task's definition, an override in the AI
 * settings, and the effective one passed to a provider that takes a ceiling (Claudio's
 * maxBudgetUsd, as a header); a provider that takes none is sent nothing.
 */

const tasks = { pack: { provider: 'claudio' }, article: { provider: 'claudio' }, assistant: { provider: 'claudio' } } as const;

test('budgets: every task definition but the provider check runs with its default, the one the settings fall back on', async () => {
  assert.deepEqual(DEFAULT_AI_BUDGETS_USD, { pack: 5, article: 3, 'assistant-check': 2, assistant: 1, replies: 1, profile: 0.5 });
  for (const definition of Object.values(AI_TASK_DEFINITIONS)) {
    if (definition.id === 'provider-check') continue;
    assert.ok((AI_BUDGET_TASKS as readonly string[]).includes(definition.id), definition.id);
    assert.equal(definition.limits.maxBudgetUsd, DEFAULT_AI_BUDGETS_USD[definition.id as keyof typeof DEFAULT_AI_BUDGETS_USD], definition.id);
  }
  const settings = await readAiSettings(await memoryRegistry());
  assert.equal(settings.budgets, undefined, 'nothing overridden until the owner sets a limit');
  for (const task of AI_BUDGET_TASKS) assert.equal(aiBudgetUsd(settings, task), DEFAULT_AI_BUDGETS_USD[task]);
});

test('budgets: an override is stored and read back; an empty set restores the defaults; a client without budgets keeps them', async () => {
  const registry = await memoryRegistry();
  const saved = await writeAiSettings(registry, { tasks, budgets: { pack: 8, 'assistant-check': 0.75 } });
  assert.deepEqual(saved.budgets, { pack: 8, 'assistant-check': 0.75 });
  const read = await readAiSettings(registry);
  assert.deepEqual(read.budgets, { pack: 8, 'assistant-check': 0.75 });
  assert.equal(aiBudgetUsd(read, 'pack'), 8);
  assert.equal(aiBudgetUsd(read, 'assistant'), DEFAULT_AI_BUDGETS_USD.assistant, 'the check’s limit is not the suggestions’');

  const kept = await writeAiSettings(registry, { tasks, tone: 'Plain.' });
  assert.deepEqual(kept.budgets, { pack: 8, 'assistant-check': 0.75 }, 'a save that does not send the limits leaves them');
  const cleared = await writeAiSettings(registry, { tasks, budgets: {} });
  assert.equal(cleared.budgets, undefined);
  assert.equal(aiBudgetUsd(await readAiSettings(registry), 'pack'), DEFAULT_AI_BUDGETS_USD.pack);
});

test('budgets: an invalid override is refused, and nothing is saved', async () => {
  const registry = await memoryRegistry();
  await writeAiSettings(registry, { tasks, budgets: { pack: 4 } });
  for (const budgets of [{ pack: 0 }, { pack: -1 }, { pack: MAX_AI_BUDGET_USD + 1 }, { pack: '4' }, { pack: Number.NaN }, { 'provider-check': 1 }, { launch: 1 }]) {
    await assert.rejects(writeAiSettings(registry, { tasks, budgets }), InvalidAiSettings, JSON.stringify(budgets));
  }
  assert.ok((await writeAiSettings(registry, { tasks, budgets: { pack: MAX_AI_BUDGET_USD } })).budgets?.pack === MAX_AI_BUDGET_USD, 'the maximum itself is allowed');
});

test('budgets: a stored override that no longer parses falls back on the default, alone', async () => {
  const registry = await memoryRegistry();
  await registry.settings.setSetting('ai', { tasks, budgets: { pack: 500, article: 2, replies: 'lots' } });
  const read = await readAiSettings(registry);
  assert.deepEqual(read.budgets, { article: 2 });
  assert.equal(aiBudgetUsd(read, 'pack'), DEFAULT_AI_BUDGETS_USD.pack);
});

/** Claudio at a fake address, answering every chat with `content`; the requests' headers are kept */
function claudioSetup(content: string, budgets?: AiRunSetup['budgets']): { setup: AiRunSetup; headers: Headers[]; fetch: typeof fetch } {
  const headers: Headers[] = [];
  const fake: typeof globalThis.fetch = async (_input, init) => {
    headers.push(new Headers(init?.headers));
    const chunk = (delta: Record<string, unknown>, finish: string | null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    return new Response(`${chunk({ role: 'assistant', content }, 'stop')}data: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { setup: { provider: claudioAiProvider, settings: { url: 'http://claudio:8798', token: 't' }, ...(budgets && { budgets }) }, headers, fetch: fake };
}

const review = JSON.stringify({ summary: 'Thin', proposals: [{ field: 'bio', current: 'x', proposed: 'Construyo Shipcast', why: 'Says what you build' }] });
const budgetHeader = (headers: Headers[]) => headers[0]?.get('x-claudio-max-budget-usd');

test('budgets: Claudio receives the task’s default, or the owner’s override, as its maxBudgetUsd', async () => {
  const plain = claudioSetup(review);
  await new AiTaskRunner({ resolve: async () => plain.setup, fetch: plain.fetch }).run(AI_TASK_DEFINITIONS.profile, { prompt: 'Review.' });
  assert.equal(budgetHeader(plain.headers), '0.5', 'the default');

  const overridden = claudioSetup(review, { profile: 2.5, pack: 9 });
  await new AiTaskRunner({ resolve: async () => overridden.setup, fetch: overridden.fetch }).run(AI_TASK_DEFINITIONS.profile, { prompt: 'Review.' });
  assert.equal(budgetHeader(overridden.headers), '2.5', 'the owner’s limit for this task, not another’s');
});

test('budgets: the owner’s limit for a task wins over the runtime settings’ single budget, which still applies without one', async () => {
  const global = claudioSetup(review);
  await new AiTaskRunner({ resolve: async () => global.setup, fetch: global.fetch }).run(AI_TASK_DEFINITIONS.profile, { prompt: 'Review.', limits: { maxBudgetUsd: 7 } });
  assert.equal(budgetHeader(global.headers), '7');

  const own = claudioSetup(review, { profile: 1.5 });
  await new AiTaskRunner({ resolve: async () => own.setup, fetch: own.fetch }).run(AI_TASK_DEFINITIONS.profile, { prompt: 'Review.', limits: { maxBudgetUsd: 7 } });
  assert.equal(budgetHeader(own.headers), '1.5');
});

test('budgets: the writing assistant and its check share a settings task but not a limit', async () => {
  const { setup, headers, fetch } = claudioSetup('A suggestion.', { 'assistant-check': 4 });
  const stream = new AiTaskRunner({ resolve: async () => setup, fetch }).stream(AI_TASK_DEFINITIONS.assistant, { prompt: 'Suggest.' });
  for await (const _ of stream.textStream) void _;
  assert.equal(budgetHeader(headers), String(DEFAULT_AI_BUDGETS_USD.assistant));
});

test('budgets: a provider with no spend ceiling of its own is sent none', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: 'text-start' as const, id: 't' },
        { type: 'text-delta' as const, id: 't', delta: review },
        { type: 'text-end' as const, id: 't' },
        { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
      ]),
    }),
  });
  const runner = new AiTaskRunner({ resolve: async () => ({ provider: mockAiProvider(model), settings: { apiKey: 'k' }, budgets: { profile: 3 } }) });
  await runner.run(AI_TASK_DEFINITIONS.profile, { prompt: 'Review.' });
  assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]!.providerOptions ?? {}), /maxBudgetUsd|budget/i);
});
