import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { TOOLS } from '../src/tools.ts';
import { findModelContext, mountWebMcp, WEBMCP_HEADER, type ModelContextLike, type WebMcpTool } from '../src/webmcp.ts';
import { fakeApi, TOKEN } from './fake-api.ts';

/** A registry shaped like the proposal's: registerTool with an AbortSignal that unregisters */
function fakeRegistry() {
  const tools = new Map<string, WebMcpTool>();
  const registry: ModelContextLike = {
    async registerTool(tool, options) {
      if (tools.has(tool.name)) throw new Error(`${tool.name} is registered already`);
      tools.set(tool.name, tool);
      options?.signal?.addEventListener('abort', () => tools.delete(tool.name));
    },
  };
  return { registry, tools };
}

test('nothing is mounted while the setting is off, or without a registry', () => {
  const { registry, tools } = fakeRegistry();
  assert.equal(mountWebMcp({ enabled: false, modelContext: registry }), undefined);
  assert.equal(tools.size, 0);
  assert.equal(mountWebMcp({ enabled: true }), undefined, 'Node has no document.modelContext');
});

test('the same tools register, with JSON Schemas and WebMCP hints, and go away on unmount', async () => {
  const { registry, tools } = fakeRegistry();
  const mount = mountWebMcp({ enabled: true, modelContext: registry });
  assert.ok(mount);
  assert.deepEqual(mount.tools, TOOLS.map((t) => t.name));
  assert.deepEqual([...tools.keys()], TOOLS.map((t) => t.name));
  const del = tools.get('delete_post');
  assert.equal(del?.annotations?.consequentialHint, true);
  assert.equal(del?.annotations?.readOnlyHint, false);
  assert.deepEqual((del?.inputSchema as { required: string[] }).required, ['post_id']);
  assert.equal(tools.get('get_launch')?.annotations?.readOnlyHint, true);
  mount.unmount();
  assert.equal(tools.size, 0);
});

test('a tool calls the same-origin API with the session and the WebMCP header, never a token', async () => {
  const fake = fakeApi();
  const seen: Request[] = [];
  const { registry, tools } = fakeRegistry();
  mountWebMcp({
    enabled: true,
    modelContext: registry,
    baseUrl: 'https://shipcast.example',
    // The fake API wants a token; the browser has the cookie instead, so this stands in for the app's session check
    fetch: async (url, init) => {
      const request = new Request(url, init);
      seen.push(request);
      const asApp = new Request(request, { headers: { ...Object.fromEntries(request.headers), authorization: `Bearer ${TOKEN}` } });
      return fake.handle(asApp);
    },
  });
  const launched = await tools.get('launch_repo')?.execute({ repo: 'yeyo11/claudio' });
  assert.equal((launched as { job: string }).job, 'j1');
  assert.equal(seen[0]?.headers.get(WEBMCP_HEADER), '1');
  assert.equal(seen[0]?.headers.get('authorization'), null);
  assert.equal(seen[0]?.credentials, 'same-origin');

  const refused = await tools.get('delete_post')?.execute({ post_id: 12 });
  assert.match((refused as { error: string }).error, /confirm: true/);
  const invalid = await tools.get('get_launch')?.execute({ launch_id: 'three' });
  assert.match((invalid as { error: string }).error, /Invalid arguments for get_launch/);
  assert.equal(seen.length, 1, 'refusals never reach the API');
});

test('the registry is found on document (the proposal) or navigator (early previews), and a preview handle unregisters', () => {
  const { registry } = fakeRegistry();
  assert.equal(findModelContext({ document: { modelContext: registry } }), registry);
  assert.equal(findModelContext({ navigator: { modelContext: registry } }), registry);
  assert.equal(findModelContext({ document: {}, navigator: { modelContext: {} } }), undefined);

  const live = new Set<string>();
  const preview: ModelContextLike = {
    registerTool(tool) {
      live.add(tool.name);
      return { unregister: () => live.delete(tool.name) };
    },
  };
  const mount = mountWebMcp({ enabled: true, modelContext: preview });
  assert.equal(live.size, TOOLS.length);
  mount?.unmount();
  assert.equal(live.size, 0);
});

test('the WebMCP module and what it imports use no Node APIs', () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/from '([^']+)'/g)) {
      assert.ok(!spec!.startsWith('node:'), `${file} imports ${spec}`);
      assert.ok(!spec!.startsWith('@modelcontextprotocol/'), `${file} imports the Node SDK (${spec})`);
      if (spec!.startsWith('.')) visit(resolve(dirname(file), spec!));
    }
    assert.ok(!/\bprocess\.|\bBuffer\b/.test(source), `${file} uses process or Buffer`);
  };
  visit(resolve(import.meta.dirname, '../src/webmcp.ts'));
  assert.ok(seen.size >= 4, 'it follows webmcp.ts into the client, tools and errors');
});
