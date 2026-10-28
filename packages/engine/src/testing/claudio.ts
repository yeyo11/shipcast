import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { claudioAiProvider } from '../ai/providers/claudio/index.ts';
import type { AiTaskRunner } from '../ai/runner.ts';
import { GitHubRest } from '../github.ts';
import { runnerOn } from './ai-runner.ts';

/*
 * A fake Claudio and a fake GitHub, served in-process on 127.0.0.1, for the tasks that run on
 * Claudio's remote workspaces: the workspace made from the repo's codeload URL, the chat completion
 * with Claudio's headers and its chat id, the workspace released. Nothing reaches a real Claudio, AI
 * or GitHub: the fetch these runners use fails a test that leaves 127.0.0.1.
 */

export interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type FakeHandler = (request: SeenRequest, response: ServerResponse) => void;

export interface FakeServer {
  url: string;
  /** Every request, in order */
  seen: SeenRequest[];
  close(): Promise<void>;
}

export async function serveFake(handler: FakeHandler): Promise<FakeServer> {
  const seen: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(request);
      handler(request, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const fakeJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export const FAKE_CLAUDIO_TOKEN = 'claudio-token-1a2b';
export const FAKE_GITHUB_TOKEN = 'ghs_installation-secret-9z8y';
export const FAKE_WORKSPACE = { id: 'ws-1', bytes: 2048, files: 3, expiresAt: '2026-10-28T12:00:00Z' };

/** Claudio's streamed chat completion: the answer as text, then the usage with its cost, in the chat named by its header */
export function claudioAnswer(res: ServerResponse, content: string, chatId = 'chat-7'): void {
  const chunk = (value: Record<string, unknown>) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'default', ...value })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', ...(chatId && { 'x-claudio-chat-id': chatId }) });
  res.end(
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) +
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, total_cost_usd: 0.12 } }) +
      'data: [DONE]\n\n',
  );
}

/** Claudio's refusal of a chat completion, OpenAI-shaped, as its /v1 sends it */
export function claudioRefusal(res: ServerResponse, status: number, code: string, message: string, chatId?: string): void {
  fakeJson(res, status, { error: { message, type: 'invalid_request_error', code } }, chatId ? { 'x-claudio-chat-id': chatId } : {});
}

export interface FakeClaudioOptions {
  /** The chat completion's answer; one JSON answer `{}` when not given */
  chat?: FakeHandler;
  /** `/api/ready`: 200 when not given */
  ready?: FakeHandler;
}

/** A fake Claudio: workspaces, readiness and the chat completion */
export function fakeClaudio(options: FakeClaudioOptions = {}): Promise<FakeServer> {
  return serveFake((req, res) => {
    if (req.method === 'POST' && req.path === '/api/workspaces') return fakeJson(res, 201, FAKE_WORKSPACE);
    if (req.method === 'DELETE' && req.path.startsWith('/api/workspaces/')) return void res.writeHead(204).end();
    if (req.method === 'GET' && req.path === '/api/ready') return options.ready ? options.ready(req, res) : fakeJson(res, 200, { ready: true });
    if (req.method === 'POST' && req.path === '/api/v1/chat/completions') return options.chat ? options.chat(req, res) : claudioAnswer(res, '{}');
    fakeJson(res, 404, { error: { message: 'no route', code: 'not-found' } });
  });
}

/** What codeload serves a repo's tarball at, as GitHub's API redirects to it */
export const codeloadUrl = (repo: string, ref: string): string => `https://codeload.github.com/${repo}/legacy.tar.gz/refs/tags/${ref}`;

/** A fake GitHub whose tarball answer is codeload's redirect, for any repo and ref */
export function fakeGitHubArchives(): Promise<FakeServer> {
  return serveFake((req, res) => {
    const match = /^\/repos\/([^/]+\/[^/]+)\/tarball(?:\/(.+))?$/.exec(req.path);
    if (match) return void res.writeHead(302, { location: codeloadUrl(match[1]!, match[2] ?? 'HEAD') }).end();
    fakeJson(res, 404, { message: 'Not Found' });
  });
}

/** fetch for 127.0.0.1 only: any other host (a redirect followed to codeload included) fails the call and is listed in `outside` */
export function localOnlyFetch(outside: string[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== '127.0.0.1') {
      outside.push(url.href);
      throw new Error(`a test reached ${url.href}`);
    }
    return fetch(input, init);
  }) as typeof fetch;
}

/** The runner on Claudio at the fake's address, its workspaces' archives from the fake GitHub */
export function fakeClaudioRunner(claudio: Pick<FakeServer, 'url'>, github: Pick<FakeServer, 'url'>, outside: string[] = []): AiTaskRunner {
  const fetchImpl = localOnlyFetch(outside);
  return runnerOn(
    { provider: claudioAiProvider, settings: { url: claudio.url, token: FAKE_CLAUDIO_TOKEN } },
    { archives: new GitHubRest({ token: FAKE_GITHUB_TOKEN, baseUrl: github.url, fetch: fetchImpl }), fetch: fetchImpl },
  );
}

/** The chat completions Claudio was asked for */
export const claudioChats = (fake: Pick<FakeServer, 'seen'>): SeenRequest[] => fake.seen.filter((s) => s.path === '/api/v1/chat/completions');
