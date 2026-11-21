/**
 * Why a request's signal aborts when the browser closes the connection first (a reload, a navigation
 * with server functions still in flight). A server function that fails with it reaches TanStack
 * Start's error handler, which logs any error that has no HTTP status as a failure and answers a 500
 * nobody receives. nginx's 499 ("client closed request") is a status it takes as an HTTP error, so
 * the abort stays out of the log; it keeps the AbortError name that server.ts and the streams look for.
 */
export function clientGone(): DOMException {
  const reason = new DOMException('The client closed the connection', 'AbortError');
  return Object.assign(reason, { status: 499 });
}
