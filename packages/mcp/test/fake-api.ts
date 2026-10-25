import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A stand-in for the app's /api/v1, shaped like docs/api.md: the routes the tools call, a token with
 * scopes, the error body, and a log of what was asked. In-process only; nothing here reaches the app.
 */

export const TOKEN = 'shipcast_7_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
export const READ_ONLY = 'shipcast_8_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

export interface FakeApi {
  handle(request: Request): Promise<Response>;
  /** `METHOD /path?query body` of every authorised call */
  calls: string[];
}

const error = (status: number, code: string, message: string, headers: Record<string, string> = {}) => Response.json({ error: { code, message } }, { status, headers });

const launch = { id: 3, repo: 'yeyo11/claudio', ref: 'v1.0.0', kind: 'major', status: 'drafted', createdAt: '2026-10-25T10:00:00.000Z', posts: [{ id: 12, channel: 'mastodon', kind: 'post', url: 'https://mastodon.example/12' }] };

export function fakeApi(): FakeApi {
  const calls: string[] = [];
  return {
    calls,
    async handle(request) {
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const auth = request.headers.get('authorization');
      const scopes = auth === `Bearer ${TOKEN}` ? ['read', 'write'] : auth === `Bearer ${READ_ONLY}` ? ['read'] : undefined;
      if (!scopes) return error(401, 'unauthorized', 'this token is not valid');
      const write = request.method !== 'GET';
      if (!scopes.includes(write ? 'write' : 'read')) return error(403, 'insufficient_scope', `this token lacks the ${write ? 'write' : 'read'} scope`);
      const text = await request.text();
      calls.push(`${request.method} ${path}${url.search}${text ? ` ${text}` : ''}`);
      const route = `${request.method} ${path}`;
      if (route === 'GET /launches') return Response.json({ launches: [launch], next: null });
      if (route === 'GET /launches/3') return Response.json({ ...launch, metrics: [], index: [], drafts: { pullRequest: { number: 9, url: 'https://github.com/yeyo11/launches/pull/9', state: 'open', branch: 'launch/x' }, count: 2, files: [] } });
      if (/^GET \/launches\/\d+$/.test(route)) return error(404, 'not_found', 'no such launch');
      if (route === 'GET /accounts') return Response.json({ accounts: [{ id: 1, network: 'mastodon', label: 'me' }] });
      if (route === 'GET /jobs') return Response.json({ jobs: [] });
      if (route === 'GET /capabilities') return Response.json({ capabilities: { mastodon: { edit: 'yes', delete: 'yes', note: '', fields: ['text'] } } });
      if (route === 'POST /launches') return JSON.parse(text).repo === 'yeyo11/old' ? error(409, 'refused', 'launched already') : Response.json({ job: 'j1' }, { status: 202 });
      if (route === 'POST /launches/3/approve') return Response.json({ job: 'j2' }, { status: 202 });
      if (route === 'POST /launches/3/retry/devto') return Response.json({ job: 'j3' }, { status: 202 });
      if (route === 'POST /articles') return Response.json({ job: 'j4' }, { status: 202 });
      if (route === 'PATCH /posts/12') return Response.json({ post: { id: 12, status: 'edited' } });
      if (route === 'PATCH /posts/13') return error(502, 'upstream', 'edit: 422 Text is too long');
      if (route === 'DELETE /posts/12') return Response.json({ post: { id: 12, status: 'deleted' } });
      if (route === 'GET /echo-token') return error(500, 'internal', `the header was ${auth}`);
      if (route === 'GET /slow') return error(429, 'rate_limited', 'too many wrong tokens; wait and try again', { 'retry-after': '120' });
      return error(404, 'not_found', `no route ${path}`);
    },
  };
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
