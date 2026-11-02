/*
 * The browser's half of web push (docs/push.md): whether this browser can take notifications, its
 * subscription, and the label its row is shown under. The permission is asked only from the toggle's
 * click, never on a page load.
 */

export type PushSupport =
  /** Ready: a service worker and the Push API */
  | 'ok'
  /** No Push API at all */
  | 'unsupported'
  /** iPhone or iPad in Safari's tab: push reaches only the app added to the Home Screen (iOS 16.4+) */
  | 'install-first'
  /** A development server, which has no service worker */
  | 'no-worker';

interface Environment {
  userAgent: string;
  /** Whether the page runs as the installed app */
  standalone: boolean;
  hasPush: boolean;
  hasWorker: boolean;
  dev: boolean;
}

const isIos = (userAgent: string) => /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile\//.test(userAgent));

/** What this browser can do, from what it says of itself; pure so the rule is tested */
export function pushSupport(env: Environment): PushSupport {
  if (env.dev) return 'no-worker';
  if (isIos(env.userAgent) && !env.standalone) return 'install-first';
  if (!env.hasWorker || !env.hasPush) return 'unsupported';
  return 'ok';
}

/** "Safari on iPhone", "Chrome on Android", "Firefox on Linux": enough to tell the owner's devices apart */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(userAgent)
      ? 'Firefox'
      : /SamsungBrowser/.test(userAgent)
        ? 'Samsung Internet'
        : /Chrome\/|CriOS/.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'A browser';
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && /Mobile\//.test(userAgent))
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /CrOS/.test(userAgent)
              ? 'ChromeOS'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : 'a device';
  return `${browser} on ${device}`;
}

/** The VAPID public key as the bytes PushManager.subscribe takes */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** The endpoint's fingerprint, as the server computes it (push.server.ts) */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return [...digest]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}

export function browserSupport(): PushSupport {
  return pushSupport({
    userAgent: navigator.userAgent,
    standalone: window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true,
    hasPush: 'PushManager' in window && 'Notification' in window,
    hasWorker: 'serviceWorker' in navigator,
    dev: import.meta.env.DEV,
  });
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Registered by the shell (PwaUpdates); ready waits for it to be active
  return navigator.serviceWorker.ready;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const found = await navigator.serviceWorker.getRegistration('/');
  return found ? found.pushManager.getSubscription() : null;
}

/**
 * Asks the permission (this is the toggle's click) and subscribes with the server's key. A
 * subscription made with another key (the server's keys changed) is dropped and made again.
 */
export async function subscribe(publicKey: string): Promise<PushSubscription | 'denied'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await registration();
  const key = keyBytes(publicKey);
  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    const current = existing.options.applicationServerKey;
    const same = current !== null && current.byteLength === key.byteLength && new Uint8Array(current).every((b, i) => b === key[i]);
    if (same) return existing;
    await existing.unsubscribe();
  }
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

/** The subscription's JSON, the shape the server keeps */
export function subscriptionJson(subscription: PushSubscription): { endpoint: string; keys: { p256dh: string; auth: string } } {
  const json = subscription.toJSON();
  return { endpoint: json.endpoint ?? subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } };
}
