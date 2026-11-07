---
created_at: 2026-11-02T23:16:33.73785897Z
updated_at: 2026-11-02T23:16:33.73785897Z
tags:
    - push
    - notifications
    - web-app
    - jobs
    - secrets
---
# Web push notifications

Built on 2026-11-03 for v0.3.0 (SHP-28), beside the installable app
([decisions/pwa.md](decisions/pwa.md)). Shipcast tells the owner's devices, by web push, when
something needs them or a launch is out, as the Telegram notices already do, but on the phone's lock
screen and opening the right page.

## The events

| Kind | When | Says | Opens |
| --- | --- | --- | --- |
| `comments` | A comments run drafted replies that wait for approval | "3 replies wait for your approval." | `/comments` |
| `approval` | A launch or an article is drafted and its drafts wait for the owner | "claudio v0.9.0 is drafted and waits for your approval." | the launch |
| `failed` | Drafting failed, or a piece failed for good (no retry follows) | "claudio v0.9.0 failed on bluesky, devto." | the launch |
| `published` | Every channel of a launch is out | "claudio v0.9.0 is out on every channel." | the launch |

They are raised where the jobs already tell the owner (`packages/runtime/src/work.ts`): the `draft`
and `article` jobs (their failure, or drafts left waiting by `publishWhatIsReady`), the `publish` job
(`publishEvent`: a launch out on every channel, or failures with no retry left, the same rule as the
Telegram notice) and the `comments` job (replies `draft-ready`). A publish run that only waits for
another attempt says nothing.

**No private text, ever.** A notification is read on a lock screen. Its words are Shipcast's own
(`pushPayload`, `packages/runtime/src/push/events.ts`): a release's repo and tag, a count, channel ids.
Never a comment, a draft, a problem's message, nor an article's title or slug: an article is "Your
article". The payload is `{ title, body, url, tag }`, `url` a path of the app; the worker shows it and
a tap focuses the app's window on that page, or opens one (`src/pwa/sw.ts`, `notification.ts`, which
refuses any address that would leave the app). The tag makes a launch's newer notification replace its
older one.

## Sending

Each event becomes one `push` job per device that wants it (`queuePush`, `push/send.ts`), on the
`worker` role. The job reads the device again (one that left or turned the kind off is not told),
encrypts the payload for it and hands it to the browser's push service with the `web-push` library,
signed with the VAPID keys:

- **201**: sent; the device's `last_success_at` is set.
- **404 or 410**: the browser dropped the subscription, so its row is deleted.
- **No answer, 408, 429 or 5xx**: recorded on the device and retried by the queue, 4 more times a
  minute apart.
- **Any other refusal**: recorded on the device (`last_failure`), not retried.

A launch's news lives a day at the push service (TTL), a test five minutes; a failure is sent with high
urgency. The `Topic` header, which makes the push service keep only a tag's newest message while the
device is away, is made from the tag (`pushTopic`): its SHA-256 in base64url cut to 32 characters.
RFC 8030 allows at most 32 characters of that alphabet, and Apple's service refuses a topic that is not
whole Base64 (`400 BadWebPushTopic` for a raw `launch-16`), so the tag itself is never sent as it. Queueing never fails the work it tells of. Without the keys nothing is queued.

## The subscriptions

Migration `0023_push_subscriptions` creates `push_subscriptions`: `id`, `login` (who turned it on),
`endpoint` (unique), `p256dh`, `auth`, `label` ("Safari on iPhone"), `events` (jsonb, kind to on/off;
a kind left out is on), `created_at`, `last_success_at`, `last_failure_at`, `last_failure`.
`PushSubscriptionRepository` (`packages/engine/src/repositories/push-subscriptions.ts`) keeps them; a
browser subscribing again with the same endpoint updates its row and keeps its choices. The endpoint
and keys reach the device and are never sent to a page or an API client: the page tells which device
is itself by the endpoint's SHA-256.

## Settings → Notifications

`/settings/notifications`, a fifth Settings section:

- **This device**: a switch. Turning it on asks the browser for the permission (only on that click),
  subscribes with the server's public key and keeps the subscription; turning it off unsubscribes and
  forgets it. The page says why it cannot: push not configured on the server, a browser without push,
  notifications blocked for the site, or an iPhone in Safari's tab.
- **Tell this device about**: one switch per kind.
- **Send a test notification**: "Notifications work on this device." to this device.
- **Other devices**: each with its last success or failure, and Remove.
- The help says that on iPhone and iPad only Shipcast added to the Home Screen gets notifications, on
  iOS 16.4 or later.

The page's server functions are in `src/server/push.functions.ts`, over the same service as the API
(`push.server.ts`).

## API and MCP

| Route | Scope | MCP tool |
| --- | --- | --- |
| `GET /notifications` | read | `list_notification_devices` |
| `PATCH /notifications/devices/{deviceId}` `{ events }` | write | `set_notification_events` |
| `DELETE /notifications/devices/{deviceId}` | write | `delete_notification_device` |
| `POST /notifications/test` `{ deviceId? }` | write | `send_test_notification` |

Turning a device on (`subscribePush`) is the app's alone, written as such in the parity map
(`apps/web/test/app-parity.ts`): the subscription is made by that browser's service worker and push
service, which no API client has, and it is a credential to reach the device
([decisions/mcp-parity.md](decisions/mcp-parity.md)).

## The keys

Web push is signed with a VAPID key pair (RFC 8292), read from the environment like the app's other
server secrets (`pushSetup`, `push/config.ts`):

| Variable | Holds |
| --- | --- |
| `SHIPCAST_VAPID_PUBLIC_KEY` | The public key, base64url (65 bytes). Browsers subscribe with it |
| `SHIPCAST_VAPID_PRIVATE_KEY` | The private key, base64url (32 bytes). A secret |
| `SHIPCAST_VAPID_SUBJECT` | Optional: a `mailto:` or `https:` contact for the push services; `SHIPCAST_PUBLIC_URL` when unset |

A new pair:

```bash
pnpm --filter @shipcast/runtime exec web-push generate-vapid-keys
```

Without the keys push is **not configured**: Settings says so, the switch is off, nothing is queued,
and nothing else changes. Keys set but wrong (one missing, not a P-256 key, a bad subject) are
reported the same way and never stop a start. Changing the pair means every device turns
notifications on again, since its subscription was made with the old public key (the page then
subscribes again with the new one).

**Production** reads them from the server's environment, beside `SHIPCAST_SECRETS_KEY`. The stack is
in yeyo11/infra (`stacks/shipcast`); what it needs, not yet done there: the three variables in the
stack's secret environment, given to **`web`** (it shows the public key and refuses a test without
them), **`worker`** (it sends) and **`heavy`** (its `draft`, `article` and `comments` jobs queue the
events and skip them without keys). Nothing else changes: the app reaches the push services over
outbound HTTPS (Google's `fcm.googleapis.com`, Mozilla's `updates.push.services.mozilla.com`, Apple's
`web.push.apple.com`), and the browsers reach the app as before, over the tailnet.

## Tests

`packages/runtime/test/push.test.ts`: each event's payload and that no private text reaches it, which
runs make which events, the preference filter, the configuration, a delivery's outcome per status
(404 and 410 delete the device), the queueing and the `push` job, all over a fake transport.
`packages/engine/test/push-subscriptions.test.ts`: the repository. `apps/web/test/push-api.test.ts`:
the routes. `apps/web/test/pwa.test.ts`: the worker's notification and tap rule.
`packages/mcp/test/tools-notifications.test.ts`: the tools. No test reaches a push service.

## Related

[[decisions/pwa.md]] · [[web-app.md]] · [[server.md]] · [[api.md]] · [[mcp.md]] · [[decisions/mcp-parity.md]] · [[decisions/job-queue.md]] · [[decisions/comment-assistant.md]] · [[app-review.md]]
