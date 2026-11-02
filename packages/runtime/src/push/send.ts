import type { PushSubscriptionRow, Repositories } from '@shipcast/engine';
import webpush from 'web-push';
import type { JobQueue } from '../queue.ts';
import { pushSetup, type PushConfig } from './config.ts';
import { pushPayload, wantsEvent, type PushEvent } from './events.ts';

/*
 * Sending web push (docs/push.md). An event becomes one `push` job per device that wants it, worked
 * by the worker role: the job encrypts the payload for that browser and hands it to its push service
 * (Google's, Mozilla's, Apple's), which delivers it when the device is reachable. A 404 or 410 means
 * the browser dropped the subscription, so its row goes; a throttled or failing push service is tried
 * again by the queue; any other refusal is recorded on the row and not retried.
 */

/** What reaching one push service takes; web-push's in the app, a fake in the tests */
export interface PushTransport {
  /** Answers the push service's status; throws PushServiceError when it refused */
  send(subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { ttlSeconds: number; urgency: 'normal' | 'high'; topic: string }): Promise<{ statusCode: number }>;
}

/** A push service's refusal, with its status (0 when it never answered) */
export class PushServiceError extends Error {
  override name = 'PushServiceError';
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Thrown for a failure worth another attempt: the queue retries the job */
export class PushRetry extends Error {
  override name = 'PushRetry';
}

/** The transport over the web-push library, signing each request with the VAPID key pair */
export function webPushTransport(config: PushConfig, timeoutMs = 15_000): PushTransport {
  return {
    async send(subscription, payload, options) {
      try {
        const answer = await webpush.sendNotification(subscription, payload, {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: options.ttlSeconds,
          urgency: options.urgency,
          topic: options.topic,
          timeout: timeoutMs,
        });
        return { statusCode: answer.statusCode };
      } catch (error) {
        if (error instanceof webpush.WebPushError) throw new PushServiceError(error.statusCode, `${error.statusCode} ${String(error.body ?? '').slice(0, 120)}`.trim());
        throw new PushServiceError(0, error instanceof Error ? error.message : String(error));
      }
    },
  };
}

/** How the push service's answer is handled: the subscription is gone, worth retrying, or refused for good */
export function pushFailureKind(statusCode: number): 'gone' | 'retry' | 'refused' {
  if (statusCode === 404 || statusCode === 410) return 'gone';
  // No answer at all (a timeout, DNS), throttled, or the service's own failure
  if (statusCode === 0 || statusCode === 408 || statusCode === 429 || statusCode >= 500) return 'retry';
  return 'refused';
}

export type PushDelivery = 'sent' | 'gone' | 'refused' | 'unwanted' | 'missing';

/** A launch's news keeps a day at the push service; a test is only worth seeing now */
const ttlOf = (event: PushEvent) => (event.kind === 'test' ? 5 * 60 : 24 * 3600);

/**
 * Sends one event to one device. The row is read again, so a device that left or changed its mind
 * since the job was queued is not told. Throws PushRetry when another attempt may succeed.
 */
export async function deliverPush(registry: Pick<Repositories, 'pushSubscriptions'>, transport: PushTransport, subscriptionId: number, event: PushEvent, now = () => new Date()): Promise<PushDelivery> {
  const row = await registry.pushSubscriptions.subscription(subscriptionId);
  if (!row) return 'missing';
  if (!wantsEvent(row.events, event)) return 'unwanted';
  const payload = pushPayload(event);
  try {
    await transport.send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify(payload), {
      ttlSeconds: ttlOf(event),
      urgency: event.kind === 'failed' ? 'high' : 'normal',
      topic: payload.tag,
    });
  } catch (error) {
    const status = error instanceof PushServiceError ? error.statusCode : 0;
    const message = error instanceof Error ? error.message : String(error);
    const kind = pushFailureKind(status);
    if (kind === 'gone') {
      await registry.pushSubscriptions.remove(row.id);
      return 'gone';
    }
    await registry.pushSubscriptions.recordFailure(row.id, message, now());
    if (kind === 'retry') throw new PushRetry(`the push service did not take it: ${message}`);
    return 'refused';
  }
  await registry.pushSubscriptions.recordSuccess(row.id, now());
  return 'sent';
}

export interface QueuePushDeps {
  queue: Pick<JobQueue, 'send'>;
  registry: Pick<Repositories, 'pushSubscriptions'>;
  env: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

/** The devices an event goes to: those that want it, or for a test, those asked for */
export function pushRecipients(rows: readonly PushSubscriptionRow[], event: PushEvent, only?: readonly number[]): PushSubscriptionRow[] {
  return rows.filter((row) => (only === undefined || only.includes(row.id)) && wantsEvent(row.events, event));
}

/**
 * Queues an event for every device that wants it, a job each. Nothing when push is not configured.
 * Never throws: a notification that cannot be queued never fails the work it tells of. Answers how
 * many jobs were queued.
 */
export async function queuePush(deps: QueuePushDeps, event: PushEvent, only?: readonly number[]): Promise<number> {
  try {
    if (pushSetup(deps.env).state !== 'ready') return 0;
    const rows = pushRecipients(await deps.registry.pushSubscriptions.subscriptions(), event, only);
    const what = event.kind === 'test' ? 'A test notification' : `“${pushPayload(event).title}”`;
    let queued = 0;
    for (const row of rows) if (await deps.queue.send('push', { subscriptionId: row.id, event }, { title: `${what} to ${row.label}` })) queued += 1;
    return queued;
  } catch (error) {
    deps.log?.(`The notification was not queued: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
