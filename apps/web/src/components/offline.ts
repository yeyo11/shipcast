/*
 * Telling a lost connection from a broken page: the first is said as "No connection" and retried
 * by itself once the browser is back online; only the second is an error.
 */

/** What a browser says when a request never reached the server, in Chrome's, Firefox's and Safari's words */
const UNREACHED = /Failed to fetch|NetworkError when attempting to fetch|Load failed|Network request failed|ERR_INTERNET_DISCONNECTED/i;

/** A failure that is the connection, not the page: the device is offline, or Shipcast did not answer */
export function isOffline(error: unknown, online = typeof navigator === 'undefined' ? true : navigator.onLine): boolean {
  if (!online) return true;
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return UNREACHED.test(text);
}
