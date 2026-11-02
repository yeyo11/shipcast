import type { ApiRoute } from './api.ts';
import { id, InvalidInput, object, text } from './input.ts';

/*
 * The notification routes of the REST API (docs/push.md): the devices that take web push, what each
 * is told, removing one, and a test notification (the pages' getNotifications, savePushEvents,
 * removePushDevice and sendTestPush, push.functions.ts). Turning a device on is the page's alone: a
 * subscription is made by a browser's service worker, which no API client has.
 *
 * Kept apart from api.ts, which spreads them into its routes and its OpenAPI document; only types come
 * back from api.ts. A route and the server function it mirrors call the same service (push.server.ts).
 */

type JsonSchema = Record<string, unknown>;

/** The kinds of event a device can be told of (the runtime's PUSH_EVENT_KINDS), which this module states for its schema */
export const EVENT_KINDS = ['comments', 'approval', 'failed', 'published'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** A device as the page and the API see it: never its endpoint or keys, which reach the device */
export interface PushDeviceView {
  id: number;
  label: string;
  login: string;
  events: Record<EventKind, boolean>;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
  /** The endpoint's SHA-256, cut short: how a browser tells which device is itself without the server sending it */
  endpointHash: string;
}

export interface PushState {
  /** Whether the VAPID keys are set; without them nothing is sent and a browser cannot subscribe */
  configured: boolean;
  /** Why push is not configured, when keys are set but wrong */
  problem?: string;
  /** What a browser subscribes with; only when configured */
  publicKey?: string;
  events: Array<{ kind: EventKind; label: string; help: string }>;
  devices: PushDeviceView[];
}

/** A browser's subscription as PushSubscription.toJSON() gives it, and the label it is shown under */
export interface PushSubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
}

/** What the routes and the page run in the app's process, built by pushApi in push.server.ts */
export interface PushApi {
  state(): Promise<PushState>;
  subscribe(input: PushSubscribeInput, login: string): Promise<PushDeviceView>;
  setEvents(deviceId: number, events: Partial<Record<EventKind, boolean>>): Promise<PushDeviceView | undefined>;
  remove(deviceId: number): Promise<boolean>;
  /** Forgets the device behind an endpoint, as the browser turning itself off knows it */
  removeEndpoint(endpoint: string): Promise<boolean>;
  /** Queues a test notification to these devices, or every one; how many were queued, or why none */
  test(deviceIds?: readonly number[]): Promise<{ ok: true; queued: number } | { ok: false; problem: string }>;
}

const KEY = /^[A-Za-z0-9_-]{1,200}=*$/;

/** A subscription's shape, checked before anything is stored: an https endpoint and two base64url keys */
export function subscribeInput(input: unknown): PushSubscribeInput {
  const body = object(input, 'input');
  const endpoint = text(body.endpoint, 'endpoint', 1000);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InvalidInput('endpoint must be the push service’s https address');
  }
  if (url.protocol !== 'https:') throw new InvalidInput('endpoint must be the push service’s https address');
  const keys = object(body.keys, 'keys');
  const p256dh = text(keys.p256dh, 'keys.p256dh', 200);
  const auth = text(keys.auth, 'keys.auth', 200);
  if (!KEY.test(p256dh) || !KEY.test(auth)) throw new InvalidInput('keys must be base64url');
  const label = text(body.label ?? 'This browser', 'label', 100).trim() || 'This browser';
  return { endpoint, keys: { p256dh, auth }, label };
}

/** The events a device changes: a few of the kinds, each on or off */
export function eventsInput(input: unknown): Partial<Record<EventKind, boolean>> {
  const events = object(object(input, 'input').events, 'events');
  const out: Partial<Record<EventKind, boolean>> = {};
  for (const [kind, on] of Object.entries(events)) {
    if (!(EVENT_KINDS as readonly string[]).includes(kind)) throw new InvalidInput(`${kind} is not a kind of notification (${EVENT_KINDS.join(', ')})`);
    if (typeof on !== 'boolean') throw new InvalidInput(`events.${kind} must be true or false`);
    out[kind as EventKind] = on;
  }
  if (Object.keys(out).length === 0) throw new InvalidInput('events must name at least one kind');
  return out;
}

/** The device a test goes to, or every device */
export function testInput(input: unknown): { deviceId?: number } {
  if (input === undefined || input === null) return {};
  const deviceId = object(input, 'input').deviceId;
  return deviceId === undefined ? {} : { deviceId: id(deviceId, 'deviceId') };
}

const deviceIdOf = (value: string | undefined) => id(/^\d{1,10}$/.test(value ?? '') ? Number(value) : NaN, 'the device id');

const answer = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status: number, code: string, message: string) => answer(status, { error: { code, message } });
const unavailable = () => failure(409, 'refused', 'notifications are not available in this process');
const missing = () => failure(404, 'not_found', 'no such device: it was removed, or never turned notifications on');

async function readJson(request: Request, optional: boolean): Promise<unknown> {
  const body = await request.text();
  if (body.trim() === '' && optional) return undefined;
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) throw new InvalidInput('send JSON, with content-type: application/json');
  if (body.length > 10_000) throw new InvalidInput('the body is too large');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new InvalidInput('the body is not valid JSON');
  }
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const eventsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: Object.fromEntries(EVENT_KINDS.map((kind) => [kind, { type: 'boolean' }])),
  description: '`comments`: replies drafted for new comments wait for approval; `approval`: a launch’s drafts wait for review; `failed`: a launch could not be drafted, or a piece failed to go out; `published`: every channel of a launch is out',
};

export const PUSH_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/notifications',
    scope: 'read',
    operationId: 'listNotificationDevices',
    summary: 'The devices that take Shipcast’s web push notifications, what each is told, and whether push is configured on this instance',
    response: { status: 200, description: 'Whether push is configured, the kinds of event, and the devices', schema: ref('NotificationState') },
    async handle(deps) {
      if (!deps.push) return unavailable();
      const { publicKey: _publicKey, ...state } = await deps.push.state();
      return answer(200, state);
    },
  },
  {
    method: 'PATCH',
    path: '/notifications/devices/{deviceId}',
    scope: 'write',
    operationId: 'setNotificationEvents',
    summary: 'Choose what one device is told: each kind of event on or off; the kinds left out keep their choice',
    body: { type: 'object', required: ['events'], properties: { events: eventsSchema } },
    response: { status: 200, description: 'The device with its choices', schema: { type: 'object', required: ['device'], properties: { device: ref('NotificationDevice') } } },
    async handle(deps, { params, request }) {
      const deviceId = deviceIdOf(params.deviceId);
      const events = eventsInput(await readJson(request, false));
      if (!deps.push) return unavailable();
      const device = await deps.push.setEvents(deviceId, events);
      return device ? answer(200, { device }) : missing();
    },
  },
  {
    method: 'DELETE',
    path: '/notifications/devices/{deviceId}',
    scope: 'write',
    operationId: 'deleteNotificationDevice',
    summary: 'Stop notifying a device: its subscription is forgotten. The browser still shows notifications as on until it is turned off there too; it is told nothing more',
    response: { status: 200, description: 'The device was removed', schema: { type: 'object', required: ['removed'], properties: { removed: { type: 'boolean' } } } },
    async handle(deps, { params }) {
      const deviceId = deviceIdOf(params.deviceId);
      if (!deps.push) return unavailable();
      return (await deps.push.remove(deviceId)) ? answer(200, { removed: true }) : missing();
    },
  },
  {
    method: 'POST',
    path: '/notifications/test',
    scope: 'write',
    operationId: 'sendTestNotification',
    summary: 'Send a test notification to one device, or to every device, whatever each chose; it is queued and goes out within seconds',
    body: { type: 'object', properties: { deviceId: { type: 'integer', minimum: 1, description: 'The device; every device when left out' } } },
    bodyOptional: true,
    response: { status: 202, description: 'How many notifications were queued', schema: { type: 'object', required: ['queued'], properties: { queued: { type: 'integer' } } } },
    async handle(deps, { request }) {
      const { deviceId } = testInput(await readJson(request, true));
      if (!deps.push) return unavailable();
      const sent = await deps.push.test(deviceId === undefined ? undefined : [deviceId]);
      return sent.ok ? answer(202, { queued: sent.queued }) : failure(409, 'refused', sent.problem);
    },
  },
];

/** The components the notification routes' responses name, merged into the OpenAPI document's */
export const PUSH_SCHEMAS: Record<string, JsonSchema> = {
  NotificationDevice: {
    type: 'object',
    required: ['id', 'label', 'login', 'events', 'createdAt', 'endpointHash'],
    properties: {
      id: { type: 'integer' },
      label: { type: 'string', description: 'The browser and device, such as "Safari on iPhone"' },
      login: { type: 'string', description: 'Who turned notifications on there' },
      events: eventsSchema,
      createdAt: { type: 'string', format: 'date-time' },
      lastSuccessAt: { type: ['string', 'null'], format: 'date-time' },
      lastFailureAt: { type: ['string', 'null'], format: 'date-time' },
      lastFailure: { type: ['string', 'null'], description: 'The push service’s answer to the last failed send' },
      endpointHash: { type: 'string' },
    },
  },
  NotificationState: {
    type: 'object',
    required: ['configured', 'events', 'devices'],
    properties: {
      configured: { type: 'boolean', description: 'Whether the instance has its VAPID keys; without them nothing is sent' },
      problem: { type: 'string', description: 'Why push is not configured, when its keys are set but wrong' },
      events: { type: 'array', items: { type: 'object', required: ['kind', 'label', 'help'], properties: { kind: { type: 'string', enum: [...EVENT_KINDS] }, label: { type: 'string' }, help: { type: 'string' } } } },
      devices: { type: 'array', items: ref('NotificationDevice') },
    },
  },
};
