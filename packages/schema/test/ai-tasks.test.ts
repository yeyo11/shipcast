import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_TASK_DEFINITIONS, AI_TASKS } from '../src/index.ts';

test('every AI task runs with one of the AI settings’ tasks, under today’s ceilings', () => {
  const tasks = Object.values(AI_TASK_DEFINITIONS);
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  for (const t of tasks) {
    assert.ok((AI_TASKS as readonly string[]).includes(t.settingsTask), t.id);
    assert.ok(t.limits.maxSteps >= 1 && t.limits.maxOutputTokens > 0 && t.limits.timeoutMs > 0, t.id);
    if (t.limits.maxTurns !== undefined) assert.equal(t.limits.maxSteps, t.limits.maxTurns, `${t.id}: a turn of the old agent is a step of the runner`);
  }
  assert.equal(AI_TASK_DEFINITIONS.assistantCheck.limits.maxTurns, 30);
  assert.equal(AI_TASK_DEFINITIONS.replies.limits.maxTurns, 20);
  assert.equal(AI_TASK_DEFINITIONS.profile.limits.maxTurns, 5);
  assert.equal(AI_TASK_DEFINITIONS.pack.needsRepo, 'always');
  assert.equal(AI_TASK_DEFINITIONS.assistant.output, undefined, 'the assistant streams text');
});

test('each structured task’s JSON Schema is an object schema the model can be given', () => {
  for (const t of Object.values(AI_TASK_DEFINITIONS)) {
    if (!t.output) continue;
    const schema = t.output.jsonSchema();
    assert.equal(schema.type, 'object', t.id);
    assert.match(t.output.name, /^[a-z_]+$/);
  }
});
