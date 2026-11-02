import type { SitePreview } from '@shipcast/engine';
import type { ApiDeps, ApiRoute } from './api.ts';
import { ApiError } from './errors.ts';
import { id, InvalidInput, object, text } from './input.ts';
import { publishAgain } from './launches.server.ts';

/*
 * The drafts routes of the REST API: one draft read in full and edited, the article previewed on the
 * real site, and a whole launch published again (the launch page's server functions,
 * launches.functions.ts; publishing one channel again is retryChannel in api.ts, through the same
 * publishAgain). A launch's drafts are the launch model's rows (docs/app-review.md); one decided in
 * its pull request before that model is read, never edited.
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts, so the two modules never need each other at load time. A route and the server
 * function it mirrors call the same service. See docs/decisions/mcp-parity.md
 */

type JsonSchema = Record<string, unknown>;

/** A use case's refusal, given as data so the page can show it: the route answers it as 404 or 409 */
export type Refusal = { ok: false; problem: string };

/**
 * What the routes run in the app's process, built per request by draftsApi in drafts.server.ts; left out
 * where it is not wired (the tests of other routes), so a route answers a refusal without it
 */
export interface DraftsApi {
  /** One draft edited: a new version in the launch model's rows; `by` is kept on that version */
  edit(launchId: number, path: string, content: string, by: string | null): Promise<{ ok: true } | Refusal>;
  /** The article of a launch Shipcast holds pushed to a preview branch, whose draft pull request the site deploys */
  requestPreview(launchId: number): Promise<{ ok: true; preview: SitePreview } | Refusal>;
  /** That preview as last asked for, with its address once the site's workflow wrote it */
  findPreview(launchId: number): Promise<{ ok: true; preview: SitePreview } | Refusal>;
}

/** The refusals that mean the thing is not there, rather than not allowed */
const MISSING = new Set(['no such launch', 'no preview was asked for']);

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** The answer of a use case, or its refusal thrown as the API's error */
function settled<T extends { ok: true }>(result: T | Refusal): T {
  if (result.ok) return result;
  throw MISSING.has(result.problem) ? new ApiError(404, 'not_found', result.problem) : new ApiError(409, 'refused', result.problem);
}

function servicesOf(deps: ApiDeps): DraftsApi {
  if (!deps.drafts) throw new ApiError(409, 'refused', 'the drafts routes are not available in this process');
  return deps.drafts;
}

function launchId(value: string | undefined): number {
  return id(/^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN, 'the launch id');
}

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'unsupported_media_type', 'send JSON, with content-type: application/json');
  }
  const body = await request.text();
  if (body.length > 300_000) throw new InvalidInput('the body is too large');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
}

/** A draft's path, as the launch's drafts list them; the same bound the page's edit has */
const draftPathOf = (value: unknown) => text(value, 'path', 300);

/**
 * One draft of a launch with its whole text, read as GET /launches/{id} reads the list: from the
 * launch model's tables. `open` is whether its drafts can still be edited and approved.
 */
async function readDraft(deps: ApiDeps, launchIdValue: number, path: string) {
  const launch = await deps.registry.launches.get(launchIdValue);
  if (!launch) throw new ApiError(404, 'not_found', 'no such launch');
  const review = await deps.launchRead.review(launch);
  if (!review) throw new ApiError(404, 'not_found', 'this launch has no drafts');
  const draft = review.drafts.find((d) => d.path === path);
  if (!draft) throw new ApiError(404, 'not_found', `${path} is not a draft of this launch; GET /launches/{id} lists its drafts`);
  // A launch decided in its pull request before the launch model is only read
  const open = review.app?.open ?? false;
  return {
    draft: {
      path: draft.path,
      label: draft.label,
      kind: draft.kind,
      ...(draft.content !== undefined && { content: draft.content }),
      ...(draft.url !== undefined && { url: draft.url }),
      ...(draft.approved !== undefined && { approved: draft.approved }),
    },
    open,
    ...(review.pullRequest && { pullRequest: review.pullRequest }),
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const DRAFTS_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/launches/{id}/draft',
    scope: 'read',
    operationId: 'getDraft',
    summary:
      'One draft of a launch with its whole text (an article’s Markdown, a channel’s piece) as its current version; media are listed with their address, not read',
    query: [{ name: 'path', description: 'The draft’s path, as GET /launches/{id} lists them under drafts.files', schema: { type: 'string', maxLength: 300 } }],
    response: { status: 200, description: 'The draft', schema: ref('DraftRead') },
    async handle(deps, { params, url }) {
      const id = launchId(params.id);
      const path = url.searchParams.get('path');
      if (path === null || path === '') throw new InvalidInput('path is the draft’s path, as GET /launches/{id} lists them');
      return answer(200, await readDraft(deps, id, draftPathOf(path)));
    },
  },
  {
    method: 'PUT',
    path: '/launches/{id}/draft',
    scope: 'write',
    operationId: 'editDraft',
    summary:
      'Replace one draft’s text before it goes out, as a new version (which an earlier approval does not cover: approve again). Refused for a piece already out, an article already on the site, a text too long for its network, or a launch decided in its pull request before the launch model',
    body: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', maxLength: 300, description: 'The draft’s path, as GET /launches/{id} lists them' },
        content: { type: 'string', maxLength: 200_000, description: 'The draft’s whole new text, as GET /launches/{id}/draft gives it' },
      },
    },
    response: { status: 200, description: 'The draft was saved', schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } },
    async handle(deps, { params, request }) {
      const id = launchId(params.id);
      const body = object(await readJson(request), 'the body');
      const path = draftPathOf(body.path);
      const content = text(body.content, 'content', 200_000);
      settled(await servicesOf(deps).edit(id, path, content, 'api'));
      return answer(200, { path });
    },
  },
  {
    method: 'POST',
    path: '/launches/{id}/site-preview',
    scope: 'write',
    operationId: 'requestSitePreview',
    summary:
      'Preview a launch Shipcast holds on the real site: its article and media pushed to a preview branch of the launches repo (public, at an address nobody can guess), whose draft pull request the site’s workflow deploys in a few minutes. Answers at once, before the deploy; asked again, the same branch is updated. Refused for a launch decided in its pull request, which had its own preview',
    response: { status: 200, description: 'The preview as asked for, without its address yet', schema: { type: 'object', required: ['preview'], properties: { preview: ref('SitePreview') } } },
    async handle(deps, { params }) {
      const { preview } = settled(await servicesOf(deps).requestPreview(launchId(params.id)));
      return answer(200, { preview });
    },
  },
  {
    method: 'GET',
    path: '/launches/{id}/site-preview',
    scope: 'read',
    operationId: 'getSitePreview',
    summary: 'A launch’s preview on the real site as last asked for, with its address (`url`) once the site’s workflow deployed it and wrote it on the preview’s pull request',
    response: { status: 200, description: 'The preview; no `url` while it is being deployed', schema: { type: 'object', required: ['preview'], properties: { preview: ref('SitePreview') } } },
    async handle(deps, { params }) {
      const { preview } = settled(await servicesOf(deps).findPreview(launchId(params.id)));
      return answer(200, { preview });
    },
  },
  {
    method: 'POST',
    path: '/launches/{id}/publish',
    scope: 'write',
    operationId: 'publishLaunchAgain',
    summary:
      'Publish a drafted launch again: what its approval clears and is not out yet goes out (a publishing that was missed), each piece once; nothing goes while its drafts wait for approval. Refused for a launch that is not drafted; one channel that failed is POST /launches/{id}/retry/{channel}',
    response: { status: 202, description: 'Accepted: a job publishes what is pending', schema: ref('Accepted') },
    async handle(deps, { params }) {
      // Without a channel: the use case of the launch page's "Publish what is pending", refused unless drafted
      const started = settled(await publishAgain(deps.registry, launchId(params.id), undefined, deps.startPublishing));
      return answer(202, { job: started.job });
    },
  },
];

export const DRAFTS_SCHEMAS: Record<string, JsonSchema> = {
  DraftRead: {
    type: 'object',
    required: ['draft', 'open'],
    properties: {
      draft: {
        type: 'object',
        required: ['path', 'label', 'kind'],
        properties: {
          path: { type: 'string' },
          label: { type: 'string', description: 'What it is: Article (en), Bluesky, Instagram slide 3' },
          kind: { type: 'string', enum: ['article', 'channel', 'image', 'video', 'data'] },
          content: { type: 'string', description: 'Articles and channels: the whole text, as PUT /launches/{id}/draft takes it' },
          url: { type: 'string', description: 'Media: where its bytes can be seen' },
          approved: { type: 'boolean', description: 'A launch Shipcast holds: whether this version is the approved one' },
        },
      },
      open: { type: 'boolean', description: 'Whether the launch’s drafts can still be edited and approved' },
      pullRequest: { type: 'object', description: 'A launch decided in its pull request before the launch model: that pull request', properties: { number: { type: 'integer' }, url: { type: 'string' }, state: { type: 'string', enum: ['open', 'merged', 'closed'] }, branch: { type: 'string' } } },
    },
  },
  SitePreview: {
    type: 'object',
    required: ['branch', 'number', 'pullRequest', 'sha', 'at'],
    properties: {
      branch: { type: 'string', description: 'The preview branch of the launches repo' },
      number: { type: 'integer', description: 'Its draft pull request, never merged' },
      pullRequest: { type: 'string' },
      sha: { type: 'string', description: 'The commit the preview was last asked for' },
      at: { type: 'string', format: 'date-time' },
      url: { type: 'string', description: 'The preview’s address, once deployed' },
      urlSha: { type: 'string', description: 'The commit that address shows: an older one than `sha` is still being replaced' },
    },
  },
};
