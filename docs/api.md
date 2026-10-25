---
created_at: 2026-10-25T14:58:14.533623994Z
updated_at: 2026-10-25T14:58:14.533623994Z
tags:
    - api
    - reference
    - auth
    - web-app
    - phase-6
---
# The REST API

Added on 2026-10-25 (milestone 1 of the [goal](plans/goal-after-mvp.md)): stable JSON routes under
`/api/v1/` for the MCP server and any other client, beside the server functions the pages use. Each
route is thin over the same functions as the pages (`launchView`, `launchDetail`, `publishAgain`,
the work functions that draft, approve and publish), so the API and the app cannot disagree. Why
bearer tokens, how they are hashed and why cookies are refused is in
[decisions/api-tokens.md](decisions/api-tokens.md).

## Tokens

Made in the app's **API** page (`/tokens`) or from the command line, and shown once:

```bash
pnpm shipcast token create "MCP on my laptop" --scopes read,write
pnpm shipcast token list
pnpm shipcast token revoke 3
```

`read` covers the `GET` routes, `write` the `POST` ones; one does not include the other. Every route
takes `Authorization: Bearer <token>`; the session cookie does not open the API.

## Routes

The OpenAPI 3.1 document is at `GET /api/v1/openapi.json`, public, built from the same table the
routes are served from (`apps/web/src/server/api.ts`), so it cannot drift.

| Route | Scope | Does |
| --- | --- | --- |
| `GET /launches?limit=&cursor=&status=` | read | The launches, newest first, 20 a page (up to 100). `next` is the cursor of the following page, `null` on the last. `status` is `detected`, `generating`, `drafted`, `published`, `skipped` or `failed` |
| `GET /launches/{id}` | read | One launch: its posts, failures, latest number of each metric, each search engine's index status per article, and its drafts pull request with the list of files (their text stays in the pull request) |
| `GET /accounts` | read | The connected accounts with their public settings and last check; secrets stay in the keychain |
| `GET /jobs` | read | The work running or finished in the last day |
| `POST /launches` | write | `{ "repo": "owner/name", "ref"?: "v1.2.0", "direct"?: false }`: the pre-flight, then drafts to review, or with `direct` straight to main and publishing |
| `POST /launches/{id}/approve` | write | Merges the drafts pull request, then publishes |
| `POST /launches/{id}/retry/{channel}` | write | Forgets that channel's failure on this launch and publishes again |
| `POST /articles` | write | `{ "title", "markdown", "lang": "en"\|"es", "channels"?: [...], "direct"?: false }`: an article written by hand |

A write that starts work answers **202** with `{ "job": "<id>" }`, to follow at `/jobs`. Errors are
`{ "error": { "code", "message" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | A field, a query parameter or the cursor is not valid |
| 401 | `unauthorized` | No token, a wrong one, a revoked one, or only the session cookie |
| 403 | `insufficient_scope` | The token lacks the route's scope |
| 404 | `not_found` | No such launch, or no such route |
| 405 | `method_not_allowed` | The route exists with another method (`Allow` lists them) |
| 409 | `refused` | The work was refused: launched already, a failing pre-flight, drafts that do not merge |
| 415 | `unsupported_media_type` | A `POST` body that is not `application/json` |
| 429 | `rate_limited` | Ten wrong tokens from this client in ten minutes; see `Retry-After` |

## Examples

```bash
APP=https://your-shipcast.example
TOKEN=shipcast_2_...

curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches?limit=5&status=published"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3"
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"owner/name","ref":"v1.0.0"}' "$APP/api/v1/launches"
curl -X POST -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3/retry/devto"
curl "$APP/api/v1/openapi.json"
```

`/api/launches`, the older JSON list of the last hundred launches, still answers behind the session
cookie, for what used it before.

## Checked

Unit tests on a PGlite registry cover the tokens (creation, hash, verification, revocation, a
foreign pepper), the scopes, the limit on wrong tokens and every route's answers
(`packages/runtime/test/api-tokens.test.ts`, `apps/web/test/api.test.ts`). On 2026-10-25 the built
app ran against a copy of the live registry in a throwaway Postgres, with automation off: tokens made
with the CLI, every read route answered, and the 400, 401 (none, wrong, cookie only, revoked), 403,
404, 405, 409, 415 and 429 cases answered as above. No write that starts real work was sent.

## Related

[[decisions/api-tokens.md]] · [[web-app.md]] · [[engine.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]]
