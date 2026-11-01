import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INSTRUCTIONS, TOOL_GUIDES, toolByName, TOOLS } from '../src/index.ts';

/*
 * What every tool, of every area, must hold. Each area's own behaviour is in test/tools-<area>.test.ts.
 * That a read-only tool calls only GET operations, and that every API operation has a tool, is checked
 * by the app's parity test (apps/web/test/mcp-parity.test.ts), which knows the API's routes.
 */

test('every tool has a name of its own', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(
    names.filter((name, i) => names.indexOf(name) !== i),
    [],
    'two tools share a name',
  );
  for (const tool of TOOLS) assert.equal(toolByName(tool.name), tool);
});

test('every tool has a description a model can use, and hints that agree', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.title.length > 0, `${tool.name} has a title`);
    assert.ok(tool.description.length > 60, `${tool.name} has a description a model can use`);
    assert.ok(!(tool.hints.readOnlyHint && tool.hints.destructiveHint), `${tool.name} is not both read-only and destructive`);
  }
});

test('every tool names the API operations it calls', () => {
  for (const tool of TOOLS) {
    assert.ok(tool.operations.length > 0, `${tool.name} declares at least one operation`);
    for (const operation of tool.operations) assert.match(operation, /^[a-z][A-Za-z]+$/, `${tool.name}: ${operation} is an operationId`);
  }
});

test('the server\'s instructions are the intro and every area\'s guide', () => {
  assert.match(INSTRUCTIONS, /^Shipcast launches GitHub projects/);
  assert.ok(TOOL_GUIDES.length > 0);
  for (const guide of TOOL_GUIDES) assert.ok(INSTRUCTIONS.includes(guide), guide);
});
