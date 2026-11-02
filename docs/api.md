---
created_at: 2026-10-25T20:20:39.777988235Z
updated_at: 2026-11-02T23:18:02.105097774Z
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
    - lists
    - profiles
    - sources
    - parity
    - push
---
# The REST API

Added on 2026-10-25 (milestone 1 of the [goal](plans/goal-after-mvp.md)): stable JSON routes under
`/api/v1/` for the MCP server and any other client, beside the server functions the pages use. Each
route is thin over the same functions as the pages (`launchView`, `launchDetail`, `publishAgain`,
the work functions that draft, approve and publish, and each area's service in
`apps/web/src/server/<area>.server.ts`), so the API and the app cannot disagree. Why bearer tokens,
how they are hashed and why cookies are refused is in
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
wrong ones. Every route below has its MCP tool, added in the same change as the route, and since
2026-11-01 everything the pages do through a server function has its route here too, or a written
reason it stays in the app; two tests hold both ([decisions/mcp-parity.md](decisions/mcp-parity.md)).

## Routes

The OpenAPI 3.1 document is at `GET /api/v1/openapi.json`, public, built from the same table the
routes are served from (`apps/web/src/server/api.ts`, which spreads in the area modules beside it:
`stats-api.ts`, `profile-api.ts`, `sources-api.ts`, `attention-api.ts`, `accounts-api.ts`,
`drafts-api.ts`, `repos-api.ts`, `automation-api.ts`, `ai-api.ts` and `push-api.ts`), so it cannot drift.

| Route | Scope | Does |
| --- | --- | --- |
| `GET /launches?limit=&cursor=&status=&trigger=&kind=&repo=&q=&sort=` | read | The launches, newest first, 20 a page (up to 100). `next` is the cursor of the following page, `null` on the last; send it with the same filters and sort. Every parameter is optional and they all hold together: `status` is `detected`, `generating`, `drafted`, `published`, `skipped` or `failed`; `trigger` is `release`, `manual`, `public`, `enabled` or `article`; `kind` is `launch`, `major` or `minor`; `repo` is one repository, `owner/name`; `q` is words in the repository, the ref or an article's title (case-insensitive, up to 200 characters); `sort` is `newest` (the default) or `oldest`. A cursor walks the sort it was given with: an `oldest` cursor sent without `sort=oldest` is a 400 ([decisions/lists.md](decisions/lists.md)) |
| `GET /launches/{id}` | read | One launch: its posts (each with its `status` and `scheduledAt`), failures, latest number of each metric, each search engine's index status per article, and its drafts: the list of files without their text, which ones are approved, why each channel waits, and `versions` (each draft's current version, what the approval takes). A launch decided in its pull request before the launch model also has `pullRequest` |
| `GET /launches/{id}/draft?path=` | read | One draft with its whole text (an article's Markdown, a channel's piece), from the launch model; a medium comes with its address instead. `open` says whether the drafts can still be edited and approved. 409 for a launch the launch model does not hold |
| `GET /launches/{id}/site-preview` | read | The article's preview on the real site as last asked for, with its `url` once the site deployed it (`urlSha` older than `sha` means the address still shows the previous version); 404 until one is asked for ([app-review.md](app-review.md)) |
| `GET /launches/{id}/prompt-preview` | read | The final prompt and system prompt a past launch would get today with the saved prompts and tone, and its task: rendered only, no AI call |
| `GET /notifications` | read | The devices that take web push ([push.md](push.md)) and whether push is configured: `{ configured, problem?, events, devices }`, each device `{ id, label, login, events, createdAt, lastSuccessAt, lastFailureAt, lastFailure, endpointHash }`; never its endpoint or keys |
| `GET /attention` | read | What needs the owner, as the app's bell lists it, less what was dismissed: `{ count, items }`, each item `{ key, kind, text, action, launchId?, accountId?, url }`, `kind` one of `approve`, `retry`, `reply`, `reconnect`, `permission`, `scheduled` (informs, not counted), `canonical`, `drift` |
| `GET /repos` | read | `{ owner, repos }`: the brand owner's GitHub repos to launch from, newest push first, forks and archived ones left out; cached for a few minutes |
| `GET /repos/releases?repo=owner/name` | read | A repo's published releases, newest first, each with `launch: { id, status }` (the launch already made of it, a failed or deleted one included) or `null`: a release is launched once |
| `GET /repos/preflight?repo=owner/name&ref=` | read | The pre-flight of a release without launching (the latest when `ref` is left out): the release, `launch.yml`, the license, the README and the demo, each check with a sentence to act on, and `ok`. The same pre-flight a launch runs before its claim. A repo GitHub does not show is a 404, any other GitHub failure (its rate limit among them) a 502 |
| `GET /accounts` | read | The connected accounts with their public settings and last check; secrets stay in the keychain |
| `GET /accounts/{accountId}/growth?from=&to=` | read | An account's followers, following and posts per day from its snapshots, with the change since the one before; the last 90 days by default ([stats.md](stats.md)) |
| `GET /profile-capabilities` | read | What each network lets Shipcast do with an account's profile: `{ read, edit, fields, editable, limits, note }` per network ([decisions/account-analysis.md](decisions/account-analysis.md)) |
| `GET /accounts/{accountId}/profile-review` | read | `{ capability, review }`: the account's profile capability, narrowed by its credential (`edit: "reconnect"` for a Mastodon token without `write:accounts`, `"no"` for a Telegram bot without the admin right; `brandPicture` where brand.yml's avatar can be set), and its latest AI review with its proposals (`field`, `current`, `proposed`, `why`, `problem`, `appliedAt`), `null` until one ran |
| `GET /stats/overview?from=&to=&compare=previous` | read | Totals per family (views, reactions, comments, shares, clicks, impressions) overall, per channel and per account, against the previous period or `compareFrom`/`compareTo`, with deltas ([stats.md](stats.md)) |
| `GET /stats/series?metric=&groupBy=&bucket=` | read | One series per channel, account or launch, per day or week: the increase per bucket and the running total ([stats.md](stats.md)) |
| `GET /stats/ranking?by=&order=&limit=&offset=` | read | Posts, launches or accounts ranked by popularity normalised per network, with the raw numbers and each network's yardstick ([stats.md](stats.md)) |
| `GET /stats/accounts?from=&to=` | read | The Stats page's Accounts tab: every account with snapshots, its latest followers, following and posts, when it was last read and whether that is stale, its change in the period and a point per day ([stats.md](stats.md#routes)) |
| `GET /stats/search?from=&to=&launches=` | read | The Stats page's Search tab: each published launch's blog article pages with whether Google and Bing indexed each one (`indexed`, `coverage`, `checkedAt`, `null` until read), and each engine's impressions and clicks for the launch in the period with their lifetime ([stats.md](stats.md#routes)) |
| `GET /jobs?limit=&cursor=` | read | The work running or finished in the last day, newest first, as the app's work list shows it (rounds that ended well and jobs that found automation off are left out), 30 a page (up to 100). `next` is the cursor of the following page, `null` on the last; it is a keyset on the job's creation time and id, so a page never repeats or skips a job when new ones arrive. A launches' cursor is refused here |
| `GET /capabilities` | read | What each channel can do with a published post: `{ edit, delete, note, fields }` per channel ([decisions/edit-delete.md](decisions/edit-delete.md)) |
| `GET /recommendations?channel=&days=&count=` | read | The best times to publish on a channel Shipcast publishes, for the next `days` (7, up to 30), `count` of them (5, up to 30), one per day, best first: `{ channel, timezone, slots: [{ at, local, score, basis, reason }], history, audience }` ([scheduling.md](scheduling.md#recommended-times)) |
| `GET /settings/timezone` | read | `{ "timezone" }`: the owner's IANA zone, `Europe/Madrid` until set |
| `GET /comments?status=&channel=&launch=` | read | The comments on Shipcast's posts, newest first, the owner's own left out, each with its drafted reply, `canReply` and, where the network cannot reply through its API (dev.to), `replyOn`; and `capabilities`, what each channel can read and reply ([decisions/comment-assistant.md](decisions/comment-assistant.md)) |
| `GET /comment-settings` | read | Each channel's reply mode: `{ "replies": { "mastodon": "off" \| "approval" \| "auto", … } }` |
| `GET /automation` | read | How Shipcast hears of releases: `mode` (`poll`, `webhook`, `off`), `intervalSeconds`, whether a round is `running`, the `lastRound` and `lastDelivery`, the `webhookUrl`, `hasSecret` (never the secret), `appWebhooks`, and the trigger rules ([launch-triggers.md](launch-triggers.md)) |
| `GET /ai/settings` | read | Each AI task's provider and model, the tone that replaces brand.yml's, each task's spend ceiling in USD per run (the overridden ones, the defaults and the maximum), and each provider with whether its credential is set (never the credential) |
| `GET /ai/prompts` | read | The editable prompts with their default text and saved versions (the last in use), the `{{variables}}` each may use, and the locked rules appended after every prompt |
| `POST /launches` | write | `{ "repo": "owner/name", "ref"?: "v1.2.0", "direct"?: false }`: the pre-flight, then drafts to review, or with `direct` the drafts approved as written and published |
| `POST /launches/{id}/approve` | write | Approves the drafts, then publishes. The optional body `{ "versions": { "<draftId>": <versionId> } }` names the versions read (`drafts.versions` of `GET /launches/{id}`): a draft changed since is refused with a 409 rather than approved unseen |
| `PUT /launches/{id}/draft` | write | `{ "path", "content" }`: one draft's whole new text, a new version (an approval made before does not cover it: approve again). Answers `{ "path" }`. 409 for a piece out already (edit the post), an article already on the site, a text too long for its network, or a launch decided in its pull request |
| `POST /launches/{id}/site-preview` | write | Pushes the article and its media to a preview branch of the launches repo with a draft pull request the site deploys, at an address nobody can guess; answers `{ "preview" }` at once, without its `url` yet. Asked again, the same branch is updated. 409 for a launch decided in its pull request |
| `POST /launches/{id}/publish` | write | Publishes again what a `drafted` launch's approval clears and is not out yet (a publishing that was missed), each piece once; answers 202 with the job. 409 for a launch that is not `drafted`; one failed channel is the next route |
| `POST /launches/{id}/retry/{channel}` | write | Forgets that channel's failure on this launch and publishes again |
| `POST /launches/{id}/schedule` | write | `{ "times": { "bluesky": "2026-10-27T17:00:00+01:00", … } }`: the time each channel's piece goes out, still after the drafts' approval; a channel scheduled again is moved. Answers `{ "posts" }`, each `scheduled`. Refused (409) for a channel out already, `manual` or `off` in `launch.yml`, or a launch done; 400 for a channel Shipcast does not publish or a time more than 60 days ahead ([scheduling.md](scheduling.md)) |
| `PATCH /posts/{postId}/schedule` | write | `{ "at": "<date-time>" }`: moves a scheduled piece; now, or a time past, sends it on the next run. Answers `{ "post" }` |
| `DELETE /posts/{postId}/schedule` | write | Cancels a scheduled piece: its channel is not published for that launch until it is scheduled again. Answers `{ "post" }`, the removed row |
| `PATCH /settings/timezone` | write | `{ "timezone": "Europe/Madrid" }`: an IANA name; offsets such as `+01:00` are refused, having no summer time |
| `POST /articles` | write | `{ "title", "markdown", "lang": "en"\|"es", "channels"?: [...], "images"?: [{ "sha256", "name" }], "direct"?: false }`: an article written by hand; an image is uploaded with `POST /media` first and linked in the body by its name |
| `POST /launches/sources` | write | `{ "title", "lang"?: "en"\|"es", "channels"?: [...], "sources": [...] }`, each source `{ "kind": "text", "text", "title"? }`, `{ "kind": "url", "url" }`, `{ "kind": "repo", "repo", "ref"?, "primary"? }` or `{ "kind": "media", "sha256", "name"?, "alt"? }`: a launch made from sources, drafted as a job; its pages are fetched before the claim, and a page refused, an upload not found or a title launched already is a 409 ([sources.md](sources.md)) |
| `POST /media` | write | the bytes of a PNG, JPEG, GIF or WebP (`content-type: application/octet-stream`, up to 20 MiB), its metadata removed and kept in the media store. Answers `{ "file": { "sha256", "mime", "bytes", "width", "height" } }`; a `media` source names it by its sha256 |
| `PATCH /posts/{postId}` | write | Edits one published post on its network with the account it went out with: `{ "text"?, "title"?, "tags"?, "link"?, "imageUrl"?, "imageAlt"? }`, at least one; a field the network does not take is refused, and so is a piece still scheduled. Answers `{ "post" }`, now `edited` |
| `DELETE /posts/{postId}` | write | Deletes one published post (dev.to unpublishes it). Answers `{ "post" }`, now `deleted`; the launch never publishes it again |
| `PATCH /launches/{id}/posts` | write | The same change to every live post of the launch, or of `"channels": [...]`, each network taking the fields it has; scheduled pieces are left out. Answers `{ "outcomes": [...] }`, one per post: `ok` with the post, or the `reason` (`unsupported`, `invalid`, `no_credentials`, `failed`…) and the `problem` |
| `DELETE /launches/{id}/posts?channels=a,b` | write | Deletes every live post of the launch, or of the channels named; answers the outcomes the same way |
| `GET /launches/{id}/deletion` | read | what deleting the launch would do, nothing changed: `{ mode, refused, channels, articleLinks }`, `mode` `removed` (never published) or `hidden` (published), each channel with pieces out and what deleting there does (`yes`, `unpublish`, `no`) ([launch-delete.md](launch-delete.md)) |
| `DELETE /launches/{id}?channels=a,b` | write | deletes the launch. One never published is removed; a published one is hidden (`deletedAt` on `GET /launches/{id}`, gone from `GET /launches`), its posts kept except on the channels named, deleted there too (`blog` removes the article). Answers `{ mode, outcomes, warning?, problems }`, `warning` saying how many posts still link a removed article; 409 while its drafts are being written or once deleted |
| `POST /attention/dismiss` | write | `{ "keys": [...] }`, 1 to 100 of the `key`s `GET /attention` gave: hides those lines, in the app's bell too, until their condition changes. Answers `{ "dismissed" }`. "Clear all" is the same call with every key read |
| `PATCH /notifications/devices/{deviceId}` | write | `{ "events": { "published": false } }`: what one device is told (`comments`, `approval`, `failed`, `published`); the kinds left out keep their choice. Answers `{ "device" }` |
| `DELETE /notifications/devices/{deviceId}` | write | Forgets a device: it is told nothing more. Answers `{ "removed": true }` |
| `POST /notifications/test` | write | `{ "deviceId"? }`: a test notification to one device or every one, queued (202, `{ "queued" }`); 409 when push is not configured |
| `POST /accounts/{accountId}/check` | write | Checks the account's credential again on its network and records the answer. Answers `{ "account" }` with its `status`, `identity` or `problem` |
| `POST /accounts/{accountId}/sync` | write | A job checks the account again and records today's followers, following and posts; a sync already queued for it is the one answered (202) |
| `PATCH /accounts/{accountId}` | write | `{ "label" }`: the name Shipcast shows for the account; nothing changes on the network. Answers `{ "account" }` |
| `POST /accounts/{accountId}/primary` | write | Makes the account the one its brand publishes with on its network; the one that was primary stays connected. Answers `{ "account" }` |
| `POST /accounts/{accountId}/profile-review` | write | A job reviews the account's profile with the AI settings' `profile` task; nothing changes on the network. The body is optional: `{ "pasted"?: { "displayName"?, "bio"?, "links"?: "Label: value\n…" }, "language"?: "es" }`, `pasted` for a network whose API cannot read the profile (Instagram, Threads, LinkedIn, Reddit), `language` one of the brand's |
| `POST /accounts/{accountId}/profile-review/apply` | write | `{ "field": "displayName"\|"bio"\|"links", "value" }`: applies one field of the latest review on the network, the proposal's text or the owner's change to it, through the same checks as a profile edit; the review marks the proposal applied when the text is the proposed one. Answers `{ "profile" }` |
| `POST /accounts/{accountId}/profile/picture` | write | Sets brand.yml's `avatar` as the account's picture on its network, where its credential can (a Telegram channel, a Discord webhook). Answers `{ "profile" }` |
| `PATCH /accounts/{accountId}/profile` | write | `{ "displayName"?, "bio"?, "links"?: [{ "name", "value" }] }`, at least one: changes the profile on its network with the account's own credential (Mastodon, Bluesky, a Telegram channel), only the fields sent, within the network's limits. Answers `{ "profile" }`, as the network has it now, or `null` |
| `POST /comments/check` | write | Check comments now: a job reads every live post's comments and drafts the new ones' replies |
| `POST /comments/{commentId}/draft` | write | A job drafts the comment's reply again with the AI |
| `PATCH /comments/{commentId}` | write | `{ "draft": "…" }`: writes or edits the reply, within the channel's limit; it waits for approval. Answers `{ "comment" }` |
| `POST /comments/{commentId}/approve` | write | Sends the reply now, with the account the post went out with; once only. Answers `{ "comment" }`, now `sent` |
| `POST /comments/{commentId}/dismiss` | write | No reply is sent. Answers `{ "comment" }`, now `dismissed` |
| `PUT /comment-settings` | write | `{ "replies": { "<channel>": "off" \| "approval" \| "auto" } }`; a channel left out keeps its mode, and `auto` on dev.to is stored as `approval` |
| `PATCH /automation` | write | `{ "mode"?, "intervalSeconds"? }`, at least one, the interval a whole number from 60 to 604 800 (a week): what is left out stays. The next round comes about 15 seconds later, at the new cadence (none while `off`). Answers the settings saved |
| `PUT /automation/triggers` | write | `{ "rules": [...] }`, the whole list in the order tried, each `{ "id", "enabled"?, "event": "release"\|"public", "repos"?, "prereleases"?, "channels"? }`; the engine checks each and a rule that does not hold is a 400. Answers `{ "rules" }` as saved |
| `POST /automation/round` | write | Runs a round now, whatever the mode: it looks for releases and drafts them, queues the publishing of what is approved or due, and reads the numbers when due; the round already waiting is moved to now. 202 with the job; 409 while one runs |
| `PUT /ai/settings` | write | The AI settings as a whole: `{ "tasks": { "<task>": { "provider", "model"? } }, "tone"?, "budgets"? }`, every task given, the tone left out meaning brand.yml's. A field named like a key, token, secret, password or credential is refused (400): credentials are set in the app. Answers `{ "settings" }` |
| `POST /ai/providers/{provider}/use-for-all` | write | Every AI task on one provider: a task already on it keeps its model, the others take the provider's default; the tone and budgets are kept. Answers `{ "settings" }` |
| `POST /ai/providers/{provider}/test` | write | Checks a provider works: its readiness check where it has one (claudio's proves its address, token and Claude sign-in), else one cheap model call, which may cost a fraction of a cent, hence `write`. Answers `ok` with a detail or the problem |
| `PUT /ai/prompts/{promptId}` | write | `{ "text" }`: a prompt's new version, in use from the next run; the earlier ones are kept, the same text as the one in use saves nothing. An unknown id or variable is a 400, a locked part a 409 |
| `POST /ai/prompts/{promptId}/restore` | write | `{ "savedAt" }`: an earlier version (or `"default"`, the code's) back in use, saved as the newest version |

The stats routes all take a period (`from`, `to`: days, both included, or ISO timestamps; the last
30 days by default) and the filters `channels`, `accounts` and `launches`, comma-separated.
`/stats/accounts` and `/stats/search` are the page's own views: days only, at most 731, and of the
filters only `launches` (at most 50) on `/stats/search`.

Times are ISO 8601 date-times **with their offset** (`Z` or `+01:00`); one without would be read in
the server's zone, which is nobody's choice, and is refused.

The post ids are the ones `GET /launches/{id}` lists under `posts`, the comment ids the ones
`GET /comments` lists. A write that starts work answers **202** with `{ "job": "<id>" }`, to follow at
`/jobs`; an edit, a delete, a schedule, a profile edit, or a reply sent or dismissed is made during the
request and answers **200**. No route returns or takes a credential: the accounts, the webhook and the
AI providers say whether theirs is set, and the token, credential and secret forms stay in the app
([decisions/mcp-parity.md](decisions/mcp-parity.md#what-stays-in-the-app-and-why)). Errors are
`{ "error": { "code", "message" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | A field, a query parameter or the cursor is not valid (a cursor sent with another sort included); an edit with a field that network does not take; a period backwards or a series of more than 400 buckets; a time without its offset, a channel with no time, a zone that is not IANA; a reply that is empty, over the channel's limit, or approved with no draft; a profile field over the network's limit, links not written as `Label: value`, or a review of a network that cannot read the profile with nothing pasted; a source of an unknown kind, or an upload that is not one of the images taken; a trigger rule that does not hold, an interval out of range, a credential field in the AI settings, an unknown prompt or variable |
| 401 | `unauthorized` | No token, a wrong one, a revoked one, or only the session cookie |
| 403 | `insufficient_scope` | The token lacks the route's scope |
| 404 | `not_found` | No such launch, post, account, comment, draft, preview, repo or route |
| 405 | `method_not_allowed` | The route exists with another method (`Allow` lists them) |
| 409 | `refused` | The work was refused: launched already, a failing pre-flight, a draft changed since the versions sent; a network that cannot edit or delete, a post deleted already or still scheduled, no credentials for the account it went out with; a schedule for a piece out already or a launch done; a reply on a network that cannot send one (dev.to), to the owner's own comment, or to a comment sent, being sent or dismissed already; a profile edit on a network that cannot make it, or with a credential that must be connected again; a launch made from sources whose page the fetcher refused; a draft out already or of a launch not held; a round while one runs; a locked part of a prompt |
| 413 | `too_large` | An upload over 20 MiB, stopped as soon as it passes the cap |
| 415 | `unsupported_media_type` | A body that is not `application/json` |
| 429 | `rate_limited` | Ten wrong tokens from this client in ten minutes; see `Retry-After` |
| 502 | `upstream` | The network refused the edit, the delete, the reply or the profile edit; the message is what it said. GitHub did not answer for a repo's releases or pre-flight |

## Examples

```bash
APP=https://your-shipcast.example
TOKEN=shipcast_2_...

curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches?limit=5&status=published"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches?repo=owner/name&sort=oldest"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches?trigger=article&q=hello%20world"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/attention"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/repos/releases?repo=owner/name"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/repos/preflight?repo=owner/name&ref=v1.0.0"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/jobs?limit=50"
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"repo":"owner/name","ref":"v1.0.0"}' "$APP/api/v1/launches"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/launches/3/draft?path=src%2Fcontent%2Fposts%2Fen%2Fname.md"
curl -X PUT -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"path":"src/content/posts/en/name.md","content":"# The fixed text"}' "$APP/api/v1/launches/3/draft"
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"versions":{"11":2,"12":1}}' "$APP/api/v1/launches/3/approve"
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
curl -X POST -H "authorization: Bearer $TOKEN" "$APP/api/v1/accounts/2/profile-review"
curl -H "authorization: Bearer $TOKEN" "$APP/api/v1/accounts/2/profile-review"
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"bio":"The proposed bio"}' "$APP/api/v1/accounts/2/profile"
curl -X PATCH -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"intervalSeconds":900}' "$APP/api/v1/automation"
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/octet-stream' \
  --data-binary @screenshot.png "$APP/api/v1/media"
curl -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title":"Why I self-host","sources":[{"kind":"text","text":"My notes"},{"kind":"url","url":"https://example.com/post"}]}' "$APP/api/v1/launches/sources"
curl "$APP/api/v1/openapi.json"
```

`/api/launches`, the older JSON list of the last hundred launches, still answers behind the session
cookie, for what used it before.

## Paging the work list

`GET /jobs` and the Automation page's work list read the same rows (the registry's `jobs` table)
with the same filter, `listed`, applied in SQL, so a page and its counts are the database's. Until
2026-10-27 both read the day's newest 200 rows and cut them in memory, so a busy day lost its
earliest jobs. Now the API pages with a keyset cursor on `(created_at, id)`, which suits a client
walking the list, and the page with numbered pages over an offset plus one grouped count per state,
because it shows "Page 2 of 5" and jumps by number; the list covers one day and ended jobs are pruned
after two weeks, so the offset stays small.

## Checked

Unit tests on a PGlite registry cover the tokens (creation, hash, verification, revocation, a
foreign pepper), the scopes, the limit on wrong tokens and every route's answers
(`packages/runtime/test/api-tokens.test.ts`, `apps/web/test/api.test.ts`, and one file per area
module: `stats-api`, `profile-api`, `sources-api`, `attention-api`, `accounts-api`, `drafts-api`,
`repos-api`, `automation-api` and `ai-api`, each `.test.ts`), the edit, delete, scheduling, comment,
profile and sources routes included, with fake connectors. The area routes of 2026-11-01 run through
the same service as the page's server function, with GitHub, the queue, the app review and the AI
providers faked; their tests also check that no secret appears in an answer. The jobs' cursor is
walked to the end, and the work list's pages are checked on a day of more than 200 jobs
(`apps/web/test/jobs-page.test.ts`); the launches' search, filters, sort and cursors in
`packages/engine/test/launches-list.test.ts`. On 2026-10-25 the built app ran against a copy of the
live registry in a throwaway Postgres, with automation off: tokens made with the CLI, every read route
answered, and the 400, 401 (none, wrong, cookie only, revoked), 403, 404, 405, 409, 415 and 429 cases
answered as above. No write that starts real work was sent. The stats queries were run the same day
against another such copy ([stats.md](stats.md#checked)), the recommendations against a third
([scheduling.md](scheduling.md#checked)), and the comment assistant's reading, drafting and one send
to a test post of its own against a fourth
([decisions/comment-assistant.md](decisions/comment-assistant.md#checked)). The profile routes of
2026-10-27 were checked with fake networks only; no real profile was read or edited. The sources
routes of 2026-10-30 were checked with the work faked; nothing was fetched or uploaded for real. The
area routes of 2026-11-01 have not been run against the live app.

## Related

[[decisions/api-tokens.md]] · [[decisions/edit-delete.md]] · [[decisions/job-queue.md]] · [[decisions/lists.md]] · [[decisions/account-analysis.md]] · [[stats.md]] · [[scheduling.md]] · [[mcp.md]] · [[decisions/mcp.md]] · [[decisions/mcp-parity.md]] · [[decisions/comment-assistant.md]] · [[accounts.md]] · [[publishing.md]] · [[web-app.md]] · [[engine.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[sources.md]] · [[launch-delete.md]] · [[app-review.md]] · [[launch-triggers.md]]
