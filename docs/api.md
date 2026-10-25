---
created_at: 2026-10-25T16:31:23.52628171Z
updated_at: 2026-10-25T19:30:53.451375769Z
tags:
    - api
    - reference
    - auth
    - web-app
    - phase-6
    - edit-delete
    - phase-9
    - stats
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

`read` covers the `GET` routes, `write` the `POST`, `PATCH` and `DELETE` ones; one does not include
the other. Every route takes `Authorization: Bearer <token>`; the session cookie does not open the API.

## Routes

The OpenAPI 3.1 document is at `GET /api/v1/openapi.json`, public, built from the same table the
routes are served from (`apps/web/src/server/api.ts`, which spreads in the stats routes of
`stats-api.ts`), so it cannot drift.

| Route | Scope | Does |
| --- | --- | --- |
| `GET /launches?limit=&cursor=&status=` | read | The launches, newest first, 20 a page (up to 100). `next` is the cursor of the following page, `null` on the last. `status` is `detected`, `generating`, `drafted`, `published`, `skipped` or `failed` |
| `GET /launches/{id}` | read | One launch: its posts, failures, latest number of each metric, each search engine's index status per article, and its drafts pull request with the list of files (their text stays in the pull request) |
| `GET /accounts` | read | The connected accounts with their public settings and last check; secrets stay in the keychain |
| `GET /accounts/{accountId}/growth?from=&to=` | read | An account's followers, following and posts per day from its snapshots, with the change since the one before; the last 90 days by default ([stats.md](stats.md)) |
| `GET /stats/overview?from=&to=&compare=previous` | read | Totals per family (views, reactions, comments, shares, clicks, impressions) overall, per channel and per account, against the previous period or `compareFrom`/`compareTo`, with deltas ([stats.md](stats.md)) |
| `GET /stats/series?metric=&groupBy=&bucket=` | read | One series per channel, account or launch, per day or week: the increase per bucket and the running total ([stats.md](stats.md)) |
| `GET /stats/ranking?by=&order=&limit=&offset=` | read | Posts, launches or accounts ranked by popularity normalised per network, with the raw numbers and each network's yardstick ([stats.md](stats.md)) |
| `GET /jobs` | read | The work running or finished in the last day |
| `GET /capabilities` | read | What each channel can do with a published post: `{ edit, delete, note, fields }` per channel ([decisions/edit-delete.md](decisions/edit-delete.md)) |
| `POST /launches` | write | `{ "repo": "owner/name", "ref"?: "v1.2.0", "direct"?: false }`: the pre-flight, then drafts to review, or with `direct` straight to main and publishing |
| `POST /launches/{id}/approve` | write | Merges the drafts pull request, then publishes |
| `POST /launches/{id}/retry/{channel}` | write | Forgets that channel's failure on this launch and publishes again |
| `POST /articles` | write | `{ "title", "markdown", "lang": "en"\|"es", "channels"?: [...], "direct"?: false }`: an article written by hand |
| `PATCH /posts/{postId}` | write | Edits one published post on its network with the account it went out with: `{ "text"?, "title"?, "tags"?, "link"?, "imageUrl"?, "imageAlt"? }`, at least one; a field the network does not take is refused. Answers `{ "post" }`, now `edited` |
| `DELETE /posts/{postId}` | write | Deletes one published post (dev.to unpublishes it). Answers `{ "post" }`, now `deleted`; the launch never publishes it again |
| `PATCH /launches/{id}/posts` | write | The same change to every live post of the launch, or of `"channels": [...]`, each network taking the fields it has. Answers `{ "outcomes": [...] }`, one per post: `ok` with the post, or the `reason` (`unsupported`, `invalid`, `no_credentials`, `failed`…) and the `problem` |
| `DELETE /launches/{id}/posts?channels=a,b` | write | Deletes every live post of the launch, or of the channels named; answers the outcomes the same way |

The stats routes all take a period (`from`, `to`: days, both included, or ISO timestamps; the last
30 days by default) and the filters `channels`, `accounts` and `launches`, comma-separated.

The post ids are the ones `GET /launches/{id}` lists under `posts`. A write that starts work answers
**202** with `{ "job": "<id>" }`, to follow at `/jobs`; an edit or a delete is made during the request
and answers **200**. Errors are `{ "error": { "code", "message" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | A field, a query parameter or the cursor is not valid; an edit with a field that network does not take; a period backwards or a series of more than 400 buckets |
| 401 | `unauthorized` | No token, a wrong one, a revoked one, or only the session cookie |
| 403 | `insufficient_scope` | The token lacks the route's scope |
| 404 | `not_found` | No such launch, post, account or route |
| 405 | `method_not_allowed` | The route exists with another method (`Allow` lists them) |
| 409 | `refused` | The work was refused: launched already, a failing pre-flight, drafts that do not merge; a network that cannot edit or delete, a post deleted already, no credentials for the account it went out with |
| 415 | `unsupported_media_type` | A `POST` or `PATCH` body that is not `application/json` |
| 429 | `rate_limited` | Ten wrong tokens from this client in ten minutes; see `Retry-After` |
| 502 | `upstream` | The network refused the edit or the delete; the message is what it said |

## Examples

```bash
APP=https://your-shipcast.example
TOKEN=shipcast_2_...

curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches?limit=5&status=published"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3"
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"owner/name","ref":"v1.0.0"}' "$APP/api/v1/launches"
curl -X POST -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3/retry/devto"
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"The fixed text"}' "$APP/api/v1/posts/12"
curl -X DELETE -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3/posts?channels=mastodon,bluesky"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/stats/overview?from=2026-10-01&to=2026-10-31&compare=previous"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/stats/series?metric=reactions&groupBy=channel&bucket=week"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/stats/ranking?by=launch&limit=10"
curl "$APP/api/v1/openapi.json"
```

`/api/launches`, the older JSON list of the last hundred launches, still answers behind the session
cookie, for what used it before.

## Checked

Unit tests on a PGlite registry cover the tokens (creation, hash, verification, revocation, a
foreign pepper), the scopes, the limit on wrong tokens and every route's answers
(`packages/runtime/test/api-tokens.test.ts`, `apps/web/test/api.test.ts`,
`apps/web/test/stats-api.test.ts`), the edit and delete routes included, with fake connectors. On
2026-10-25 the built app ran against a copy of the live registry in a throwaway Postgres, with
automation off: tokens made with the CLI, every read route answered, and the 400, 401 (none, wrong,
cookie only, revoked), 403, 404, 405, 409, 415 and 429 cases answered as above. No write that starts
real work was sent. The stats queries were run the same day against another such copy
([stats.md](stats.md#checked)).

## Related

[[decisions/api-tokens.md]] · [[decisions/edit-delete.md]] · [[stats.md]] · [[publishing.md]] · [[web-app.md]] · [[engine.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]]
