import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApiClient, invoke, toolByName, type ShipcastApi, type ShipcastTool } from '../src/index.ts';

/*
 * A stand-in for the app's /api/v1, shaped like docs/api.md: the routes the tools call, a token with
 * scopes, the error body, and a log of what was asked. In-process only; nothing here reaches the app.
 *
 * Each area's test file brings the routes its tools call (`fakeClient({ 'GET /stats/overview': ... })`)
 * on top of BASE_ROUTES, so no area edits a table shared with the others.
 */

export const TOKEN = 'shipcast_7_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
export const READ_ONLY = 'shipcast_8_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

export const BASE = 'https://shipcast.example';

export interface FakeApi {
  handle(request: Request): Promise<Response>;
  /** `METHOD /path?query body` of every authorised call */
  calls: string[];
}

export interface FakeCall {
  request: Request;
  url: URL;
  /** The request's body as sent, '' without one */
  body: string;
}

/**
 * A route's answer: a JSON value, answered with 200 (a fresh copy every time), or a handler for any
 * other status or for an answer that depends on the request. Keyed by `METHOD /path` without the
 * query, which `calls` records instead.
 */
export type FakeRoutes = Record<string, object | ((call: FakeCall) => Response | Promise<Response>)>;

/** The API's error body, as a handler answers it */
export const apiError = (status: number, code: string, message: string, headers: Record<string, string> = {}) => Response.json({ error: { code, message } }, { status, headers });

/** A write that started a job, as the API answers it */
export const acceptedJob = (job: string) => () => Response.json({ job }, { status: 202 });

const launch = { id: 3, repo: 'yeyo11/claudio', ref: 'v1.0.0', kind: 'major', status: 'drafted', createdAt: '2026-10-25T10:00:00.000Z', posts: [{ id: 12, channel: 'mastodon', kind: 'post', url: 'https://mastodon.example/12' }] };

/** The routes of the first tools (launches, posts, accounts, jobs) and of the client's own tests */
export const BASE_ROUTES: FakeRoutes = {
  'GET /launches': { launches: [launch], next: null },
  'GET /launches/3': { ...launch, metrics: [], index: [], drafts: { pullRequest: { number: 9, url: 'https://github.com/yeyo11/launches/pull/9', state: 'open', branch: 'launch/x' }, count: 2, files: [] } },
  'GET /accounts': { accounts: [{ id: 1, network: 'mastodon', label: 'me' }] },
  'GET /jobs': { jobs: [], next: null },
  'GET /capabilities': { capabilities: { mastodon: { edit: 'yes', delete: 'yes', note: '', fields: ['text'] } } },
  'POST /launches': ({ body }) => ((JSON.parse(body) as { repo?: string }).repo === 'yeyo11/old' ? apiError(409, 'refused', 'launched already') : Response.json({ job: 'j1' }, { status: 202 })),
  'POST /launches/3/approve': acceptedJob('j2'),
  'POST /launches/3/retry/devto': acceptedJob('j3'),
  'POST /articles': acceptedJob('j4'),
  'PATCH /posts/12': { post: { id: 12, status: 'edited' } },
  'PATCH /posts/13': () => apiError(502, 'upstream', 'edit: 422 Text is too long'),
  'DELETE /posts/12': { post: { id: 12, status: 'deleted' } },
  'GET /echo-token': ({ request }) => apiError(500, 'internal', `the header was ${request.headers.get('authorization')}`),
  'GET /slow': () => apiError(429, 'rate_limited', 'too many wrong tokens; wait and try again', { 'retry-after': '120' }),
};

/** The fake API over BASE_ROUTES and the routes given, which win over the base ones */
export function fakeApi(routes: FakeRoutes = {}): FakeApi {
  const table: FakeRoutes = { ...BASE_ROUTES, ...routes };
  const calls: string[] = [];
  return {
    calls,
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const auth = request.headers.get('authorization');
      const scopes = auth === `Bearer ${TOKEN}` ? ['read', 'write'] : auth === `Bearer ${READ_ONLY}` ? ['read'] : undefined;
      if (!scopes) return apiError(401, 'unauthorized', 'this token is not valid');
      const write = request.method !== 'GET';
      if (!scopes.includes(write ? 'write' : 'read')) return apiError(403, 'insufficient_scope', `this token lacks the ${write ? 'write' : 'read'} scope`);
      const body = await request.text();
      calls.push(`${request.method} ${path}${url.search}${body ? ` ${body}` : ''}`);
      const route = `${request.method} ${path}`;
      const answer = table[route];
      if (typeof answer === 'function') return answer({ request, url, body });
      if (answer !== undefined) return Response.json(answer);
      if (/^GET \/launches\/\d+$/.test(route)) return apiError(404, 'not_found', 'no such launch');
      return apiError(404, 'not_found', `no route ${path}`);
    },
  };
}

/** The fake API and a client of it, as the MCP server and WebMCP get one */
export function fakeClient(routes: FakeRoutes = {}, token = TOKEN): { fake: FakeApi; api: ShipcastApi } {
  const fake = fakeApi(routes);
  const api = createApiClient({ baseUrl: BASE, token, fetch: async (url, init) => fake.handle(new Request(url, init)) });
  return { fake, api };
}

export function named(name: string): ShipcastTool {
  const tool = toolByName(name);
  assert.ok(tool, `there is a tool named ${name}`);
  return tool;
}

/** Runs a tool that must succeed, and answers what it returned */
export async function runTool(api: ShipcastApi, name: string, args: unknown): Promise<unknown> {
  const outcome = await invoke(named(name), api, args);
  assert.ok(outcome.ok, `${name}: ${outcome.ok ? '' : outcome.message}`);
  return outcome.value;
}

/** Runs a tool that must fail, and answers the message the model reads */
export async function refusal(api: ShipcastApi, name: string, args: unknown): Promise<string> {
  const outcome = await invoke(named(name), api, args);
  assert.equal(outcome.ok, false, `${name} ${JSON.stringify(args)} should fail`);
  return outcome.ok ? '' : outcome.message;
}

/** The same fake on a real socket, for the end-to-end tests that go through fetch and a child process */
export async function serveFake(api: FakeApi): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1${req.url}`, {
      method: req.method ?? 'GET',
      headers: Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as [string, string]] : [])),
      ...(body.length > 0 && { body }),
    });
    const response = await api.handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
