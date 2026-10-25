import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { checkStdioOptions, createApiClient, createMcpHttpHandler, createShipcastServer, McpSetupError } from '../src/index.ts';
import { fakeApi, serveFake, TOKEN } from './fake-api.ts';

const BASE = 'https://shipcast.example';

const text = (result: CallToolResult | { content?: unknown }) => {
  const first = (result.content as Array<{ type: string; text?: string }> | undefined)?.[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
};

async function connected() {
  const fake = fakeApi();
  const api = createApiClient({ baseUrl: BASE, token: TOKEN, fetch: async (url, init) => fake.handle(new Request(url, init)) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createShipcastServer(api).connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, fake };
}

test('a client lists the tools with their annotations, and calls them', async () => {
  const { client, fake } = await connected();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 11);
    const del = tools.find((t) => t.name === 'delete_post');
    assert.equal(del?.annotations?.destructiveHint, true);
    assert.equal(del?.annotations?.readOnlyHint, false);
    assert.deepEqual(Object.keys((del?.inputSchema as { properties: object }).properties).sort(), ['confirm', 'post_id']);
    assert.equal(tools.find((t) => t.name === 'list_launches')?.annotations?.readOnlyHint, true);

    const listed = (await client.callTool({ name: 'list_launches', arguments: { limit: 1 } })) as CallToolResult;
    assert.notEqual(listed.isError, true);
    assert.equal(JSON.parse(text(listed)).launches[0].repo, 'yeyo11/claudio');

    const refused = (await client.callTool({ name: 'delete_post', arguments: { post_id: 12 } })) as CallToolResult;
    assert.equal(refused.isError, true);
    assert.match(text(refused), /confirm: true/);

    const missing = (await client.callTool({ name: 'get_launch', arguments: { launch_id: 99 } })) as CallToolResult;
    assert.equal(missing.isError, true);
    assert.match(text(missing), /404 not_found/);
    assert.deepEqual(fake.calls, ['GET /launches?limit=1', 'GET /launches/99']);
  } finally {
    await client.close();
  }
});

test('the resources and prompts', async () => {
  const { client } = await connected();
  try {
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === 'shipcast://launches'));
    assert.ok(resources.some((r) => r.uri === 'shipcast://launches/3'), 'the template lists the latest launches');
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.equal(resourceTemplates[0]?.uriTemplate, 'shipcast://launches/{id}');
    const one = await client.readResource({ uri: 'shipcast://launches/3' });
    assert.equal(JSON.parse((one.contents[0] as { text: string }).text).drafts.count, 2);

    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ['announce_release', 'launch_checklist']);
    const checklist = await client.getPrompt({ name: 'launch_checklist', arguments: { repo: 'yeyo11/claudio', ref: 'v1.0.0' } });
    assert.match(JSON.stringify(checklist.messages), /launch_repo with repo \\"yeyo11\/claudio\\" and ref \\"v1.0.0\\"/);
    const announce = await client.getPrompt({ name: 'announce_release', arguments: { repo: 'yeyo11/claudio', lang: 'es' } });
    assert.match(JSON.stringify(announce.messages), /in Spanish.*write_article/);
  } finally {
    await client.close();
  }
});

test('over Streamable HTTP: the token is checked first, then every tool runs under it', async () => {
  const fake = fakeApi();
  const handler = createMcpHttpHandler({
    origin: BASE,
    // As the app does it: a token the API does not know is refused before MCP starts
    authenticate: async (request) => {
      const answer = await fake.handle(new Request(`${BASE}/api/v1/capabilities`, { headers: { authorization: request.headers.get('authorization') ?? '' } }));
      return answer.ok ? undefined : answer;
    },
    api: (request) => createApiClient({ baseUrl: BASE, headers: { authorization: request.headers.get('authorization') ?? '' }, fetch: async (url, init) => fake.handle(new Request(url, init)) }),
  });
  const fetchVia = (token: string) => async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    request.headers.set('authorization', `Bearer ${token}`);
    return handler(request);
  };

  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { fetch: fetchVia(TOKEN) }));
  try {
    const result = (await client.callTool({ name: 'approve_drafts', arguments: { launch_id: 3 } })) as CallToolResult;
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /"job": "j2"/);
    assert.ok(fake.calls.includes('POST /launches/3/approve'));
  } finally {
    await client.close();
  }

  const refused = await handler(new Request(`${BASE}/mcp`, { method: 'POST', headers: { authorization: 'Bearer shipcast_1_wrong', 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(refused.status, 401);
  const foreign = await handler(new Request(`${BASE}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', authorization: `Bearer ${TOKEN}` }, body: '{}' }));
  assert.equal(foreign.status, 403);
});

test('stdio options: the URL and a token-shaped token are required, and named in the error', () => {
  assert.throws(() => checkStdioOptions({ url: undefined, token: TOKEN }), (e: unknown) => e instanceof McpSetupError && /SHIPCAST_API_URL/.test(e.message));
  assert.throws(() => checkStdioOptions({ url: 'shipcast.example', token: TOKEN }), /http\(s\):\/\/host/);
  assert.throws(() => checkStdioOptions({ url: BASE, token: undefined }), /SHIPCAST_API_TOKEN.*token create/);
  assert.throws(() => checkStdioOptions({ url: BASE, token: 'ghp_x' }), /does not look like a Shipcast token/);
  assert.deepEqual(checkStdioOptions({ url: `${BASE}/`, token: ` ${TOKEN} ` }), { url: BASE, token: TOKEN });
});

test('end to end: `shipcast mcp` over stdio against a fake API on a socket', async () => {
  const fake = fakeApi();
  const { url, server } = await serveFake(fake);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../../../apps/cli/src/main.ts'), 'mcp'],
    env: { PATH: process.env.PATH ?? '', SHIPCAST_API_URL: url, SHIPCAST_API_TOKEN: TOKEN },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const result = (await client.callTool({ name: 'launch_repo', arguments: { repo: 'yeyo11/claudio' } })) as CallToolResult;
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /"job": "j1"/);
    const refused = (await client.callTool({ name: 'launch_repo', arguments: { repo: 'yeyo11/old' } })) as CallToolResult;
    assert.equal(refused.isError, true);
    assert.match(text(refused), /launched already/);
    assert.deepEqual(fake.calls, ['POST /launches {"repo":"yeyo11/claudio","direct":false}', 'POST /launches {"repo":"yeyo11/old","direct":false}']);
  } finally {
    await client.close();
    server.close();
  }
});
