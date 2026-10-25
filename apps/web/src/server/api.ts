import { ConnectorError } from '@shipcast/connectors';
import {
  CAPABILITIES,
  deleteLaunchPosts,
  deletePost,
  editPost,
  editPosts,
  PostRefused,
  type ApiScope,
  type ArticleInput,
  type EditDeps,
  type Launch,
  type LaunchStatus,
  type Registry,
  type ReviewGitHub,
} from '@shipcast/engine';
import { WEBMCP_HEADER } from '@shipcast/mcp/webmcp';
import { hasScope, readWebMcp, verifyApiToken, type SecretStore } from '@shipcast/runtime';
import type { Channel } from '@shipcast/schema';
import { id, InvalidInput, object } from './input.ts';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server.ts';
import { launchDetail, launchView, publishAgain } from './launches.server.ts';
import { channelList, postChanges } from './post-changes.ts';
import { articleRequest, channelName, launchRequest } from './requests.ts';

/*
 * The REST API under /api/v1: stable routes for the MCP server and any other client, beside the
 * server functions the pages use, and thin over the same functions. A bearer token is the way in; a
 * session cookie is ignored here, so no page on another site can make a signed-in browser call it,
 * except on WebMCP's same-origin calls when the owner turned it on (webMcpSession below). See
 * docs/api.md, docs/decisions/api-tokens.md and docs/decisions/mcp.md
 */

export const API_PREFIX = '/api/v1';

/** What a write answers when it was accepted or refused; the same shape the work functions return */
export type WorkAnswer = { ok: true; job: string } | { ok: false; problem: string };

export interface JobView {
  id: string;
  title: string;
  state: string;
  log: string[];
  link: string | null;
  startedAt: string;
}

/** Everything the API touches, so the tests run it on a PGlite registry with the work faked */
export interface ApiDeps {
  registry: Registry;
  secrets: SecretStore;
  github: ReviewGitHub;
  launchesRepo: string;
  /** The public origin the OpenAPI document names as its server */
  publicUrl: string;
  limiter: FailureLimiter;
  jobs(): Promise<JobView[]>;
  startLaunch(repo: string, ref: string | undefined, direct: boolean): Promise<WorkAnswer>;
  approve(launchId: number): Promise<WorkAnswer>;
  startArticle(input: ArticleInput, direct: boolean): Promise<WorkAnswer>;
  startPublishing(launch: Launch, retryChannel?: Channel): Promise<string>;
  /** What editing and deleting published pieces needs: the connectors by account, and GitHub for the blog */
  editing(): Promise<EditDeps>;
}

/**
 * Failed sign-ins per client, in memory: ten wrong tokens in ten minutes and that client is refused
 * until the window ends, before its token is even checked. A restart forgets, which is fine for
 * slowing a guesser down; 32 random bytes are not guessed anyway, this keeps the log and the keychain
 * calls quiet.
 */
export class FailureLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #failures = new Map<string, { count: number; resetAt: number }>();

  constructor(max = 10, windowMs = 10 * 60_000) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** Seconds the client must wait, or undefined when it may try */
  blocked(client: string, now = Date.now()): number | undefined {
    const entry = this.#failures.get(client);
    if (!entry || entry.resetAt <= now) return undefined;
    return entry.count >= this.#max ? Math.ceil((entry.resetAt - now) / 1000) : undefined;
  }

  fail(client: string, now = Date.now()): void {
    // Stale entries go once the map grows, so a flood of addresses cannot grow it for ever
    if (this.#failures.size > 1000) for (const [key, e] of this.#failures) if (e.resetAt <= now) this.#failures.delete(key);
    const entry = this.#failures.get(client);
    if (!entry || entry.resetAt <= now) this.#failures.set(client, { count: 1, resetAt: now + this.#windowMs });
    else entry.count++;
  }
}

/** The header server.ts sets from the socket, replacing any a client sent; absent under Vite's dev server */
export const PEER_HEADER = 'x-shipcast-peer';

type ErrorCode = 'unauthorized' | 'insufficient_scope' | 'rate_limited' | 'not_found' | 'method_not_allowed' | 'invalid_input' | 'unsupported_media_type' | 'refused' | 'upstream' | 'internal';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly headers: Record<string, string>;

  constructor(status: number, code: ErrorCode, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const errorResponse = (error: ApiError) => json(error.status, { error: { code: error.code, message: error.message } }, error.headers);

const refused = (answer: WorkAnswer): Response => {
  if (answer.ok) return json(202, { job: answer.job });
  if (answer.problem === 'no such launch') throw new ApiError(404, 'not_found', answer.problem);
  throw new ApiError(409, 'refused', answer.problem);
};

/** A launch's posts, numbers, index status and drafts; the drafts' text stays in the pull request */
async function launchResource(deps: ApiDeps, launch: Launch) {
  const detail = await launchDetail(deps.registry, launch, { github: deps.github, launchesRepo: deps.launchesRepo });
  const review = detail.review;
  const drafts =
    review === null
      ? null
      : 'error' in review
        ? { error: review.error }
        : { pullRequest: review.pullRequest, count: review.drafts.length, files: review.drafts.map((d) => ({ path: d.path, label: d.label, kind: d.kind })) };
  return { ...detail.launch, detail: detail.detail, metrics: detail.metrics, index: detail.index, drafts };
}

const STATUSES: readonly LaunchStatus[] = ['detected', 'generating', 'drafted', 'published', 'skipped', 'failed'];

/** An opaque position in the launches' order: the last launch's creation time and id */
const encodeCursor = (at: { createdAt: string; id: number }) => Buffer.from(JSON.stringify([at.createdAt, at.id])).toString('base64url');

function decodeCursor(cursor: string): { createdAt: string; id: number } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(value) && typeof value[0] === 'string' && Number.isInteger(value[1])) return { createdAt: value[0], id: value[1] as number };
  } catch {
    // falls through to the error below
  }
  throw new InvalidInput('cursor is not one this API gave');
}

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'send JSON, with content-type: application/json');
  }
  const body = await request.text();
  if (body.length > 300_000) throw new InvalidInput('the body is too large');
  try {
    return body === '' ? {} : (JSON.parse(body) as unknown);
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
}

function launchId(value: string | undefined): number {
  return id(/^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN, 'the launch id');
}

async function existingLaunch(deps: ApiDeps, value: string | undefined): Promise<Launch> {
  const launch = await deps.registry.get(launchId(value));
  if (!launch) throw new ApiError(404, 'not_found', 'no such launch');
  return launch;
}

interface Call {
  request: Request;
  url: URL;
  params: Record<string, string>;
  /** What the caller may do: its token's scopes, or both for the owner's session through WebMCP */
  scopes: readonly ApiScope[];
}

type JsonSchema = Record<string, unknown>;

/** One route: how it is matched and served, and what the OpenAPI document says of it */
export interface ApiRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** OpenAPI's form, `/launches/{id}`, relative to /api/v1 */
  path: string;
  scope: ApiScope;
  operationId: string;
  summary: string;
  query?: Array<{ name: string; description: string; schema: JsonSchema }>;
  body?: JsonSchema;
  response: { status: 200 | 202; description: string; schema: JsonSchema };
  handle(deps: ApiDeps, call: Call): Promise<Response>;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const PATH_PARAMS: Record<string, { description: string; schema: JsonSchema }> = {
  id: { description: 'The launch id', schema: { type: 'integer', minimum: 1 } },
  channel: { description: 'A channel of launch.yml', schema: { type: 'string' } },
  postId: { description: 'The post id, as a launch lists its posts', schema: { type: 'integer', minimum: 1 } },
};

function postId(value: string | undefined): number {
  return id(/^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN, 'the post id');
}

/**
 * Runs an edit or a delete, answering what the engine refused as the client's problem (404, 409 or
 * 400) and what the network refused as the network's (502), with the network's own words.
 */
async function onPosts<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof PostRefused) {
      if (error.reason === 'not_found') throw new ApiError(404, 'not_found', error.message);
      if (error.reason === 'invalid') throw new InvalidInput(error.message);
      throw new ApiError(409, 'refused', error.message);
    }
    if (error instanceof ConnectorError) throw new ApiError(502, 'upstream', error.message);
    throw error;
  }
}

const changesBody: JsonSchema = {
  type: 'object',
  minProperties: 1,
  properties: {
    text: { type: 'string', description: 'The post’s text; on dev.to, Hashnode and the blog, the article’s Markdown body' },
    title: { type: 'string', maxLength: 200, description: 'Articles only: dev.to, Hashnode and the blog' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Articles only' },
    link: { type: 'string', format: 'uri', description: 'Added after the text on Mastodon, Telegram and Discord; the canonical URL on dev.to and Hashnode' },
    imageUrl: { type: 'string', format: 'uri', description: 'A new image: Mastodon, Telegram (a photo message), dev.to and Hashnode covers' },
    imageAlt: { type: 'string', description: 'What the image shows, where the network keeps it' },
  },
};

export const ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/launches',
    scope: 'read',
    operationId: 'listLaunches',
    summary: 'The launches, the newest first, a page at a time',
    query: [
      { name: 'limit', description: 'How many, 1 to 100 (20 by default)', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      { name: 'cursor', description: 'The `next` of the previous page', schema: { type: 'string' } },
      { name: 'status', description: 'Only launches in this state', schema: { type: 'string', enum: STATUSES } },
    ],
    response: { status: 200, description: 'A page of launches', schema: { type: 'object', required: ['launches', 'next'], properties: { launches: { type: 'array', items: ref('Launch') }, next: { type: ['string', 'null'] } } } },
    async handle(deps, { url }) {
      const limitText = url.searchParams.get('limit');
      const limit = limitText === null ? 20 : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInput('limit is an integer from 1 to 100');
      const status = url.searchParams.get('status');
      if (status !== null && !(STATUSES as readonly string[]).includes(status)) throw new InvalidInput(`status is one of ${STATUSES.join(', ')}`);
      const cursor = url.searchParams.get('cursor');
      const page = await deps.registry.launchesPage({
        limit,
        ...(status !== null && { status: status as LaunchStatus }),
        ...(cursor !== null && { after: decodeCursor(cursor) }),
      });
      return json(200, { launches: await Promise.all(page.launches.map((l) => launchView(deps.registry, l))), next: page.next ? encodeCursor(page.next) : null });
    },
  },
  {
    method: 'GET',
    path: '/launches/{id}',
    scope: 'read',
    operationId: 'getLaunch',
    summary: 'One launch with its posts, latest numbers, index status and drafts',
    response: { status: 200, description: 'The launch', schema: ref('LaunchDetail') },
    async handle(deps, { params }) {
      return json(200, await launchResource(deps, await existingLaunch(deps, params.id)));
    },
  },
  {
    method: 'GET',
    path: '/accounts',
    scope: 'read',
    operationId: 'listAccounts',
    summary: 'The connected accounts, without their secrets',
    response: { status: 200, description: 'The accounts', schema: { type: 'object', required: ['accounts'], properties: { accounts: { type: 'array', items: ref('Account') } } } },
    async handle(deps) {
      // The registry holds only public settings; secrets live in the keychain and never come here
      return json(200, { accounts: await deps.registry.accounts() });
    },
  },
  {
    method: 'GET',
    path: '/jobs',
    scope: 'read',
    operationId: 'listJobs',
    summary: 'The work running or finished in the last day, the newest first',
    response: { status: 200, description: 'The jobs', schema: { type: 'object', required: ['jobs'], properties: { jobs: { type: 'array', items: ref('Job') } } } },
    async handle(deps) {
      return json(200, { jobs: await deps.jobs() });
    },
  },
  {
    method: 'POST',
    path: '/launches',
    scope: 'write',
    operationId: 'launchRepo',
    summary: 'Launch a repo: its pre-flight, then drafts to review, or straight to publishing with `direct`',
    body: {
      type: 'object',
      required: ['repo'],
      properties: {
        repo: { type: 'string', description: 'owner/name', pattern: '^[\\w.-]+/[\\w.-]+$' },
        ref: { type: 'string', description: 'A release tag; the latest release when left out' },
        direct: { type: 'boolean', default: false, description: 'Commit to main and publish, without a drafts pull request' },
      },
    },
    response: { status: 202, description: 'Accepted: a job drafts the launch', schema: ref('Accepted') },
    async handle(deps, { request }) {
      const input = launchRequest(await readJson(request));
      return refused(await deps.startLaunch(input.repo, input.ref, input.direct));
    },
  },
  {
    method: 'POST',
    path: '/launches/{id}/approve',
    scope: 'write',
    operationId: 'approveLaunch',
    summary: 'Approve the drafts: merge their pull request, then publish',
    response: { status: 202, description: 'Accepted: a job publishes the launch', schema: ref('Accepted') },
    async handle(deps, { params }) {
      return refused(await deps.approve((await existingLaunch(deps, params.id)).id));
    },
  },
  {
    method: 'POST',
    path: '/launches/{id}/retry/{channel}',
    scope: 'write',
    operationId: 'retryChannel',
    summary: 'Give a channel that failed for good another chance on this launch',
    response: { status: 202, description: 'Accepted: a job publishes again', schema: ref('Accepted') },
    async handle(deps, { params }) {
      const launch = await existingLaunch(deps, params.id);
      const channel: Channel = channelName(params.channel);
      return refused(await publishAgain(deps.registry, launch, channel, deps.startPublishing));
    },
  },
  {
    method: 'POST',
    path: '/articles',
    scope: 'write',
    operationId: 'writeArticle',
    summary: 'Publish an article written by hand: the blog and the pieces for the channels named',
    body: {
      type: 'object',
      required: ['title', 'markdown', 'lang'],
      properties: {
        title: { type: 'string', maxLength: 200 },
        markdown: { type: 'string', description: 'The body, without a top-level heading' },
        lang: { type: 'string', enum: ['en', 'es'] },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels besides the blog' },
        direct: { type: 'boolean', default: false },
      },
    },
    response: { status: 202, description: 'Accepted: a job writes the pieces', schema: ref('Accepted') },
    async handle(deps, { request }) {
      const input = articleRequest(await readJson(request));
      return refused(await deps.startArticle(input.input, input.direct));
    },
  },
  {
    method: 'GET',
    path: '/capabilities',
    scope: 'read',
    operationId: 'listCapabilities',
    summary: 'What each channel can do with a published post: edit, delete, and why not where it cannot',
    response: {
      status: 200,
      description: 'The capability of every channel',
      schema: { type: 'object', required: ['capabilities'], properties: { capabilities: { type: 'object', additionalProperties: ref('Capability') } } },
    },
    async handle() {
      return json(200, { capabilities: CAPABILITIES });
    },
  },
  {
    method: 'PATCH',
    path: '/posts/{postId}',
    scope: 'write',
    operationId: 'editPost',
    summary: 'Edit one published post on its network, with the account it went out with',
    body: changesBody,
    response: { status: 200, description: 'The post, now edited', schema: { type: 'object', required: ['post'], properties: { post: ref('Post') } } },
    async handle(deps, { params, request }) {
      const changes = postChanges(await readJson(request));
      return json(200, { post: await onPosts(async () => editPost(postId(params.postId), changes, await deps.editing())) });
    },
  },
  {
    method: 'DELETE',
    path: '/posts/{postId}',
    scope: 'write',
    operationId: 'deletePost',
    summary: 'Delete one published post on its network (dev.to unpublishes); the launch never publishes it again',
    response: { status: 200, description: 'The post, now deleted', schema: { type: 'object', required: ['post'], properties: { post: ref('Post') } } },
    async handle(deps, { params }) {
      return json(200, { post: await onPosts(async () => deletePost(postId(params.postId), await deps.editing())) });
    },
  },
  {
    method: 'PATCH',
    path: '/launches/{id}/posts',
    scope: 'write',
    operationId: 'editLaunchPosts',
    summary: 'Edit every post of a launch at once through the shared fields, each network taking what it has',
    body: { ...changesBody, properties: { ...(changesBody.properties as JsonSchema), channels: { type: 'array', items: { type: 'string' }, description: 'Only these channels; every channel when left out' } } },
    response: { status: 200, description: 'What happened to each post', schema: { type: 'object', required: ['outcomes'], properties: { outcomes: { type: 'array', items: ref('PostOutcome') } } } },
    async handle(deps, { params, request }) {
      const body = object(await readJson(request), 'the body');
      const { channels: named, ...rest } = body;
      const channels = channelList(named);
      const changes = postChanges(rest);
      const launch = await existingLaunch(deps, params.id);
      return json(200, { outcomes: await onPosts(async () => editPosts(launch.id, changes, channels, await deps.editing())) });
    },
  },
  {
    method: 'DELETE',
    path: '/launches/{id}/posts',
    scope: 'write',
    operationId: 'deleteLaunchPosts',
    summary: 'Delete every post of a launch, or those of the channels named; what a network cannot delete is reported',
    query: [{ name: 'channels', description: 'Comma-separated channels; every channel when left out', schema: { type: 'string' } }],
    response: { status: 200, description: 'What happened to each post', schema: { type: 'object', required: ['outcomes'], properties: { outcomes: { type: 'array', items: ref('PostOutcome') } } } },
    async handle(deps, { params, url }) {
      const channels = channelList(url.searchParams.get('channels'));
      const launch = await existingLaunch(deps, params.id);
      return json(200, { outcomes: await onPosts(async () => deleteLaunchPosts(launch.id, channels, await deps.editing())) });
    },
  },
];

const compiled = ROUTES.map((route) => {
  const names: string[] = [];
  const pattern = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { route, names, regex: new RegExp(`^${pattern}$`) };
});

function authenticate(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    const why = request.headers.has('cookie') ? 'the API takes a bearer token, not the session cookie' : 'send Authorization: Bearer <token>';
    throw new ApiError(401, 'unauthorized', why, { 'www-authenticate': 'Bearer realm="shipcast"' });
  }
  return match[1]!;
}

/** Checks the bearer token, counting a wrong one against the client; answers the token's scopes */
async function bearer(request: Request, deps: Pick<ApiDeps, 'registry' | 'secrets' | 'limiter'>): Promise<readonly ApiScope[]> {
  const client = request.headers.get(PEER_HEADER) || 'unknown';
  const wait = deps.limiter.blocked(client);
  if (wait !== undefined) throw new ApiError(429, 'rate_limited', 'too many wrong tokens; wait and try again', { 'retry-after': String(wait) });
  const check = await verifyApiToken(deps, authenticate(request));
  if (!check.ok) {
    deps.limiter.fail(client);
    throw new ApiError(401, 'unauthorized', check.reason === 'revoked' ? 'this token was revoked' : 'this token is not valid', {
      'www-authenticate': 'Bearer realm="shipcast", error="invalid_token"',
    });
  }
  return check.token.scopes;
}

/**
 * WebMCP's calls, made by the app's own page in the owner's browser, carry the session cookie rather
 * than a token, with WEBMCP_HEADER and no Authorization. They are taken only when the owner turned
 * WebMCP on, and only when the browser says the request is same-origin: a page on another site can
 * neither add the custom header without a CORS preflight the app never answers, nor forge
 * Sec-Fetch-Site. Anything else falls through to the bearer token. See docs/decisions/mcp.md
 */
async function webMcpSession(request: Request, deps: Pick<ApiDeps, 'registry' | 'secrets'>): Promise<boolean> {
  if (request.headers.has('authorization') || request.headers.get(WEBMCP_HEADER) !== '1') return false;
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return false;
  if (!(await readWebMcp(deps.registry))) throw new ApiError(401, 'unauthorized', 'WebMCP is off; turn it on in the app’s settings, or use a bearer token', { 'www-authenticate': 'Bearer realm="shipcast"' });
  const session = await readSession(deps.secrets, cookieOf(request, SESSION_COOKIE));
  if (!session) throw new ApiError(401, 'unauthorized', 'sign in to the app first', { 'www-authenticate': 'Bearer realm="shipcast"' });
  return true;
}

/**
 * The bearer check alone, for the MCP endpoint (/mcp): the same tokens, the same limit on wrong ones,
 * and a refusal shaped like the API's. Answers the refusal, or nothing when the token is good; the
 * scopes are then checked route by route, as each tool calls the API with the same token.
 */
export async function checkBearer(request: Request, deps: Pick<ApiDeps, 'registry' | 'secrets' | 'limiter'>): Promise<Response | undefined> {
  try {
    await bearer(request, deps);
    return undefined;
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    throw error;
  }
}

/** Serves one request under /api/v1, whatever its method; the route file hands every request here */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.slice(API_PREFIX.length) || '/';
  try {
    if (path === '/openapi.json') {
      if (request.method !== 'GET') throw new ApiError(405, 'method_not_allowed', 'GET only', { allow: 'GET' });
      return json(200, openApiDocument(deps.publicUrl), { 'cache-control': 'no-cache' });
    }

    // The signed-in owner, through WebMCP, may do what a read and write token may
    const scopes: readonly ApiScope[] = (await webMcpSession(request, deps)) ? ['read', 'write'] : await bearer(request, deps);

    const matches = compiled.flatMap((c) => {
      const m = c.regex.exec(path);
      return m ? [{ ...c, values: m.slice(1) }] : [];
    });
    if (matches.length === 0) throw new ApiError(404, 'not_found', `no route ${path}; the routes are in ${API_PREFIX}/openapi.json`);
    const found = matches.find((m) => m.route.method === request.method);
    if (!found) {
      const allow = matches.map((m) => m.route.method).join(', ');
      throw new ApiError(405, 'method_not_allowed', `${path} takes ${allow}`, { allow });
    }
    if (!hasScope({ scopes: [...scopes] }, found.route.scope)) {
      throw new ApiError(403, 'insufficient_scope', `this token lacks the ${found.route.scope} scope`, {
        'www-authenticate': `Bearer realm="shipcast", error="insufficient_scope", scope="${found.route.scope}"`,
      });
    }
    const params = Object.fromEntries(found.names.map((name, i) => [name, decodeURIComponent(found.values[i] ?? '')]));
    return await found.route.handle(deps, { request, url, params, scopes });
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error);
    if (error instanceof InvalidInput) return errorResponse(new ApiError(400, 'invalid_input', error.message));
    console.error(error);
    return errorResponse(new ApiError(500, 'internal', 'something went wrong; the details are in the app’s log'));
  }
}

const launchProperties = {
  id: { type: 'integer' },
  repo: { type: 'string' },
  ref: { type: 'string' },
  kind: { type: 'string' },
  trigger: { type: 'string' },
  status: { type: 'string', enum: STATUSES },
  state: { type: 'object', properties: { label: { type: 'string' }, tone: { type: 'string' } } },
  pullRequest: { type: 'string', description: 'The drafts pull request, when there is one' },
  problem: { type: 'string', description: 'Why it failed' },
  createdAt: { type: 'string', format: 'date-time' },
  posts: {
    type: 'array',
    items: { type: 'object', properties: { id: { type: 'integer' }, channel: { type: 'string' }, kind: { type: 'string' }, url: { type: ['string', 'null'] }, publishedAt: { type: 'string' } } },
  },
  failures: { type: 'array', items: { type: 'object', properties: { channel: { type: 'string' }, message: { type: 'string' } } } },
  headline: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } } } },
};

/** The OpenAPI 3.1 description, built from ROUTES so it cannot drift from what is served */
export function openApiDocument(publicUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of ROUTES) {
    const pathParams = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => {
      const p = PATH_PARAMS[m[1]!] ?? { description: m[1]!, schema: { type: 'string' } };
      return { name: m[1], in: 'path', required: true, description: p.description, schema: p.schema };
    });
    const queryParams = (route.query ?? []).map((q) => ({ name: q.name, in: 'query', required: false, description: q.description, schema: q.schema }));
    const errors = (codes: number[]) => Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/E${c}` }]));
    (paths[route.path] ??= {})[route.method.toLowerCase()] = {
      operationId: route.operationId,
      summary: route.summary,
      security: [{ bearer: [route.scope] }],
      'x-scope': route.scope,
      ...(pathParams.length + queryParams.length > 0 && { parameters: [...pathParams, ...queryParams] }),
      ...(route.body && { requestBody: { required: true, content: { 'application/json': { schema: route.body } } } }),
      responses: {
        [String(route.response.status)]: { description: route.response.description, content: { 'application/json': { schema: route.response.schema } } },
        ...errors(
          route.method === 'GET'
            ? [400, 401, 403, 404, 429]
            : route.method === 'DELETE'
              ? [400, 401, 403, 404, 409, 429, 502]
              : [400, 401, 403, 404, 409, 415, 429, ...(route.method === 'PATCH' ? [502] : [])],
        ),
      },
    };
  }
  const error = { description: '', content: { 'application/json': { schema: ref('Error') } } };
  const described = (text: string) => ({ ...error, description: text });
  return {
    openapi: '3.1.0',
    info: {
      title: 'Shipcast API',
      version: '1',
      description: 'Launches, their posts and numbers, and the work that drafts and publishes them. Every route takes `Authorization: Bearer <token>`; tokens are made in the app, under API.',
    },
    servers: [{ url: `${publicUrl}${API_PREFIX}` }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'A token made in the app, with the `read` or `write` scope or both' } },
      responses: {
        E400: described('The input is not valid'),
        E401: described('No token, or one that is not valid or was revoked'),
        E403: described('The token lacks the scope this route needs'),
        E404: described('No such launch or route'),
        E409: described('Refused: launched already, a failing pre-flight, drafts that cannot merge…'),
        E415: described('The body is not JSON'),
        E429: described('Too many wrong tokens from this client; see Retry-After'),
        E502: described('The network refused the edit or the delete; the message is what it said'),
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } } },
        },
        Accepted: { type: 'object', required: ['job'], properties: { job: { type: 'string', description: 'The job doing the work; follow it at /jobs' } } },
        Launch: { type: 'object', properties: launchProperties },
        LaunchDetail: {
          type: 'object',
          properties: {
            ...launchProperties,
            detail: { type: ['string', 'null'] },
            metrics: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, name: { type: 'string' }, value: { type: 'number' }, takenAt: { type: 'string' } } } },
            index: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  engine: { type: 'string', enum: ['google', 'bing'] },
                  lang: { type: 'string' },
                  url: { type: 'string' },
                  indexed: { type: ['boolean', 'null'] },
                  coverage: { type: ['string', 'null'] },
                  checkedAt: { type: ['string', 'null'] },
                },
              },
            },
            drafts: {
              type: ['object', 'null'],
              description: 'The drafts pull request and its files, without their text; null when the launch has none',
              properties: {
                pullRequest: { type: 'object', properties: { number: { type: 'integer' }, url: { type: 'string' }, state: { type: 'string', enum: ['open', 'merged', 'closed'] }, branch: { type: 'string' } } },
                count: { type: 'integer' },
                files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' } } } },
                error: { type: 'string' },
              },
            },
          },
        },
        Account: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            network: { type: 'string' },
            brand: { type: 'string' },
            label: { type: 'string' },
            settings: { type: 'object', additionalProperties: { type: 'string' }, description: 'Public settings only; secrets stay in the keychain' },
            primary: { type: 'boolean' },
            status: { type: 'string', enum: ['unchecked', 'ok', 'failed'] },
            identity: { type: ['string', 'null'] },
            problem: { type: ['string', 'null'] },
            checkedAt: { type: ['string', 'null'] },
            createdAt: { type: 'string' },
          },
        },
        Post: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            launchId: { type: 'integer' },
            channel: { type: 'string' },
            accountId: { type: ['integer', 'null'] },
            kind: { type: 'string' },
            externalId: { type: ['string', 'null'] },
            url: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['scheduled', 'live', 'edited', 'deleted', 'failed'] },
            contentHash: { type: ['string', 'null'], description: 'The hash of what the last edit sent' },
            publishedAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        PostOutcome: {
          type: 'object',
          required: ['postId', 'channel', 'kind', 'ok'],
          properties: {
            postId: { type: 'integer' },
            channel: { type: 'string' },
            kind: { type: 'string' },
            ok: { type: 'boolean' },
            post: ref('Post'),
            reason: { type: 'string', enum: ['not_found', 'unsupported', 'deleted', 'invalid', 'no_credentials', 'failed'] },
            problem: { type: 'string' },
          },
        },
        Capability: {
          type: 'object',
          required: ['edit', 'delete', 'note', 'fields'],
          properties: {
            edit: { type: 'string', enum: ['yes', 'no', 'partial'] },
            delete: { type: 'string', enum: ['yes', 'no', 'unpublish'], description: '`unpublish`: off the site, kept in the author’s drafts' },
            note: { type: 'string' },
            fields: { type: 'array', items: { type: 'string', enum: ['text', 'title', 'tags', 'link', 'image'] } },
          },
        },
        Job: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            state: { type: 'string' },
            log: { type: 'array', items: { type: 'string' } },
            link: { type: ['string', 'null'] },
            startedAt: { type: 'string' },
          },
        },
      },
    },
  };
}
