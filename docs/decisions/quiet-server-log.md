---
created_at: 2026-11-21T10:15:50.339132335Z
updated_at: 2026-11-21T10:15:50.339132335Z
tags:
    - decision
    - web-app
    - server
    - logging
    - auth
---
# A server's log carries no noise and no way in

Two things the production log of 2026-11-21 showed, and what the web app does about them.

## A client that leaves is not an error

Reloading a page, or navigating while server functions are still in flight, closes the browser's
connection early. `apps/web/server.ts` aborts the request's signal then, so a handler that waits on it
(an event stream) lets go. A server function that fails with that abort reached TanStack Start's
`resolveErrorStatus`, which logs every error without an HTTP status and answers a 500 nobody receives:
23 `AbortError` traces in a morning, all matching Traefik's `499` for the same browser.

The abort now carries a reason from `clientGone()` (`apps/web/src/server/client-gone.ts`): an
`AbortError` with `status: 499`, nginx's "client closed request". TanStack Start takes a 4xx/5xx status
as an HTTP error and does not log it; the `catch` in `server.ts` and the streams still recognise it by
its name. Any other error is logged as before.

## The sign-in link is not printed on a server

The console sign-in link ([[web-app]]) is a way in that needs no GitHub, meant for whoever reads the
app's own terminal. Behind a proxy (`SHIPCAST_APP_TLS=proxy`, as production runs) the log is read by
more: a log viewer, an agent's transcript. There the link is printed only with
`SHIPCAST_PRINT_SIGNIN_LINK=1`; GitHub sign-in is the way in. On a desktop and in development it is
printed as before.

## Related

- [[web-app]]
- [[server]]
