import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { appContext } from './context.server';
import { id, object, text } from './input';
import { eventsInput, subscribeInput, testInput } from './push-api';
import { pushApi } from './push.server';
import { cookieOf, readSession, SESSION_COOKIE } from './session.server';

/* Settings → Notifications, through the same service as the /notifications routes (push-api.ts; docs/push.md) */

/** Whether push is configured, the kinds of event, and the devices that take notifications */
export const getNotifications = createServerFn({ method: 'GET' }).handler(async () => pushApi(await appContext()).state());

/** This browser turned notifications on: its subscription kept under the signed-in login */
export const subscribePush = createServerFn({ method: 'POST' })
  .validator(subscribeInput)
  .handler(async ({ data }) => {
    const ctx = await appContext();
    const session = await readSession(ctx.secrets, cookieOf(getRequest(), SESSION_COOKIE));
    return pushApi(ctx).subscribe(data, session?.login ?? 'owner');
  });

/** A device turned off: by its id from the list, or by its endpoint from the browser turning itself off */
export const removePushDevice = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const body = object(input, 'input');
    return body.endpoint !== undefined ? { endpoint: text(body.endpoint, 'endpoint', 1000), deviceId: undefined } : { endpoint: undefined, deviceId: id(body.deviceId, 'deviceId') };
  })
  .handler(async ({ data }) => {
    const push = pushApi(await appContext());
    return { removed: data.endpoint !== undefined ? await push.removeEndpoint(data.endpoint) : await push.remove(data.deviceId ?? 0) };
  });

/** What one device is told */
export const savePushEvents = createServerFn({ method: 'POST' })
  .validator((input: unknown) => ({ deviceId: id(object(input, 'input').deviceId, 'deviceId'), events: eventsInput(input) }))
  .handler(async ({ data }) => {
    const device = await pushApi(await appContext()).setEvents(data.deviceId, data.events);
    if (!device) throw new Error('This device no longer takes notifications: turn them on again');
    return device;
  });

/** "Send a test notification", to this device */
export const sendTestPush = createServerFn({ method: 'POST' })
  .validator(testInput)
  .handler(async ({ data }) => pushApi(await appContext()).test(data.deviceId === undefined ? undefined : [data.deviceId]));
