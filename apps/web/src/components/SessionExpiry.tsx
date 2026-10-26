import { useEffect } from 'react';
import { loginPath, SESSION_HEADER } from '../server/next-path';

/** The app's own calls a session guards: server functions and pages, not the token-checked API or MCP */
const guarded = (url: URL) => url.origin === location.origin && !url.pathname.startsWith('/api/v1/') && url.pathname !== '/mcp';

/**
 * When the session ends while a page is open (it expired, it was signed out elsewhere, the key
 * changed), the next server call gets a 401 marked by the session middleware (start.ts). Instead of
 * an error toast, the owner is sent to sign in again and comes back to the same page afterwards.
 * Installed once, around the browser's fetch, which every server function goes through.
 */
export function SessionExpiry() {
  useEffect(() => {
    const original = window.fetch;
    let leaving = false;
    window.fetch = async (input, init) => {
      const response = await original(input, init);
      if (response.status === 401 && response.headers.get(SESSION_HEADER) === 'required' && !leaving) {
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (guarded(url)) {
          leaving = true;
          location.assign(loginPath(`${location.pathname}${location.search}${location.hash}`));
        }
      }
      return response;
    };
    return () => {
      window.fetch = original;
    };
  }, []);
  return null;
}
