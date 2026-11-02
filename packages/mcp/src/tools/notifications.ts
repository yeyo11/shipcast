import { z } from 'zod';
import { HINTS, tool, type ShipcastTool } from './shared.ts';

/* Web push: the devices that take Shipcast's notifications, what each is told, and a test */

export const guide =
  'Notifications: Shipcast tells the user\'s devices (phone, desktop browser) of comments waiting, drafts to review, failures and launches out, by web push. list_notification_devices shows the devices and their choices; set_notification_events changes what one is told; send_test_notification checks one works. A device is turned on only in the app, on that device.';

const deviceId = z.number().int().positive().describe('The device id, as list_notification_devices gives it');

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_notification_devices',
    title: 'List notification devices',
    description:
      'The devices that take Shipcast\'s web push notifications: each one\'s `id`, `label` (browser and device), who turned it on, `events` (which kinds it is told of: `comments`, `approval`, `failed`, `published`) and its last success or failure. `configured: false` means the instance has no VAPID keys, so nothing is sent; `problem` says what is wrong with them. A device is added only by turning notifications on in the app, on that device.',
    operations: ['listNotificationDevices'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/notifications'),
  }),
  tool({
    name: 'set_notification_events',
    title: 'Choose what a device is told',
    description:
      'Turn kinds of notification on or off for one device: `comments` (replies drafted for new comments wait for approval), `approval` (a launch\'s drafts wait for review), `failed` (a launch could not be drafted, or a piece failed to go out), `published` (every channel of a launch is out). The kinds left out keep their choice.',
    operations: ['setNotificationEvents'],
    input: z.object({
      deviceId,
      events: z
        .object({ comments: z.boolean().optional(), approval: z.boolean().optional(), failed: z.boolean().optional(), published: z.boolean().optional() })
        .refine((events) => Object.keys(events).length > 0, 'name at least one kind')
        .describe('Each kind to change, true to be told of it'),
    }),
    hints: HINTS.setting,
    run: (api, args) => api.call('PATCH', `/notifications/devices/${args.deviceId}`, { body: { events: args.events } }),
  }),
  tool({
    name: 'delete_notification_device',
    title: 'Stop notifying a device',
    description: 'Forget a device: it is told nothing more. Turning it on again takes the user, in the app, on that device; ask before removing one.',
    operations: ['deleteNotificationDevice'],
    input: z.object({ deviceId }),
    hints: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (api, args) => api.call('DELETE', `/notifications/devices/${args.deviceId}`),
  }),
  tool({
    name: 'send_test_notification',
    title: 'Send a test notification',
    description: 'Send "Notifications work on this device." to one device, or to every device when `deviceId` is left out, whatever each chose. It shows on the user\'s screen within seconds, so only send it when asked.',
    operations: ['sendTestNotification'],
    input: z.object({ deviceId: deviceId.optional() }),
    hints: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: (api, args) => api.call('POST', '/notifications/test', { body: args.deviceId === undefined ? {} : { deviceId: args.deviceId } }),
  }),
];
