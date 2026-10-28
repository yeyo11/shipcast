import {
  CAPABILITIES,
  COMMENT_CHANNELS,
  COMMENT_STATUSES,
  REPLY_CAPABILITIES,
  REPLY_MODES,
  type CommentDeps,
  type CommentStatus,
  SCHEDULABLE_CHANNELS,
  type ApiScope,
  type ArticleInput,
  type EditDeps,
  type JobCursor,
  type Launch,
  LAUNCH_ORDERS,
  LAUNCH_STATUSES,
  TRIGGERS,
  type LaunchCursor,
  type LaunchFilter,
  type LaunchOrder,
  type Post,
  type Repositories,
  type ReviewGitHub,
} from '@shipcast/engine';
import { WEBMCP_HEADER } from '@shipcast/mcp/webmcp';
import { hasScope, readWebMcp, verifyApiToken, type SecretStore } from '@shipcast/runtime';
import { PackKind, type Channel } from '@shipcast/schema';
import { id, InvalidInput, object } from './input.ts';
import { ApiError, apiErrorOf, errorBody } from './errors.ts';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server.ts';
import { launchDetail, launchView, publishAgain } from './launches.server.ts';
import { isRepo } from './launches-search.ts';
import { channelList, postChanges } from './post-changes.ts';
import { articleRequest, channelName, launchRequest, moment } from './requests.ts';
export { ApiError } from './errors.ts';
import { STATS_ROUTES, STATS_SCHEMAS } from './stats-api.ts';
import { PROFILE_ROUTES, PROFILE_SCHEMAS, type ProfileApi } from './profile-api.ts';
import { commentView } from './comment-view.ts';
import { accountService, commentService, postService, scheduleService } from './app-services.ts';

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
  registry: Pick<Repositories, 'launches' | 'posts' | 'attempts' | 'metrics' | 'accounts' | 'comments' | 'settings' | 'cursors' | 'apiTokens' | 'queries'>;
  secrets: SecretStore;
  github: ReviewGitHub;
  launchesRepo: string;
  /** The public origin the OpenAPI document names as its server */
  publicUrl: string;
  limiter: FailureLimiter;
  /** A page of the last day's work list, the newest first; `next` starts the following page */
  jobs(page: { limit: number; before?: JobCursor }): Promise<{ jobs: JobView[]; next: JobCursor | null }>;
  startLaunch(repo: string, ref: string | undefined, direct: boolean): Promise<WorkAnswer>;
  approve(launchId: number): Promise<WorkAnswer>;
  startArticle(input: ArticleInput, direct: boolean): Promise<WorkAnswer>;
  startPublishing(launch: Launch, retryChannel?: Channel): Promise<string>;
  /** What editing and deleting published pieces needs: the connectors by account, and GitHub for the blog */
  editing(): Promise<EditDeps>;
  /** Queues (or moves) the wake-up of each scheduled piece at its time */
  armSchedule(posts: Post[]): Promise<void>;
  /** What sending a reply needs: each post's connectors, by the account it went out with */
  comments(): Promise<CommentDeps>;
  /** Queues a run of the comment assistant by hand */
  checkComments(): Promise<WorkAnswer>;
  /** Queues a fresh draft of one comment's reply */
  redraftComment(commentId: number): Promise<WorkAnswer>;
  /** Account analysis: a profile's review as a job, and its edit on the network */
  profiles?: ProfileApi;
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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });

const errorResponse = (error: ApiError) => json(error.status, errorBody(error), error.headers);

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

const STATUSES = LAUNCH_STATUSES;

/** The comment service over the API's ports: replies go out with the connectors deps.comments builds */
const commentsOf = (deps: ApiDeps) => commentService({ registry: deps.registry, sending: deps.comments });

/**
 * An opaque position in the launches' order: the last launch's creation time and id, and the order
 * when it is the oldest first. A newest-first cursor is the two-item one this API always gave, so
 * cursors handed out before the order existed still work.
 */
const encodeCursor = (at: LaunchCursor, order: LaunchOrder = 'newest') =>
  Buffer.from(JSON.stringify(order === 'oldest' ? [at.createdAt, at.id, order] : [at.createdAt, at.id])).toString('base64url');

function decodeCursor(cursor: string, order: LaunchOrder = 'newest'): LaunchCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // falls through to the error below
  }
  if (Array.isArray(value) && typeof value[0] === 'string' && Number.isInteger(value[1]) && (value.length === 2 || value.length === 3)) {
    // A cursor walks the order it was given in: another order's would skip or repeat launches
    if ((value[2] ?? 'newest') !== order) throw new InvalidInput('cursor belongs to the other sort: send the sort it was given with');
    return { createdAt: value[0], id: value[1] as number };
  }
  throw new InvalidInput('cursor is not one this API gave');
}

/** The work list's position: the last job's creation time and its id, pg-boss's string */
const encodeJobCursor = (at: JobCursor) => Buffer.from(JSON.stringify([at.createdAt, at.id])).toString('base64url');

function decodeJobCursor(cursor: string): JobCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    // falls through to the error below
  }
  // A launches cursor has a number for its id: refused here rather than read as a job's
  if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'string') return { createdAt: value[0], id: value[1] };
  throw new InvalidInput('cursor is not one this API gave');
}

/** `limit` of a list: an integer in its range, or the default when left out */
function listLimit(url: URL, fallback: number): number {
  const text = url.searchParams.get('limit');
  const limit = text === null ? fallback : Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInput('limit is an integer from 1 to 100');
  return limit;
}

/** One of a closed list, or nothing when the parameter is absent; anything else is the client's mistake */
function choice<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T | undefined {
  const value = params.get(name);
  if (value === null) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new InvalidInput(`${name} is one of ${allowed.join(', ')}`);
  return value as T;
}

/** `GET /launches`' query as the registry's page request; every parameter is optional, as before */
export function readLaunchesQuery(params: URLSearchParams): LaunchFilter & { limit: number; after?: LaunchCursor } {
  const limitText = params.get('limit');
  const limit = limitText === null ? 20 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidInput('limit is an integer from 1 to 100');
  const status = choice(params, 'status', STATUSES);
  const trigger = choice(params, 'trigger', TRIGGERS);
  const kind = choice(params, 'kind', PackKind.options);
  const order = choice(params, 'sort', LAUNCH_ORDERS);
  const repo = params.get('repo');
  if (repo !== null && !isRepo(repo)) throw new InvalidInput('repo is owner/name');
  const q = params.get('q')?.trim() ?? '';
  if (q.length > 200) throw new InvalidInput('q is at most 200 characters');
  const cursor = params.get('cursor');
  return {
    limit,
    ...(status && { status }),
    ...(trigger && { trigger }),
    ...(kind && { kind }),
    ...(repo !== null && { repo }),
    ...(q && { search: q }),
    ...(order && { order }),
    ...(cursor !== null && { after: decodeCursor(cursor, order) }),
  };
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
  const launch = await deps.registry.launches.get(launchId(value));
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
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
  accountId: { description: 'The account id, as /accounts lists them', schema: { type: 'integer', minimum: 1 } },
  commentId: { description: 'The comment id, as GET /comments lists them', schema: { type: 'integer', minimum: 1 } },
};

function commentId(value: string | undefined): number {
  return id(/^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN, 'the comment id');
}


const commentAnswer = { type: 'object', required: ['comment'], properties: { comment: { $ref: '#/components/schemas/Comment' } } };

function postId(value: string | undefined): number {
  return id(/^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN, 'the post id');
}



const dateTime = { type: 'string', format: 'date-time', description: 'ISO 8601 with its offset; a time already past sends it on the next run' };

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
    summary: 'The launches, the newest first, a page at a time, filtered and searched',
    query: [
      { name: 'limit', description: 'How many, 1 to 100 (20 by default)', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
      { name: 'cursor', description: 'The `next` of the previous page, sent with the same filters and sort', schema: { type: 'string' } },
      { name: 'status', description: 'Only launches in this state', schema: { type: 'string', enum: STATUSES } },
      { name: 'trigger', description: 'Only launches started this way', schema: { type: 'string', enum: TRIGGERS } },
      { name: 'kind', description: 'Only launches of this pack', schema: { type: 'string', enum: PackKind.options } },
      { name: 'repo', description: 'Only one repository’s launches, `owner/name`', schema: { type: 'string' } },
      { name: 'q', description: 'Words in the repository, the ref or an article’s title, case-insensitive', schema: { type: 'string', maxLength: 200 } },
      { name: 'sort', description: 'The newest first (the default) or the oldest first', schema: { type: 'string', enum: LAUNCH_ORDERS, default: 'newest' } },
    ],
    response: { status: 200, description: 'A page of launches', schema: { type: 'object', required: ['launches', 'next'], properties: { launches: { type: 'array', items: ref('Launch') }, next: { type: ['string', 'null'] } } } },
    async handle(deps, { url }) {
      const query = readLaunchesQuery(url.searchParams);
      const page = await deps.registry.launches.launchesPage(query);
      return json(200, { launches: await Promise.all(page.launches.map((l) => launchView(deps.registry, l))), next: page.next ? encodeCursor(page.next, query.order) : null });
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
      return json(200, { accounts: await accountService(deps).list() });
    },
  },
  {
    method: 'GET',
    path: '/jobs',
    scope: 'read',
    operationId: 'listJobs',
    summary: 'The work running or finished in the last day, the newest first, a page at a time',
    query: [
      { name: 'limit', description: 'How many, 1 to 100 (30 by default)', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
      { name: 'cursor', description: 'The `next` of the previous page', schema: { type: 'string' } },
    ],
    response: { status: 200, description: 'A page of jobs', schema: { type: 'object', required: ['jobs', 'next'], properties: { jobs: { type: 'array', items: ref('Job') }, next: { type: ['string', 'null'] } } } },
    async handle(deps, { url }) {
      const limit = listLimit(url, 30);
      const cursor = url.searchParams.get('cursor');
      const page = await deps.jobs({ limit, ...(cursor !== null && { before: decodeJobCursor(cursor) }) });
      return json(200, { jobs: page.jobs, next: page.next ? encodeJobCursor(page.next) : null });
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
      return refused(await publishAgain(deps.registry, launch.id, channel, deps.startPublishing));
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
      return json(200, { post: await postService(deps).edit(postId(params.postId), changes) });
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
      return json(200, { post: await postService(deps).delete(postId(params.postId)) });
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
      return json(200, { outcomes: await postService(deps).editMany(launch.id, changes, channels) });
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
      return json(200, { outcomes: await postService(deps).deleteMany(launch.id, channels) });
    },
  },
  ...STATS_ROUTES,
  ...PROFILE_ROUTES,
  {
    method: 'POST',
    path: '/launches/{id}/schedule',
    scope: 'write',
    operationId: 'scheduleLaunch',
    summary: 'Set the time each channel’s piece of a launch goes out; it still waits for the drafts’ approval, and a channel scheduled again is moved',
    body: {
      type: 'object',
      required: ['times'],
      properties: { times: { type: 'object', minProperties: 1, description: 'Channel to time, such as {"bluesky": "2026-10-27T17:00:00+01:00"}', additionalProperties: dateTime } },
    },
    response: { status: 200, description: 'The scheduled pieces', schema: { type: 'object', required: ['posts'], properties: { posts: { type: 'array', items: ref('Post') } } } },
    async handle(deps, { params, request }) {
      const launch = await existingLaunch(deps, params.id);
      const raw = object(object(await readJson(request), 'the body').times, 'times');
      const times: Partial<Record<Channel, Date>> = {};
      for (const [name, value] of Object.entries(raw)) {
        if (!(SCHEDULABLE_CHANNELS as readonly string[]).includes(name)) throw new InvalidInput(`${name} has no time: the channels are ${SCHEDULABLE_CHANNELS.join(', ')}`);
        times[name as Channel] = moment(value, `times.${name}`);
      }
      return json(200, { posts: await scheduleService(deps).schedule(launch.id, times) });
    },
  },
  {
    method: 'PATCH',
    path: '/posts/{postId}/schedule',
    scope: 'write',
    operationId: 'reschedulePost',
    summary: 'Move a scheduled piece to another time; now, or a time past, sends it on the next run',
    body: { type: 'object', required: ['at'], properties: { at: dateTime } },
    response: { status: 200, description: 'The piece, at its new time', schema: { type: 'object', required: ['post'], properties: { post: ref('Post') } } },
    async handle(deps, { params, request }) {
      const at = moment(object(await readJson(request), 'the body').at, 'at');
      return json(200, { post: await scheduleService(deps).move(postId(params.postId), at) });
    },
  },
  {
    method: 'DELETE',
    path: '/posts/{postId}/schedule',
    scope: 'write',
    operationId: 'cancelScheduledPost',
    summary: 'Cancel a scheduled piece: its channel is not published for that launch until it is scheduled again',
    response: { status: 200, description: 'The piece that was scheduled, now removed', schema: { type: 'object', required: ['post'], properties: { post: ref('Post') } } },
    async handle(deps, { params }) {
      return json(200, { post: await scheduleService(deps).cancel(postId(params.postId)) });
    },
  },
  {
    method: 'GET',
    path: '/recommendations',
    scope: 'read',
    operationId: 'recommendTimes',
    summary: 'The best times to publish on a channel in the next days, ranked, each with its reason',
    query: [
      { name: 'channel', description: 'A channel Shipcast publishes', schema: { type: 'string', enum: SCHEDULABLE_CHANNELS } },
      { name: 'days', description: 'Days ahead, 1 to 30 (7 by default)', schema: { type: 'integer', minimum: 1, maximum: 30, default: 7 } },
      { name: 'count', description: 'How many times, 1 to 30 (5 by default), one per day at most', schema: { type: 'integer', minimum: 1, maximum: 30, default: 5 } },
    ],
    response: { status: 200, description: 'The ranked times', schema: ref('Recommendation') },
    async handle(deps, { url }) {
      const channel = url.searchParams.get('channel');
      if (channel === null || !(SCHEDULABLE_CHANNELS as readonly string[]).includes(channel)) throw new InvalidInput(`channel is one of ${SCHEDULABLE_CHANNELS.join(', ')}`);
      const bounded = (name: string, fallback: number) => {
        const raw = url.searchParams.get(name);
        const value = raw === null ? fallback : Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > 30) throw new InvalidInput(`${name} is an integer from 1 to 30`);
        return value;
      };
      return json(200, await scheduleService(deps).recommend(channel as Channel, { days: bounded('days', 7), count: bounded('count', 5) }));
    },
  },
  {
    method: 'GET',
    path: '/settings/timezone',
    scope: 'read',
    operationId: 'getTimezone',
    summary: 'The owner’s time zone, which recommendations are told in (Europe/Madrid until set)',
    response: { status: 200, description: 'The zone', schema: ref('Timezone') },
    async handle(deps) {
      return json(200, { timezone: await scheduleService(deps).timezone() });
    },
  },
  {
    method: 'PATCH',
    path: '/settings/timezone',
    scope: 'write',
    operationId: 'setTimezone',
    summary: 'Set the owner’s time zone, an IANA name',
    body: { type: 'object', required: ['timezone'], properties: { timezone: { type: 'string', description: 'An IANA zone, such as Europe/Madrid' } } },
    response: { status: 200, description: 'The zone, saved', schema: ref('Timezone') },
    async handle(deps, { request }) {
      const body = object(await readJson(request), 'the body');
      return json(200, { timezone: await scheduleService(deps).setTimezone(body.timezone) });
    },
  },
  {
    method: 'GET',
    path: '/comments',
    scope: 'read',
    operationId: 'listComments',
    summary: 'The comments on Shipcast’s posts with their drafted replies, the newest first (the owner’s own left out)',
    query: [
      { name: 'status', description: 'Only comments in this state', schema: { type: 'string', enum: COMMENT_STATUSES } },
      { name: 'channel', description: 'Only this channel’s', schema: { type: 'string', enum: COMMENT_CHANNELS } },
      { name: 'launch', description: 'Only the comments on this launch’s posts', schema: { type: 'integer', minimum: 1 } },
    ],
    response: {
      status: 200,
      description: 'The comments, and what each channel can do',
      schema: {
        type: 'object',
        required: ['comments', 'capabilities'],
        properties: { comments: { type: 'array', items: ref('Comment') }, capabilities: { type: 'object', additionalProperties: ref('ReplyCapability') } },
      },
    },
    async handle(deps, { url }) {
      const status = url.searchParams.get('status');
      if (status !== null && !(COMMENT_STATUSES as readonly string[]).includes(status)) throw new InvalidInput(`status is one of ${COMMENT_STATUSES.join(', ')}`);
      const channel = url.searchParams.get('channel');
      if (channel !== null && !(COMMENT_CHANNELS as readonly string[]).includes(channel)) throw new InvalidInput(`channel is one of ${COMMENT_CHANNELS.join(', ')}`);
      const launch = url.searchParams.get('launch');
      const comments = (await commentsOf(deps).list({
        own: false,
        ...(status !== null && { status: status as CommentStatus }),
        ...(channel !== null && { channel: channel as Channel }),
        ...(launch !== null && { launchId: launchId(launch) }),
      })).map(commentView);
      return json(200, { comments, capabilities: REPLY_CAPABILITIES });
    },
  },
  {
    method: 'POST',
    path: '/comments/check',
    scope: 'write',
    operationId: 'checkComments',
    summary: 'Check comments now: read every live post’s comments and draft the new ones’ replies',
    response: { status: 202, description: 'Accepted: a job reads and drafts', schema: ref('Accepted') },
    async handle(deps) {
      return refused(await deps.checkComments());
    },
  },
  {
    method: 'POST',
    path: '/comments/{commentId}/draft',
    scope: 'write',
    operationId: 'redraftComment',
    summary: 'Draft a comment’s reply again with the AI',
    response: { status: 202, description: 'Accepted: a job drafts the reply', schema: ref('Accepted') },
    async handle(deps, { params }) {
      const answer = await deps.redraftComment(commentId(params.commentId));
      if (!answer.ok && answer.problem === 'no such comment') throw new ApiError(404, 'not_found', answer.problem);
      return refused(answer);
    },
  },
  {
    method: 'PATCH',
    path: '/comments/{commentId}',
    scope: 'write',
    operationId: 'editReply',
    summary: 'Write or edit a comment’s reply; it waits for approval',
    body: { type: 'object', required: ['draft'], properties: { draft: { type: 'string', minLength: 1, description: 'The reply, within the channel’s limit' } } },
    response: { status: 200, description: 'The comment with its new draft', schema: commentAnswer },
    async handle(deps, { params, request }) {
      const body = object(await readJson(request), 'the body');
      if (typeof body.draft !== 'string' || body.draft.length > 5000) throw new InvalidInput('draft is the reply’s text');
      const draft = body.draft;
      return json(200, { comment: commentView(await commentsOf(deps).editDraft(commentId(params.commentId), draft)) });
    },
  },
  {
    method: 'POST',
    path: '/comments/{commentId}/approve',
    scope: 'write',
    operationId: 'approveReply',
    summary: 'Approve a comment’s reply: it is sent now, with the account the post went out with',
    response: { status: 200, description: 'The comment, its reply sent', schema: commentAnswer },
    async handle(deps, { params }) {
      const id = commentId(params.commentId);
      return json(200, { comment: commentView(await commentsOf(deps).send(id)) });
    },
  },
  {
    method: 'POST',
    path: '/comments/{commentId}/dismiss',
    scope: 'write',
    operationId: 'dismissComment',
    summary: 'Dismiss a comment: no reply is sent',
    response: { status: 200, description: 'The comment, dismissed', schema: commentAnswer },
    async handle(deps, { params }) {
      return json(200, { comment: commentView(await commentsOf(deps).dismiss(commentId(params.commentId))) });
    },
  },
  {
    method: 'GET',
    path: '/comment-settings',
    scope: 'read',
    operationId: 'getCommentSettings',
    summary: 'Each channel’s reply mode: off, approval or auto',
    response: { status: 200, description: 'The modes', schema: ref('CommentSettings') },
    async handle(deps) {
      return json(200, await commentsOf(deps).settings());
    },
  },
  {
    method: 'PUT',
    path: '/comment-settings',
    scope: 'write',
    operationId: 'setCommentSettings',
    summary: 'Set channels’ reply modes; a channel left out keeps its mode (auto on dev.to is approval: it cannot send)',
    body: ref('CommentSettings'),
    response: { status: 200, description: 'The modes, saved', schema: ref('CommentSettings') },
    async handle(deps, { request }) {
      const body = await readJson(request);
      return json(200, await commentsOf(deps).saveSettings(body));
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
    const answer = apiErrorOf(error);
    if (answer.internal) console.error(error);
    return errorResponse(answer);
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
    items: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        channel: { type: 'string' },
        kind: { type: 'string' },
        url: { type: ['string', 'null'] },
        publishedAt: { type: 'string' },
        status: { type: 'string' },
        scheduledAt: { type: ['string', 'null'] },
      },
    },
  },
  failures: { type: 'array', items: { type: 'object', properties: { channel: { type: 'string' }, message: { type: 'string' } } } },
  replies: { type: 'object', description: 'Replies Shipcast sent under the launch’s posts, counted per channel', additionalProperties: { type: 'integer' } },
  headline:{ type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' } } } },
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
              : [400, 401, 403, 404, 409, 415, 429, ...(route.method === 'PATCH' || route.operationId === 'approveReply' ? [502] : [])],
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
        E404: described('No such launch, post, comment or route'),
        E409: described('Refused: launched already, a failing pre-flight, drafts that cannot merge…'),
        E415: described('The body is not JSON'),
        E429: described('Too many wrong tokens from this client; see Retry-After'),
        E502: described('The network refused the edit, the delete or the reply; the message is what it said'),
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
            metrics: { type: 'array', items: { type: 'object', properties: { source: { type: 'string' }, name: { type: 'string' }, value: { type: 'number' }, takenAt: { type: 'string' }, checkedAt: { type: 'string', description: 'When the value was last read again unchanged' } } } },
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
            scheduledAt: { type: ['string', 'null'], description: 'The time it waits for, or went out at, when it was scheduled' },
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
        Timezone: { type: 'object', required: ['timezone'], properties: { timezone: { type: 'string' } } },
        Recommendation: {
          type: 'object',
          required: ['channel', 'timezone', 'slots', 'history', 'audience'],
          properties: {
            channel: { type: 'string' },
            timezone: { type: 'string' },
            slots: {
              type: 'array',
              items: {
                type: 'object',
                required: ['at', 'local', 'score', 'basis', 'reason'],
                properties: {
                  at: { type: 'string', format: 'date-time' },
                  local: { type: 'string', description: 'The time in the owner’s zone, `Tue 2026-10-27 17:00`' },
                  score: { type: 'number', description: 'Expected performance against the channel’s median post (1 is the median)' },
                  basis: { type: 'string', enum: ['default', 'audience', 'history', 'blend'] },
                  reason: { type: 'string' },
                },
              },
            },
            history: { type: 'object', properties: { posts: { type: 'integer' }, used: { type: 'integer' }, median: { type: ['number', 'null'] }, what: { type: ['string', 'null'] } } },
            audience: { type: 'boolean', description: 'Whether Instagram’s online-follower hours were used' },
          },
        },
        Comment: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            postId: { type: 'integer' },
            launchId: { type: 'integer' },
            channel: { type: 'string', enum: COMMENT_CHANNELS },
            externalId: { type: 'string' },
            author: { type: 'object', properties: { handle: { type: 'string' }, displayName: { type: ['string', 'null'] }, avatarUrl: { type: ['string', 'null'] } } },
            text: { type: 'string' },
            url: { type: ['string', 'null'] },
            createdAt: { type: 'string' },
            inReplyTo: { type: ['string', 'null'], description: 'The parent comment’s external id, inside a thread' },
            own: { type: 'boolean' },
            fetchedAt: { type: 'string' },
            status: { type: 'string', enum: COMMENT_STATUSES },
            classification: { type: ['string', 'null'], enum: ['question', 'feedback', 'praise', 'bug', 'spam', 'abuse', 'other', null] },
            draft: { type: ['string', 'null'], description: 'The reply; null after drafting means the AI suggests dismissing it' },
            note: { type: ['string', 'null'], description: 'The AI’s one line on why' },
            problem: { type: ['string', 'null'] },
            sentExternalId: { type: ['string', 'null'] },
            sentUrl: { type: ['string', 'null'] },
            sentAt: { type: ['string', 'null'] },
            canReply: { type: 'boolean', description: 'Whether approving sends it from here' },
            replyOn: { type: 'string', description: 'Where to reply by hand, when the network’s API cannot (dev.to)' },
          },
        },
        ReplyCapability: { type: 'object', required: ['read', 'reply', 'note'], properties: { read: { type: 'boolean' }, reply: { type: 'boolean' }, note: { type: 'string' } } },
        CommentSettings: {
          type: 'object',
          required: ['replies'],
          properties: { replies: { type: 'object', properties: Object.fromEntries(COMMENT_CHANNELS.map((c) => [c, { type: 'string', enum: REPLY_MODES }])) } },
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
        ...STATS_SCHEMAS,
        ...PROFILE_SCHEMAS,
      },
    },
  };
}
