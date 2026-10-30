import { MAX_UPLOAD_BYTES, type SourceMedia, type SourcesLaunchInput } from '@shipcast/engine';
import type { ApiRoute } from './api.ts';
import { InvalidInput } from './input.ts';
import { sourcesRequest } from './requests.ts';

/*
 * The routes of launches made from sources (launch-sources, docs/sources.md): a file uploaded to the
 * media store, and a launch made from sources and drafted. Kept apart from api.ts, which spreads them
 * into its routes and its OpenAPI document; only types come back from api.ts.
 */

type JsonSchema = Record<string, unknown>;

/** What the routes run in the app's process; left out where they are not wired (tests of other routes) */
export interface SourcesApi {
  start(input: SourcesLaunchInput): Promise<{ ok: true; job: string } | { ok: false; problem: string }>;
  upload(bytes: Uint8Array): Promise<{ ok: true; file: SourceMedia } | { ok: false; problem: string }>;
}

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });
const unavailable = () => failure(409, 'refused', 'launches made from sources are not available in this process');

/** A launch's sources may hold long texts: more room than other JSON bodies, still bounded */
const MAX_JSON_CHARS = 1_500_000;

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new InvalidInput('send JSON, with content-type: application/json');
  const text = await request.text();
  if (text.length > MAX_JSON_CHARS) throw new InvalidInput('the body is too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
}

/** The body's bytes, stopped as soon as they pass `max`: a declared length is not trusted to be the real one */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | undefined> {
  if (Number(request.headers.get('content-length') ?? 0) > max) return undefined;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const sourceSchema: JsonSchema = {
  oneOf: [
    { type: 'object', required: ['kind', 'text'], properties: { kind: { const: 'text' }, text: { type: 'string', description: 'Your own words: notes, a draft, an opinion' }, title: { type: 'string' } } },
    { type: 'object', required: ['kind', 'url'], properties: { kind: { const: 'url' }, url: { type: 'string', format: 'uri', description: 'A public http(s) page, fetched once by Shipcast' } } },
    {
      type: 'object',
      required: ['kind', 'repo'],
      properties: {
        kind: { const: 'repo' },
        repo: { type: 'string', description: 'owner/name' },
        ref: { type: 'string', description: 'The primary repo’s release tag (its latest when left out); another repo’s branch or tag (its default branch when left out)' },
        primary: { type: 'boolean', description: 'The repo whose release this launch is; the first repo when none is marked' },
      },
    },
    { type: 'object', required: ['kind', 'sha256'], properties: { kind: { const: 'media' }, sha256: { type: 'string', description: 'What POST /media answered' }, name: { type: 'string' }, alt: { type: 'string' } } },
  ],
};

export const SOURCES_SCHEMAS: Record<string, JsonSchema> = {
  UploadedFile: {
    type: 'object',
    required: ['sha256', 'mime', 'bytes'],
    properties: { sha256: { type: 'string' }, mime: { type: 'string' }, bytes: { type: 'integer' }, width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] } },
  },
};

export const SOURCES_ROUTES: ApiRoute[] = [
  {
    method: 'POST',
    path: '/media',
    scope: 'write',
    operationId: 'uploadMedia',
    summary: 'Upload an image for a launch made from sources (PNG, JPEG, GIF or WebP; its metadata is removed); name it in the launch by its sha256',
    body: { type: 'string', format: 'binary' },
    bodyType: 'application/octet-stream',
    response: { status: 200, description: 'The file as stored', schema: { type: 'object', required: ['file'], properties: { file: ref('UploadedFile') } } },
    async handle(deps, { request }) {
      if (!deps.sources) return unavailable();
      const bytes = await readCapped(request, MAX_UPLOAD_BYTES);
      if (!bytes) return failure(413, 'too_large', `a file has at most ${MAX_UPLOAD_BYTES} bytes`);
      const stored = await deps.sources.upload(bytes);
      if (!stored.ok) return failure(409, 'refused', stored.problem);
      const { sha256, mime, bytes: size, width, height } = stored.file;
      return answer(200, { file: { sha256, mime, bytes: size, width, height } });
    },
  },
  {
    method: 'POST',
    path: '/launches/sources',
    scope: 'write',
    operationId: 'launchFromSources',
    summary: 'Make a launch from sources (text, pages, repos, uploaded files) and draft it: the primary repo’s release is the launch, or with no repo it is claimed by its title',
    body: {
      type: 'object',
      required: ['title', 'sources'],
      properties: {
        title: { type: 'string', maxLength: 200 },
        lang: { type: 'string', enum: ['en', 'es'], description: 'The language of the title and your text; en when left out' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channels besides the blog, for a launch with no repo; a repo’s launch.yml decides for one with a primary repo' },
        sources: { type: 'array', minItems: 1, maxItems: 12, items: sourceSchema },
      },
    },
    response: { status: 202, description: 'Accepted: a job drafts the launch', schema: ref('Accepted') },
    async handle(deps, { request }) {
      const input = sourcesRequest(await readJson(request));
      if (!deps.sources) return unavailable();
      const started = await deps.sources.start(input);
      return started.ok ? answer(202, { job: started.job }) : failure(409, 'refused', started.problem);
    },
  },
];
