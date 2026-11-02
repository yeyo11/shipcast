/*
 * What the service worker shows for a push (docs/push.md), and which page a tap on it opens. The
 * payload is the server's (the runtime's pushPayload): a title, a body, a path of the app and a tag.
 * Anything else, or a path that would leave the app, is ignored here, so a malformed push can at
 * worst show "Shipcast" and open the launches.
 */

export interface ShownNotification {
  title: string;
  body: string;
  tag: string;
  /** Where a tap goes: always a path of the app's own origin */
  url: string;
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.slice(0, max) : '');

/** A path of the app, or `/` */
export function appPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  try {
    // Resolved against a placeholder origin: a path that resolves elsewhere is refused
    const url = new URL(value, 'https://app.invalid');
    return url.origin === 'https://app.invalid' ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

export function notificationOf(data: unknown): ShownNotification {
  const payload = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return {
    title: text(payload.title, 80) || 'Shipcast',
    body: text(payload.body, 200),
    tag: text(payload.tag, 64) || 'shipcast',
    url: appPath(payload.url),
  };
}
