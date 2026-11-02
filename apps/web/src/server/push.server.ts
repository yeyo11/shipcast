import { createHash } from 'node:crypto';
import type { PushSubscriptionRow, Repositories } from '@shipcast/engine';
import { eventChoices, PUSH_EVENT_KINDS, PUSH_EVENT_LABELS, pushSetup, queuePush, type JobQueue } from '@shipcast/runtime';
import type { AppContext } from './context.server.ts';
import type { PushApi, PushDeviceView } from './push-api.ts';

/** The endpoint's fingerprint the page compares its own subscription with */
export const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('hex').slice(0, 24);

function view(row: PushSubscriptionRow): PushDeviceView {
  return {
    id: row.id,
    label: row.label,
    login: row.login,
    events: eventChoices(row.events),
    createdAt: row.createdAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    lastFailure: row.lastFailure,
    endpointHash: endpointHash(row.endpoint),
  };
}

export interface PushDeps {
  registry: Pick<Repositories, 'pushSubscriptions'>;
  queue: Pick<JobQueue, 'send'>;
  env: NodeJS.ProcessEnv;
}

/** The notification service the page and the REST API share (push-api.ts, push.functions.ts; docs/push.md) */
export function pushService(deps: PushDeps): PushApi {
  const subscriptions = deps.registry.pushSubscriptions;
  return {
    async state() {
      const setup = pushSetup(deps.env);
      return {
        configured: setup.state === 'ready',
        ...(setup.state === 'invalid' && { problem: setup.problem }),
        ...(setup.state === 'ready' && { publicKey: setup.config.publicKey }),
        events: PUSH_EVENT_KINDS.map((kind) => ({ kind, ...PUSH_EVENT_LABELS[kind] })),
        devices: (await subscriptions.subscriptions()).map(view),
      };
    },
    async subscribe(input, login) {
      return view(await subscriptions.subscribe({ login, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, label: input.label }));
    },
    async setEvents(deviceId, events) {
      const row = await subscriptions.setEvents(deviceId, events);
      return row && view(row);
    },
    remove: (deviceId) => subscriptions.remove(deviceId),
    removeEndpoint: (endpoint) => subscriptions.removeEndpoint(endpoint),
    async test(deviceIds) {
      const setup = pushSetup(deps.env);
      if (setup.state !== 'ready') return { ok: false, problem: setup.state === 'off' ? 'push is not configured on this instance: its VAPID keys are not set (docs/push.md)' : `push is not configured: ${setup.problem}` };
      const known = (await subscriptions.subscriptions()).map((r) => r.id);
      if (deviceIds?.some((id) => !known.includes(id))) return { ok: false, problem: 'no such device: it was removed, or never turned notifications on' };
      if (known.length === 0) return { ok: false, problem: 'no device takes notifications yet: turn them on in Settings → Notifications on the device' };
      return { ok: true, queued: await queuePush(deps, { kind: 'test' }, deviceIds) };
    },
  };
}

/** The service in the app's process, for the routes (api-deps.server.ts) and the page */
export const pushApi = (ctx: Pick<AppContext, 'registry' | 'queue'>): PushApi => pushService({ registry: ctx.registry, queue: ctx.queue, env: process.env });
