import type { ApiRoute } from './api.ts';
import { ATTENTION_KEY, type Attention, type AttentionItem, type AttentionTarget } from './attention.ts';
import { InvalidInput, list, object } from './input.ts';

/*
 * The attention routes of the REST API: the bell's list of what needs the owner, and its dismissals
 * (the pages' getAttention, dismissAttention and clearAttention, attention.functions.ts).
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts, so the two modules never need each other at load time. A route and the server
 * function it mirrors call the same service. See docs/decisions/mcp-parity.md
 */

type JsonSchema = Record<string, unknown>;

/**
 * What the routes run in the app's process, built per request by attentionApi in attention.server.ts; left out
 * where it is not wired (the tests of other routes), so a route answers a refusal without it
 */
export interface AttentionApi {
  /** The bell's list, less what the owner dismissed */
  list(): Promise<Attention>;
  /** Hides these lines, on every device, until their condition changes */
  dismiss(keys: readonly string[]): Promise<{ dismissed: number }>;
}

/** More than the bell ever lists at once; a longer list is not a click on it */
export const MAX_ATTENTION_KEYS = 100;

/** The keys of a dismissal, the page's and the API's alike: each one shaped like a line of the bell */
export function attentionKeysInput(input: unknown): { keys: string[] } {
  const keys = list(object(input, 'input').keys, 'keys');
  if (keys.length === 0 || keys.length > MAX_ATTENTION_KEYS) throw new InvalidInput(`keys must hold 1 to ${MAX_ATTENTION_KEYS} keys`);
  for (const key of keys) if (!ATTENTION_KEY.test(key)) throw new InvalidInput(`${key} is not a line of the bell`);
  return { keys };
}

/** The app's page a line links to, as a path: the target is typed for the app's router, which a client has not got */
function pathOf(target: AttentionTarget): string {
  switch (target.to) {
    case '/launches/$id':
      return `/launches/${encodeURIComponent(target.params.id)}`;
    case '/comments':
      return `/comments?state=${target.search.state}`;
    case '/channels':
      return `/channels?focus=${encodeURIComponent(target.search.focus)}`;
    case '/settings':
      return '/settings';
  }
}

/** A line as a client gets it: the ids it names, to call the tools that act on them, and the app's link instead of the router's target */
function apiItem({ target, ...item }: AttentionItem, publicUrl: string) {
  const launchId = target.to === '/launches/$id' ? Number(target.params.id) : undefined;
  const accountId = target.to === '/channels' ? Number(target.search.focus) : undefined;
  return {
    ...item,
    ...(launchId !== undefined && Number.isInteger(launchId) && { launchId }),
    ...(accountId !== undefined && Number.isInteger(accountId) && { accountId }),
    url: `${publicUrl.replace(/\/+$/, '')}${pathOf(target)}`,
  };
}

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });
const unavailable = () => failure(409, 'refused', 'the attention list is not available in this process');

async function readJson(request: Request): Promise<unknown> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new InvalidInput('send JSON, with content-type: application/json');
  const text = await request.text();
  // A hundred keys of at most 130 characters each, with room to spare
  if (text.length > 50_000) throw new InvalidInput('the body is too large');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const ATTENTION_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/attention',
    scope: 'read',
    operationId: 'listAttention',
    summary: 'What needs the owner, as the app’s bell lists it: launches to approve or retry, comments waiting, accounts to reconnect, permissions, posts going out soon; less what was dismissed',
    response: {
      status: 200,
      description: 'The lines and how many need the owner (the `scheduled` ones only inform and are not counted)',
      schema: { type: 'object', required: ['count', 'items'], properties: { count: { type: 'integer' }, items: { type: 'array', items: ref('AttentionItem') } } },
    },
    async handle(deps) {
      if (!deps.attention) return unavailable();
      const { count, items } = await deps.attention.list();
      return answer(200, { count, items: items.map((i) => apiItem(i, deps.publicUrl)) });
    },
  },
  {
    method: 'POST',
    path: '/attention/dismiss',
    scope: 'write',
    operationId: 'dismissAttention',
    summary:
      'Hide lines of the bell, on every device, until their condition changes (a new failure, another problem, a new comment makes a new line). Only Shipcast’s list changes: nothing is fixed, retried or answered. “Clear all” is every key the caller read',
    body: {
      type: 'object',
      required: ['keys'],
      properties: { keys: { type: 'array', minItems: 1, maxItems: MAX_ATTENTION_KEYS, items: { type: 'string', maxLength: 200 }, description: 'The `key` of each line, as GET /attention gives it' } },
    },
    response: { status: 200, description: 'How many lines were dismissed', schema: { type: 'object', required: ['dismissed'], properties: { dismissed: { type: 'integer' } } } },
    async handle(deps, { request }) {
      const { keys } = attentionKeysInput(await readJson(request));
      if (!deps.attention) return unavailable();
      return answer(200, await deps.attention.dismiss(keys));
    },
  },
];

/** The components the attention routes' responses name, merged into the OpenAPI document's */
export const ATTENTION_SCHEMAS: Record<string, JsonSchema> = {
  AttentionItem: {
    type: 'object',
    required: ['key', 'kind', 'text', 'action', 'url'],
    properties: {
      key: { type: 'string', description: 'Names the condition, its state included: what POST /attention/dismiss takes' },
      kind: {
        type: 'string',
        enum: ['approve', 'retry', 'reply', 'reconnect', 'permission', 'scheduled', 'canonical', 'drift'],
        description:
          '`approve` a drafted launch waits for its drafts’ approval; `retry` a launch failed, on some channels or (with `nothingOut`) before anything went out; `reply` comments wait for a reply; `reconnect` an account’s credential stopped working; `permission` a source of numbers is refused (the GitHub App lacks a permission); `scheduled` posts go out within a day (informs only); `canonical` Google files an article page under another URL; `drift` Shipcast’s copy of a launch differs from its pull request',
      },
      text: { type: 'string', description: 'What is the matter, in a short line' },
      action: { type: 'string', description: 'What the owner does about it, as the app’s link says' },
      url: { type: 'string', description: 'The app’s page for it' },
      launchId: { type: 'integer', description: 'The launch the line is about' },
      accountId: { type: 'integer', description: 'The account the line is about' },
      count: { type: 'integer', description: 'How many things the line stands for (the waiting comments)' },
      subject: { type: 'string' },
      channel: { type: 'string', description: 'The network of an account to reconnect' },
      nothingOut: { type: 'boolean', description: 'A failed launch nothing of which went out' },
    },
  },
};
