/*
 * Shipcast's service worker (docs/decisions/pwa.md), bundled to /sw.js by the PWA plugin
 * (apps/web/pwa-plugin.ts), which fills in the build's version and the files to precache.
 *
 * - Install: the build's public files are precached (the hashed assets, the fonts, tokens, logo and
 *   icons, the offline page). A new worker then waits: the page offers "New version available" and
 *   only the owner's Reload swaps it in, never a swap in the middle of an edit.
 * - Activate: every cache of another build is deleted.
 * - Fetch: rules.ts decides. Pages and everything behind the session go to the network and are never
 *   stored; a page that cannot be reached gets the offline page. The sign-out empties the runtime cache.
 * - Push: the payload is shown as a notification; a tap focuses the app on the page it names.
 */
import { appPath, notificationOf } from './notification.ts';
import { cacheable, isSignOut, swStrategy } from './rules.ts';

declare const __SW_VERSION__: string;
declare const __SW_PRECACHE__: string[];

/* The few worker types this file uses; the app's tsconfig has the DOM's, not the WebWorker library */
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface PushEvent extends ExtendableEvent {
  readonly data: { json(): unknown; text(): string } | null;
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification & { data?: { url?: string } };
}
interface ExtendableMessageEvent extends ExtendableEvent {
  readonly data: unknown;
}
interface WindowClient {
  readonly url: string;
  focus(): Promise<WindowClient>;
  navigate(url: string): Promise<WindowClient | null>;
}
interface WorkerScope {
  readonly location: Location;
  readonly registration: ServiceWorkerRegistration;
  readonly clients: { matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<WindowClient[]>; openWindow(url: string): Promise<WindowClient | null> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  addEventListener(type: 'push', listener: (event: PushEvent) => void): void;
  addEventListener(type: 'notificationclick', listener: (event: NotificationEvent) => void): void;
  addEventListener(type: 'message', listener: (event: ExtendableMessageEvent) => void): void;
}

const worker = self as unknown as WorkerScope;
const ORIGIN = worker.location.origin;
const PREFIX = 'shipcast-';
const PRECACHE = `${PREFIX}precache-${__SW_VERSION__}`;
/** Public files refreshed while in use; emptied on sign-out and on every new build */
const RUNTIME = `${PREFIX}runtime-${__SW_VERSION__}`;
const OFFLINE = '/offline.html';

worker.addEventListener('install', (event) => {
  // `reload`: from the network, never an old copy from the browser's HTTP cache under the new version's name
  event.waitUntil(caches.open(PRECACHE).then((cache) => cache.addAll(__SW_PRECACHE__.map((path) => new Request(path, { cache: 'reload' })))));
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== PRECACHE && name !== RUNTIME) await caches.delete(name);
    })(),
  );
});

worker.addEventListener('message', (event) => {
  const type = event.data && typeof event.data === 'object' ? (event.data as { type?: unknown }).type : undefined;
  // The owner chose Reload on "New version available"
  if (type === 'SKIP_WAITING') void worker.skipWaiting();
  if (type === 'CLEAR_RUNTIME') event.waitUntil(caches.delete(RUNTIME));
});

async function offline(): Promise<Response> {
  return (await caches.match(OFFLINE, { cacheName: PRECACHE })) ?? new Response("You're offline.", { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function navigate(event: FetchEvent): Promise<Response> {
  try {
    return await fetch(event.request);
  } catch {
    return offline();
  }
}

async function store(request: Request, response: Response): Promise<void> {
  if (cacheable(response)) await (await caches.open(RUNTIME)).put(request, response);
}

async function cacheFirst(event: FetchEvent): Promise<Response> {
  const kept = await caches.match(event.request, { ignoreVary: true });
  if (kept) return kept;
  const response = await fetch(event.request);
  event.waitUntil(store(event.request, response.clone()));
  return response;
}

async function staleWhileRevalidate(event: FetchEvent): Promise<Response> {
  const kept = (await (await caches.open(RUNTIME)).match(event.request)) ?? (await caches.match(event.request, { cacheName: PRECACHE }));
  const fresh = fetch(event.request).then(async (response) => {
    await store(event.request, response.clone());
    return response;
  });
  if (kept) {
    event.waitUntil(fresh.catch(() => undefined));
    return kept;
  }
  return fresh;
}

worker.addEventListener('fetch', (event) => {
  const { request } = event;
  if (isSignOut({ url: request.url, method: request.method, origin: ORIGIN })) event.waitUntil(caches.delete(RUNTIME));
  switch (swStrategy({ method: request.method, url: request.url, mode: request.mode, origin: ORIGIN })) {
    case 'navigate':
      return event.respondWith(navigate(event));
    case 'cache-first':
      return event.respondWith(cacheFirst(event));
    case 'stale-while-revalidate':
      return event.respondWith(staleWhileRevalidate(event));
    // network-only and pass: no answer from here, so the browser goes to the network as if there were no worker
    default:
      return undefined;
  }
});

worker.addEventListener('push', (event) => {
  let data: unknown;
  try {
    data = event.data?.json();
  } catch {
    data = undefined;
  }
  const shown = notificationOf(data);
  event.waitUntil(worker.registration.showNotification(shown.title, { body: shown.body, tag: shown.tag, icon: '/pwa/icon-192.png', badge: '/pwa/maskable-192.png', data: { url: shown.url } }));
});

worker.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(appPath(event.notification.data?.url), ORIGIN).href;
  event.waitUntil(
    (async () => {
      const windows = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // The app already open: brought forward and taken to the page; otherwise a new window on it
      const open = windows.find((client) => new URL(client.url).origin === ORIGIN);
      if (open) {
        const focused = await open.focus();
        if (focused.url !== target) await focused.navigate(target).catch(() => worker.clients.openWindow(target));
        return;
      }
      await worker.clients.openWindow(target);
    })(),
  );
});
