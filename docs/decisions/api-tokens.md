---
created_at: 2026-10-25T14:57:58.394473855Z
updated_at: 2026-10-25T14:57:58.394473855Z
tags:
    - decision
    - api
    - auth
    - security
    - phase-6
---
# Decision: bearer tokens for the REST API

Taken on 2026-10-25, building the "token auth and stable REST routes" item of milestone 1 of the
[goal](../plans/goal-after-mvp.md) ([plans/after-mvp.md](../plans/after-mvp.md), phase 6). The MCP
server of phase 11 and any script need a way into Shipcast that is not a browser with a GitHub
session. The routes themselves are in [api.md](../api.md).

## Bearer tokens, made by the owner

A client sends `Authorization: Bearer <token>`. The owner creates a token in the app (the **API**
page) or with `shipcast token create <name> --scopes read,write`, names it after the client, and can
list and revoke it. A token is shown once. OAuth for a single-owner app would add a consent screen
and refresh tokens to protect nothing more; a session cookie cannot be handed to a script without
handing over the owner's browser session too.

The plan said "scoped tokens in the keychain". The token's **hash** went to the registry instead
(`api_tokens`: id, name, hash, scopes, created_at, last_used_at, revoked_at): tokens are records that
accumulate, are listed and revoked, which is what the registry is for, while the keychain keeps the
**pepper** the hash is keyed with (`app:api-token-pepper`, made on first use).

## The token and its hash

- The format is `shipcast_<id>_<secret>`, the secret 32 random bytes in base64url. The id finds the
  row without searching by secret; the prefix lets secret scanners recognise a leaked token.
- The registry keeps `HMAC-SHA256(pepper, secret)`. A slow hash (scrypt) protects low-entropy
  passwords; 256 random bits need none, and checking a token stays a microsecond. The pepper means a
  dump or a backup of the database alone opens nothing.
- The comparison is constant-time (`timingSafeEqual`), and an unknown id is compared against a dummy
  hash, so it costs the same as a known one.
- `last_used_at` is written at most once a minute per token, so a busy client does not write on every
  call. A revoked token keeps its row and its revocation time.

## Scopes

Two: **`read`** (launches, posts, metrics, index status, accounts without their secrets, jobs) and
**`write`** (launch a repo, approve drafts, write an article, retry a channel). Neither includes the
other: a client that only starts launches never needs to read them, and a dashboard never needs to
start one. The MCP server's token has both. Each route declares its scope; a token without it gets
403 with `WWW-Authenticate: Bearer error="insufficient_scope"`.

## Cookies and CSRF

`/api/v1/*` accepts **only** the bearer token; the session cookie is ignored there (a request with
only the cookie gets 401 saying so). That removes cross-site request forgery from the API entirely:
a browser attaches cookies to a forged request, but never an `Authorization` header, which a page on
another site could only set through a CORS preflight the app never answers. So the API is left out
of both the session middleware and Start's same-origin check in `src/start.ts`, and checks its own
tokens in `src/server/api.ts`. Everything else keeps the session cookie and the same-origin rule;
`/api/launches` stays as it was, behind the session.

## Failed attempts

Wrong tokens are counted per client in memory: ten in ten minutes and that client gets 429 with
`Retry-After` until the window ends, before its token is even checked. The client is the socket's
address, which `server.ts` puts in a header after dropping any the client sent; under Vite's dev
server, or behind a proxy on the same machine, every client is one bucket. A restart forgets the
counts, which is fine: the limit keeps the log and the keychain quiet, it is not what makes a
256-bit token unguessable.

## Related

[[api.md]] · [[web-app.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[decisions/web-app-stack.md]] · [[decisions/postgres.md]]
