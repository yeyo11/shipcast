import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLS } from '@shipcast/mcp';
import { ROUTES } from '../src/server/api.ts';

/*
 * The MCP server keeps up with the REST API: every operation of /api/v1 is called by some MCP tool
 * (its `operations`), or is left out on purpose with the reason. ROUTES holds every route whether its
 * flag is on or off, so a route behind a flag gets its tool too; the API refuses it while the flag is
 * off. The rule and why: docs/decisions/mcp-parity.md; how to add a tool: docs/mcp.md
 */

/** Operations a model is not offered on purpose, each with the reason */
const EXCLUDED: Readonly<Record<string, string>> = {};

const routes = new Map(ROUTES.map((route) => [route.operationId, route]));

/** Each operation and the tools that call it */
const callers = new Map<string, string[]>();
for (const tool of TOOLS) for (const operation of tool.operations) callers.set(operation, [...(callers.get(operation) ?? []), tool.name]);

const list = (lines: string[]) => lines.map((line) => `  - ${line}`).join('\n');

test('every API operation has an MCP tool, or a written reason it has none', () => {
  const missing = ROUTES.filter((r) => !callers.has(r.operationId) && !(r.operationId in EXCLUDED));
  if (missing.length === 0) return;
  assert.fail(
    `These /api/v1 operations have no MCP tool:\n${list(missing.map((r) => `${r.operationId} (${r.method} ${r.path})`))}\n` +
      'Give each one a tool in packages/mcp/src/tools/<area>.ts that declares it in `operations: [\'<operationId>\']` (with its test in packages/mcp/test/tools-<area>.test.ts), ' +
      'or, when a model must not or cannot use it, an entry in EXCLUDED in apps/web/test/mcp-parity.test.ts with the reason.',
  );
});

test('every operation a tool declares is one the API serves', () => {
  const unknown = TOOLS.flatMap((tool) => tool.operations.filter((operation) => !routes.has(operation)).map((operation) => `${tool.name}: ${operation}`));
  assert.deepEqual(unknown, [], `These tools declare operations /api/v1 does not have (operationIds are in apps/web/src/server/api.ts):\n${list(unknown)}`);
});

test('EXCLUDED names only API operations that have no tool, each with its reason', () => {
  const problems = Object.entries(EXCLUDED).flatMap(([operation, reason]) => [
    ...(reason.trim().length > 0 ? [] : [`EXCLUDED ${operation} needs its reason`]),
    ...(routes.has(operation) ? [] : [`EXCLUDED names ${operation}, which /api/v1 does not have: remove it`]),
    ...(callers.has(operation) ? [`EXCLUDED names ${operation}, which ${callers.get(operation)!.join(', ')} already calls: remove it from EXCLUDED`] : []),
  ]);
  assert.deepEqual(problems, [], `\n${list(problems)}`);
});

test('a read-only tool calls only GET operations', () => {
  const writes = TOOLS.filter((tool) => tool.hints.readOnlyHint).flatMap((tool) =>
    tool.operations.filter((operation) => routes.has(operation) && routes.get(operation)!.method !== 'GET').map((operation) => `${tool.name}: ${operation} (${routes.get(operation)!.method})`),
  );
  assert.deepEqual(writes, [], `These read-only tools call operations that write; drop readOnlyHint (use another of HINTS):\n${list(writes)}`);
});
