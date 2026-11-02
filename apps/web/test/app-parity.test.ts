import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ROUTES } from '../src/server/api.ts';
import { SERVER_FUNCTIONS } from './app-parity.ts';

/*
 * The API keeps up with the pages: every server function of apps/web/src/server/*.functions.ts is
 * declared in app-parity.ts, with the /api/v1 routes that do the same (whose MCP tools
 * mcp-parity.test.ts requires) or the reason only the app does it. The server functions are read from
 * their source, since importing them pulls TanStack Start in. The rule: docs/decisions/mcp-parity.md
 */

const SRC = new URL('../src/', import.meta.url);
const SERVER = new URL('server/', SRC);
const FUNCTIONS_FILE = /^[^/]+[.]functions[.]tsx?$/;
/** The one shape a server function is written in, so a name is never missed */
const EXPORTED = /^export\s+const\s+(\w+)\s*=\s*createServerFn\s*\(/gm;
const CALLS = /\bcreateServerFn\s*\(/g;
const DEFINES = /\bcreateServerFn\s*\(/;

const files = readdirSync(SERVER).filter((name) => FUNCTIONS_FILE.test(name)).sort();
const read = (file: string) => readFileSync(new URL(file, SERVER), 'utf8');

/** Each server function and the files that export one by that name */
const found = new Map<string, string[]>();
for (const file of files) for (const [, name] of read(file).matchAll(EXPORTED)) found.set(name!, [...(found.get(name!) ?? []), file]);

const operations = new Set(ROUTES.map((route) => route.operationId));
const list = (lines: string[]) => lines.map((line) => `  - ${line}`).join('\n');

test('every server function is read: exported as `export const name = createServerFn(`, in src/server/*.functions.ts, under a name of its own', () => {
  assert.ok(found.size > 0, `no server function found in ${SERVER.pathname}`);
  const elsewhere = readdirSync(SRC, { recursive: true, encoding: 'utf8' }).filter(
    (path) => /[.]tsx?$/.test(path) && !(path.startsWith('server/') && FUNCTIONS_FILE.test(path.slice('server/'.length))) && DEFINES.test(readFileSync(new URL(path, SRC), 'utf8')),
  );
  const problems = [
    ...files.flatMap((file) => {
      const source = read(file);
      const unread = (source.match(CALLS)?.length ?? 0) - [...source.matchAll(EXPORTED)].length;
      return unread === 0 ? [] : [`${file}: ${unread} createServerFn call(s) not written as \`export const name = createServerFn(\`, the shape this test reads`];
    }),
    ...elsewhere.map((path) => `src/${path} defines a server function: move it to a src/server/*.functions.ts file`),
    ...[...found].filter(([, where]) => where.length > 1).map(([name, where]) => `${name} is exported by ${where.join(' and ')}: the map is keyed by name, rename one`),
  ];
  assert.deepEqual(problems, [], `\n${list(problems)}`);
});

test('every server function has the routes that do the same, or a written reason it has none', () => {
  const missing = [...found].filter(([name]) => !(name in SERVER_FUNCTIONS)).map(([name, where]) => `${name} (${where.join(', ')})`);
  if (missing.length === 0) return;
  assert.fail(
    `These server functions are not in apps/web/test/app-parity.ts:\n${list(missing)}\n` +
      'Give each one an entry in its area’s block of SERVER_FUNCTIONS: `{ api: [\'<operationId>\', ...] }`, the /api/v1 routes that do what it does ' +
      '(a new route goes in apps/web/src/server/<area>-api.ts with its MCP tool in packages/mcp/src/tools/<area>.ts, docs/mcp.md#parity-and-adding-a-tool), ' +
      'or `{ appOnly: \'<why only the signed-in owner may do it, in the app>\' }`.',
  );
});

test('the map names only server functions that exist, each with routes /api/v1 serves or a reason', () => {
  const problems = Object.entries(SERVER_FUNCTIONS).flatMap(([name, coverage]) => {
    if (!found.has(name)) return [`${name} is no server function of src/server/*.functions.ts any more: remove its entry`];
    if ('api' in coverage) {
      if (coverage.api.length === 0) return [`${name}: name the routes that do the same in \`api\`, or give \`appOnly\` its reason`];
      return coverage.api.filter((operation) => !operations.has(operation)).map((operation) => `${name}: ${operation} is no operationId of /api/v1 (they are in apps/web/src/server/api.ts and its *-api.ts modules)`);
    }
    return coverage.appOnly.trim().length > 0 ? [] : [`${name}: appOnly needs its reason`];
  });
  assert.deepEqual(problems, [], `\n${list(problems)}`);
});
