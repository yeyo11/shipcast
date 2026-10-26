/*
 * Where the owner goes back to after signing in again: the page they were on when the session ended.
 * Only a path of this app is ever followed, so a crafted link cannot send a fresh session elsewhere.
 */

/** On a 401 for a missing or ended session, so the app's pages tell it from any other refusal */
export const SESSION_HEADER = 'x-shipcast-session';

/** Paths that make no sense to come back to: signing in itself, and what is not a page */
const NOT_A_PAGE = /^\/(login|auth\/|api\/|mcp$|_serverFn)/;

export function safeNext(value: string | null | undefined): string | undefined {
  if (!value || value.length > 2048) return undefined;
  // `//host` and `/\host` are other sites to a browser, and control characters have no place in a path
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /[\u0000-\u001f]/.test(value)) return undefined;
  const base = 'http://shipcast.invalid';
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return undefined;
  }
  if (url.origin !== base || NOT_A_PAGE.test(url.pathname) || url.pathname === '/') return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in page's address, remembering where to come back to when there is somewhere */
export function loginPath(next: string | null | undefined): string {
  const safe = safeNext(next);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : '/login';
}
