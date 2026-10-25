---
created_at: 2026-10-25T20:20:39.777988235Z
updated_at: 2026-10-25T20:26:04.582677797Z
tags:
    - api
    - reference
    - auth
    - web-app
    - phase-6
    - edit-delete
    - phase-9
    - stats
    - scheduling
    - phase-10
    - mcp
    - comments
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

`read` covers the `GET` routes, `write` the `POST`, `PATCH`, `PUT` and `DELETE` ones; one does not
include the other. Every route takes `Authorization: Bearer <token>`; the session cookie does not open
the API, except for WebMCP's same-origin calls while the owner has turned that experiment on
([decisions/mcp.md](decisions/mcp.md)). The [MCP server](mcp.md) uses a `read,write` token, over
stdio (`shipcast mcp`) or at the app's `/mcp`, which checks the same tokens and shares their limit on
wrong ones.

## Routes

The OpenAPI 3.1 document is at `GET /api/v1/openapi.json`, public, built from the same table the
routes are served from (`apps/web/src/server/api.ts`, which spreads in the stats routes of
`stats-api.ts`), so it cannot drift.

| Route | Scope | Does |
| --- | --- | --- |
| `GET /launches?limit=&cursor=&status=` | read | The launches, newest first, 20 a page (up to 100). `next` is the cursor of the following page, `null` on the last. `status` is `detected`, `generating`, `drafted`, `published`, `skipped` or `failed` |
| `GET /launches/{id}` | read | One launch: its posts (each with its `status` and `scheduledAt`), failures, latest number of each metric, each search engine's index status per article, and its drafts pull request with the list of files (their text stays in the pull request) |
| `GET /accounts` | read | The connected accounts with their public settings and last check; secrets stay in the keychain |
| `GET /accounts/{accountId}/growth?from=&to=` | read | An account's followers, following and posts per day from its snapshots, with the change since the one before; the last 90 days by default ([stats.md](stats.md)) |
| `GET /stats/overview?from=&to=&compare=previous` | read | Totals per family (views, reactions, comments, shares, clicks, impressions) overall, per channel and per account, against the previous period or `compareFrom`/`compareTo`, with deltas ([stats.md](stats.md)) |
| `GET /stats/series?metric=&groupBy=&bucket=` | read | One series per channel, account or launch, per day or week: the increase per bucket and the running total ([stats.md](stats.md)) |
| `GET /stats/ranking?by=&order=&limit=&offset=` | read | Posts, launches or accounts ranked by popularity normalised per network, with the raw numbers and each network's yardstick ([stats.md](stats.md)) |
| `GET /jobs` | read | The work running or finished in the last day |
| `GET /capabilities` | read | What each channel can do with a published post: `{ edit, delete, note, fields }` per channel ([decisions/edit-delete.md](decisions/edit-delete.md)) |
| `GET /recommendations?channel=&days=&count=` | read | The best times to publish on a channel Shipcast publishes, for the next `days` (7, up to 30), `count` of them (5, up to 30), one per day, best first: `{ channel, timezone, slots: [{ at, local, score, basis, reason }], history, audience }` ([scheduling.md](scheduling.md#recommended-times)) |
| `GET /settings/timezone` | read | `{ "timezone" }`: the owner's IANA zone, `Europe/Madrid` until set |
| `GET /comments?status=&channel=&launch=` | read | The comments on Shipcast's posts, newest first, the owner's own left out, each with its drafted reply, `canReply` and, where the network cannot reply through its API (dev.to), `replyOn`; and `capabilities`, what each channel can read and reply ([decisions/comment-assistant.md](decisions/comment-assistant.md)) |
| `GET /comment-settings` | read | Each channel's reply mode: `{ "replies": { "mastodon": "off" \| "approval" \| "auto", … } }` |
| `POST /launches` | write | `{ "repo": "owner/name", "ref"?: "v1.2.0", "direct"?: false }`: the pre-flight, then drafts to review, or with `direct` straight to main and publishing |
| `POST /launches/{id}/approve` | write | Merges the drafts pull request, then publishes |
| `POST /launches/{id}/retry/{channel}` | write | Forgets that channel's failure on this launch and publishes again |
| `POST /launches/{id}/schedule` | write | `{ "times": { "bluesky": "2026-10-27T17:00:00+01:00", … } }`: the time each channel's piece goes out, still after the drafts' approval; a channel scheduled again is moved. Answers `{ "posts" }`, each `scheduled`. Refused (409) for a channel out already, `manual` or `off` in `launch.yml`, or a launch done; 400 for a channel Shipcast does not publish or a time more than 60 days ahead ([scheduling.md](scheduling.md)) |
| `PATCH /posts/{postId}/schedule` | write | `{ "at": "<date-time>" }`: moves a scheduled piece; now, or a time past, sends it on the next run. Answers `{ "post" }` |
| `DELETE /posts/{postId}/schedule` | write | Cancels a scheduled piece: its channel is not published for that launch until it is scheduled again. Answers `{ "post" }`, the removed row |
| `PATCH /settings/timezone` | write | `{ "timezone": "Europe/Madrid" }`: an IANA name; offsets such as `+01:00` are refused, having no summer time |
| `POST /articles` | write | `{ "title", "markdown", "lang": "en"\|"es", "channels"?: [...], "direct"?: false }`: an article written by hand |
| `PATCH /posts/{postId}` | write | Edits one published post on its network with the account it went out with: `{ "text"?, "title"?, "tags"?, "link"?, "imageUrl"?, "imageAlt"? }`, at least one; a field the network does not take is refused, and so is a piece still scheduled. Answers `{ "post" }`, now `edited` |
| `DELETE /posts/{postId}` | write | Deletes one published post (dev.to unpublishes it). Answers `{ "post" }`, now `deleted`; the launch never publishes it again |
| `PATCH /launches/{id}/posts` | write | The same change to every live post of the launch, or of `"channels": [...]`, each network taking the fields it has; scheduled pieces are left out. Answers `{ "outcomes": [...] }`, one per post: `ok` with the post, or the `reason` (`unsupported`, `invalid`, `no_credentials`, `failed`…) and the `problem` |
| `DELETE /launches/{id}/posts?channels=a,b` | write | Deletes every live post of the launch, or of the channels named; answers the outcomes the same way |
| `POST /comments/check` | write | Check comments now: a job reads every live post's comments and drafts the new ones' replies |
| `POST /comments/{commentId}/draft` | write | A job drafts the comment's reply again with the AI |
| `PATCH /comments/{commentId}` | write | `{ "draft": "…" }`: writes or edits the reply, within the channel's limit; it waits for approval. Answers `{ "comment" }` |
| `POST /comments/{commentId}/approve` | write | Sends the reply now, with the account the post went out with; once only. Answers `{ "comment" }`, now `sent` |
| `POST /comments/{commentId}/dismiss` | write | No reply is sent. Answers `{ "comment" }`, now `dismissed` |
| `PUT /comment-settings` | write | `{ "replies": { "<channel>": "off" \| "approval" \| "auto" } }`; a channel left out keeps its mode, and `auto` on dev.to is stored as `approval` |

The stats routes all take a period (`from`, `to`: days, both included, or ISO timestamps; the last
30 days by default) and the filters `channels`, `accounts` and `launches`, comma-separated.

Times are ISO 8601 date-times **with their offset** (`Z` or `+01:00`); one without would be read in
the server's zone, which is nobody's choice, and is refused.

The post ids are the ones `GET /launches/{id}` lists under `posts`, the comment ids the ones
`GET /comments` lists. A write that starts work answers **202** with `{ "job": "<id>" }`, to follow at
`/jobs`; an edit, a delete, a schedule, or a reply sent or dismissed is made during the request and
answers **200**. Errors are `{ "error": { "code", "message" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | A field, a query parameter or the cursor is not valid; an edit with a field that network does not take; a period backwards or a series of more than 400 buckets; a time without its offset, a channel with no time, a zone that is not IANA; a reply that is empty, over the channel's limit, or approved with no draft |
| 401 | `unauthorized` | No token, a wrong one, a revoked one, or only the session cookie |
| 403 | `insufficient_scope` | The token lacks the route's scope |
| 404 | `not_found` | No such launch, post, account, comment or route |
| 405 | `method_not_allowed` | The route exists with another method (`Allow` lists them) |
| 409 | `refused` | The work was refused: launched already, a failing pre-flight, drafts that do not merge; a network that cannot edit or delete, a post deleted already or still scheduled, no credentials for the account it went out with; a schedule for a piece out already or a launch done; a reply on a network that cannot send one (dev.to), to the owner's own comment, or to a comment sent, being sent or dismissed already |
| 415 | `unsupported_media_type` | A body that is not `application/json` |
| 429 | `rate_limited` | Ten wrong tokens from this client in ten minutes; see `Retry-After` |
| 502 | `upstream` | The network refused the edit, the delete or the reply; the message is what it said |

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
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/recommendations?channel=bluesky&count=3"
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"times":{"bluesky":"2026-10-27T17:00:00+01:00","mastodon":"2026-10-28T09:00:00+01:00"}}' "$APP/api/v1/launches/3/schedule"
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"at":"2026-10-27T18:00:00+01:00"}' "$APP/api/v1/posts/14/schedule"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/comments?status=draft-ready"
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"draft":"Not yet: it is planned."}' "$APP/api/v1/comments/7"
curl -X POST -H "authorization: Bearer $TOKEN" "$APP/api/v1/comments/7/approve"
curl "$APP/api/v1/openapi.json"
```

`/api/launches`, the older JSON list of the last hundred launches, still answers behind the session
cookie, for what used it before.

## Checked

Unit tests on a PGlite registry cover the tokens (creation, hash, verification, revocation, a
foreign pepper), the scopes, the limit on wrong tokens and every route's answers
(`packages/runtime/test/api-tokens.test.ts`, `apps/web/test/api.test.ts`,
`apps/web/test/stats-api.test.ts`), the edit, delete, scheduling and comment routes included, with
fake connectors. On 2026-10-25 the built app ran against a copy of the live registry in a throwaway
Postgres, with automation off: tokens made with the CLI, every read route answered, and the 400, 401
(none, wrong, cookie only, revoked), 403, 404, 405, 409, 415 and 429 cases answered as above. No
write that starts real work was sent. The stats queries were run the same day against another such
copy ([stats.md](stats.md#checked)), the recommendations against a third
([scheduling.md](scheduling.md#checked)), and the comment assistant's reading, drafting and one send
to a test post of its own against a fourth
([decisions/comment-assistant.md](decisions/comment-assistant.md#checked)).

## Related

[[decisions/api-tokens.md]] · [[decisions/edit-delete.md]] · [[stats.md]] · [[scheduling.md]] · [[mcp.md]] · [[decisions/mcp.md]] · [[decisions/comment-assistant.md]] · [[publishing.md]] · [[web-app.md]] · [[engine.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]]
