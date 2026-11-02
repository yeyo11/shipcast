---
created_at: 2026-10-25T19:31:14.30492503Z
updated_at: 2026-11-02T23:17:40.011304112Z
tags:
    - mcp
    - api
    - reference
    - phase-11
    - webmcp
    - parity
    - push
---
# The MCP server

Added on 2026-10-25 (milestone 7 of the [goal](plans/goal-after-mvp.md), phase 11 of
[plans/after-mvp.md](plans/after-mvp.md)): Shipcast's tools for AI clients, over the
[Model Context Protocol](https://modelcontextprotocol.io). One package, `packages/mcp`, serves them
two ways: **`shipcast mcp`** over stdio for a client on any machine, and **`/mcp`** over Streamable
HTTP, served by the app. Both call the [REST API](api.md), so a client can do exactly what its token's
scopes allow and nothing the app would refuse. **WebMCP**, the same tools offered to an agent in the
browser, is an experiment, off by default. Why it is built this way is in
[decisions/mcp.md](decisions/mcp.md).

Since 2026-11-01 the server is at parity with the API, and the API with the app: every `/api/v1`
operation has a tool, everything the pages do has a route or a written reason it stays in the app,
and two tests fail when a new one does not ([decisions/mcp-parity.md](decisions/mcp-parity.md);
[below](#parity-and-adding-a-tool)).

## Connecting a client

### 1. A token

Every client needs an API token with both scopes. Make one in the app's **API** page (`/tokens`), or
on the machine the app runs on:

```bash
pnpm shipcast token create "Claude Code on my laptop" --scopes read,write
```

It is printed once; only its hash is kept. Revoke it there (or `pnpm shipcast token revoke <id>`)
when the client goes. A `read`-only token works too: the tools that write then answer that the token
lacks the `write` scope.

### 2a. Claude Code, over stdio

From a checkout of Shipcast (`pnpm install` done), on any machine that reaches the app:

```bash
claude mcp add shipcast \
  -e SHIPCAST_API_URL=https://your-shipcast.example \
  -e SHIPCAST_API_TOKEN=shipcast_12_... \
  -- pnpm --silent --dir /path/to/shipcast shipcast mcp
```

`--silent` matters: stdout is the protocol, and pnpm would otherwise print its script banner there.
`SHIPCAST_API_URL` is the app's origin; on the machine the app runs on it can be left out, and
`shipcast mcp` reads `SHIPCAST_PUBLIC_URL` from that checkout's `.env` (that variable alone).
`--url` and `--token` override the environment, but a token on the command line shows in the process
list, so the environment is better.

### 2b. Claude Desktop and other stdio clients

The same command in the client's configuration:

```json
{
  "mcpServers": {
    "shipcast": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/shipcast", "shipcast", "mcp"],
      "env": { "SHIPCAST_API_URL": "https://your-shipcast.example", "SHIPCAST_API_TOKEN": "shipcast_12_..." }
    }
  }
}
```

### 2c. Over HTTP, without a checkout

A client that speaks Streamable HTTP connects to the app itself:

```bash
claude mcp add --transport http shipcast https://your-shipcast.example/mcp \
  --header "Authorization: Bearer shipcast_12_..."
```

The app must be reachable from the client: today the app answers only on the owner's tailnet
([web-app.md](web-app.md)), so this works from the owner's devices, and from anywhere once the app is
on a server.

## Tools

69 tools for the API's 69 operations, one module per area in `packages/mcp/src/tools/<area>.ts`.
**Read** tools only look (`GET`, the `read` scope); **write** tools need the `write` scope, and
*job* means the tool answers a background job to follow with `list_jobs`. **Confirm** marks the tools
that refuse, changing nothing, unless called with `confirm: true` after the user agreed.

### Launches (`launches.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_launches` | `listLaunches` `GET /launches` | Launches newest first, filtered by `status`, `trigger`, `kind`, `repo`, words (`q`), `sort`; pages with `cursor` | read | |
| `get_launch` | `getLaunch` `GET /launches/{id}` | One launch: its posts with ids and status, failures, metrics, index status, and its drafts (files, approvals, what each channel waits for, `versions`) | read | |
| `launch_repo` | `launchRepo` `POST /launches` | Launches a release: pre-flight, analysis and every channel's content as drafts to review; `direct` approves them as written and publishes at once | write, job | with `direct` |
| `approve_drafts` | `approveLaunch` `POST /launches/{id}/approve` | The owner's approval, then every channel published in its mode; `versions` from `get_launch` refuses a draft edited since the user read it | write, job | yes |
| `write_article` | `writeArticle` `POST /articles` | An article written by hand, for the blog and the channels named, through drafts or `direct`; `images` uploaded with `upload_media` | write, job | with `direct` |
| `retry_channel` | `retryChannel` `POST /launches/{id}/retry/{channel}` | Publishes again a channel that failed for good | write, job | |

### Repos (`repos.ts`), all read-only

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_repos` | `listRepos` `GET /repos` | The owner's GitHub repos a launch can be made from, newest push first | read | |
| `list_releases` | `listReleases` `GET /repos/releases` | A repo's releases, each with the launch already made of it (a release launches once) | read | |
| `check_repo` | `checkRepo` `GET /repos/preflight` | The pre-flight of a release without launching: the step before `launch_repo` | read | |

### Drafts (`drafts.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `get_draft` | `getDraft` `GET /launches/{id}/draft` | One draft's whole text, and whether the drafts are still open | read | |
| `edit_draft` | `editDraft` `PUT /launches/{id}/draft` | Replaces a draft's text with a new version; an approval made before does not cover it | write | |
| `preview_on_site` | `requestSitePreview` `POST /launches/{id}/site-preview` | Puts the article on a preview of the real site; the address comes minutes later | write | |
| `get_site_preview` | `getSitePreview` `GET /launches/{id}/site-preview` | The preview's address once deployed | read | |
| `publish_again` | `publishLaunchAgain` `POST /launches/{id}/publish` | Publishes what a drafted launch's approval clears and is not out yet; one failed channel is `retry_channel` | write, job | yes |

### Published posts (`posts.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `get_capabilities` | `listCapabilities` `GET /capabilities` | What each channel can edit or delete on a published post | read | |
| `edit_post` | `editPost` `PATCH /posts/{postId}` | Changes one live post on its network: `text`, `title`, `tags`, `link`, `image_url`, `image_alt` | write, destructive | yes |
| `delete_post` | `deletePost` `DELETE /posts/{postId}` | Deletes one live post from its network (dev.to only unpublishes) | write, destructive | yes |

### Accounts and jobs (`accounts.ts`, `jobs.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_accounts` | `listAccounts` `GET /accounts` | The connected accounts, their public settings and last check; no secrets | read | |
| `check_account` | `checkAccount` `POST /accounts/{accountId}/check` | Checks the account's credential on its network now and records the answer | write | |
| `sync_account` | `syncAccount` `POST /accounts/{accountId}/sync` | Records today's followers, following and posts now; then `get_account_growth` | write, job | |
| `rename_account` | `renameAccount` `PATCH /accounts/{accountId}` | The label Shipcast shows; the profile on the network is unchanged | write | |
| `make_primary_account` | `makePrimaryAccount` `POST /accounts/{accountId}/primary` | The account its brand publishes that channel with from now on | write | |
| `list_jobs` | `listJobs` `GET /jobs` | The last day's background work, newest first: where every *job* is followed | read | |

Connecting and disconnecting an account stay in the app: credentials never go through the API.

### Stats (`stats.ts`), all read-only, the last 30 days unless said otherwise

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `get_stats_overview` | `statsOverview` `GET /stats/overview` | A period's totals overall, per channel and per account, against the previous or another period | read | |
| `get_stats_series` | `statsSeries` `GET /stats/series` | One metric over time, per channel, account or launch, by day or week | read | |
| `get_stats_ranking` | `statsRanking` `GET /stats/ranking` | Posts, launches or accounts by a score normalised per network | read | |
| `get_stats_accounts` | `statsAccounts` `GET /stats/accounts` | Every account's latest followers, following and posts, how fresh, and their change | read | |
| `get_account_growth` | `accountGrowth` `GET /accounts/{accountId}/growth` | One account's daily snapshots; the last 90 days by default | read | |
| `get_search_index_status` | `statsSearch` `GET /stats/search` | Whether Google and Bing indexed each article page, and impressions and clicks per launch | read | |

### Scheduling (`schedule.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `schedule_launch` | `scheduleLaunch` `POST /launches/{id}/schedule` | A time per channel of a launch; publishing still waits for `approve_drafts` | write, destructive | |
| `reschedule_post` | `reschedulePost` `PATCH /posts/{postId}/schedule` | Moves a scheduled post; a time now or past sends it on the next run | write, destructive | |
| `cancel_scheduled_post` | `cancelScheduledPost` `DELETE /posts/{postId}/schedule` | Takes a scheduled channel out of the launch; no network is touched | write | |
| `recommend_times` | `recommendTimes` `GET /recommendations` | The best times to publish on a channel, with the reason | read | |
| `get_timezone` | `getTimezone` `GET /settings/timezone` | The owner's IANA zone | read | |
| `set_timezone` | `setTimezone` `PATCH /settings/timezone` | Sets that zone; an offset such as `+01:00` is refused | write | |

A time always carries its offset (`Z` or `±hh:mm`): the route refuses one without, so the tools refuse
it before calling and point to `get_timezone` for the owner's.

### Comments (`comments.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_comments` | `listComments` `GET /comments` | Comments under the posts, with their status and drafted reply; filters `status`, `channel`, `launch_id` | read | |
| `check_comments` | `checkComments` `POST /comments/check` | Reads the networks now and drafts replies; on an auto channel the drafts are sent | write, job | |
| `redraft_reply` | `redraftComment` `POST /comments/{commentId}/draft` | A fresh AI draft of one reply; sends nothing | write, job | |
| `edit_reply` | `editReply` `PATCH /comments/{commentId}` | Saves a reply written by hand; sends nothing | write | |
| `approve_reply` | `approveReply` `POST /comments/{commentId}/approve` | Sends one reply publicly, in the owner's name | write | yes |
| `dismiss_comment` | `dismissComment` `POST /comments/{commentId}/dismiss` | Leaves a comment without a reply | write | |
| `get_comment_settings` | `getCommentSettings` `GET /comment-settings` | Each channel's reply mode: off, approval or auto | read | |
| `set_comment_settings` | `setCommentSettings` `PUT /comment-settings` | Sets the reply modes of the channels given | write | to set auto |

### Profiles (`profiles.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_profile_capabilities` | `listProfileCapabilities` `GET /profile-capabilities` | What each network lets Shipcast read and edit on a profile, and its limits | read | |
| `get_profile_review` | `getProfileReview` `GET /accounts/{accountId}/profile-review` | An account's capability and latest AI review, a proposal per field | read | |
| `review_profile` | `reviewProfile` `POST /accounts/{accountId}/profile-review` | An AI review of the profile (text can be `pasted`); changes nothing on the network | write, job | |
| `apply_profile_proposal` | `applyProfileProposal` `POST /accounts/{accountId}/profile-review/apply` | Applies one field of the review on the network, as proposed or as the user changed it | write, destructive | yes |
| `apply_brand_picture` | `applyBrandPicture` `POST /accounts/{accountId}/profile/picture` | Sets brand.yml's avatar as the account's picture, where `brandPicture` says it can | write, destructive | yes |
| `edit_profile` | `editProfile` `PATCH /accounts/{accountId}/profile` | Changes the public profile: `display_name`, `bio`, `links` | write, destructive | yes |

### Sources and whole launches (`sources.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `upload_media` | `uploadMedia` `POST /media` | Stores an image (base64, up to 20 MiB, metadata removed) for `launch_from_sources` or `write_article` | write | |
| `launch_from_sources` | `launchFromSources` `POST /launches/sources` | A launch drafted from text, pages, repos and images, for `approve_drafts` | write, job | |
| `edit_launch_posts` | `editLaunchPosts` `PATCH /launches/{id}/posts` | Changes every live post of a launch, or those on the channels named | write, destructive | yes |
| `delete_launch_posts` | `deleteLaunchPosts` `DELETE /launches/{id}/posts` | Deletes every live post of a launch from its networks; the launch stays | write, destructive | yes |
| `plan_launch_deletion` | `planLaunchDeletion` `GET /launches/{id}/deletion` | What `delete_launch` would do, changing nothing | read | |
| `delete_launch` | `deleteLaunch` `DELETE /launches/{id}` | Removes a launch never published, hides a published one; the `channels` named lose their posts too | write, destructive | yes |

`launch_from_sources`, `upload_media` and the deletion tools are always served: their flags were
retired on 2026-11-01 ([sources.md](sources.md), [launch-delete.md](launch-delete.md)), and with them
the tools' own explanation of a feature turned off.

### Attention (`attention.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_attention` | `listAttention` `GET /attention` | What needs the user now, as the app's bell lists it; each kind names the tool that acts on it | read | |
| `dismiss_attention` | `dismissAttention` `POST /attention/dismiss` | Hides lines until their condition changes; every key just read clears the list | write | |

### Notifications (`notifications.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `list_notification_devices` | `listNotificationDevices` `GET /notifications` | The devices that take web push, what each is told, and whether push is configured ([push.md](push.md)) | read | |
| `set_notification_events` | `setNotificationEvents` `PATCH /notifications/devices/{deviceId}` | Turns kinds of notification on or off for one device | write | |
| `delete_notification_device` | `deleteNotificationDevice` `DELETE /notifications/devices/{deviceId}` | Forgets a device; turning it on again takes the user, on that device | write | |
| `send_test_notification` | `sendTestNotification` `POST /notifications/test` | A test notification to one device or every one | write | |

Turning a device on has no tool: the subscription is made by that browser's service worker.

### Automation (`automation.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `get_automation` | `getAutomation` `GET /automation` | The mode, the interval, the last round and delivery, whether a webhook secret is set (never the secret), the trigger rules | read | |
| `set_automation` | `setAutomation` `PATCH /automation` | Changes the mode or the interval | write | to turn on (`poll`, `webhook`) |
| `set_triggers` | `setTriggers` `PUT /automation/triggers` | Replaces the trigger rules, the whole list | write | with an enabled rule |
| `run_round_now` | `runRound` `POST /automation/round` | A round now, whatever the mode, which may publish what is due | write, job | yes |

### AI settings and prompts (`ai.ts`)

| Tool | API operation | Does | Kind | Confirm |
| --- | --- | --- | --- | --- |
| `get_ai_settings` | `getAiSettings` `GET /ai/settings` | Each task's provider, model and USD ceiling, the tone, whether each provider's credential is set | read | |
| `set_ai_settings` | `setAiSettings` `PUT /ai/settings` | Replaces the settings as a whole; a key or token is refused | write | |
| `use_ai_provider_for_all` | `useAiProviderForAll` `POST /ai/providers/{provider}/use-for-all` | One provider for every task; the tone and budgets kept | write | |
| `test_ai_provider` | `testAiProvider` `POST /ai/providers/{provider}/test` | Checks a provider works; at most one cheap call | write | |
| `get_ai_prompts` | `listAiPrompts` `GET /ai/prompts` | The editable prompts with their versions, variables and locked rules | read | |
| `save_ai_prompt` | `saveAiPrompt` `PUT /ai/prompts/{promptId}` | A prompt's new version, used from the next run | write | |
| `restore_ai_prompt` | `restoreAiPrompt` `POST /ai/prompts/{promptId}/restore` | An earlier version, or the default, back in use | write | |
| `preview_ai_prompt` | `previewAiPrompt` `GET /launches/{id}/prompt-preview` | The prompt a past launch would get today, without an AI call | read | |

A change to a provider, a model or a prompt changes every launch's content from the next run: the
descriptions tell the model to confirm it with the user, without `confirm: true`, since nothing
public changes. Keys and tokens are set in the app only.

### How the tools behave

- **One REST call each**, its arguments a Zod schema checked before the API is called. Inputs are
  snake_case (`launch_id`, `account_ids`, `image_url`) and the tool maps them to the API's names.
- **Confirm.** A tool that publishes, changes or deletes something public in the owner's name, or
  turns on work that does so without the user, and is not already behind the drafts review, takes
  `confirm: true` (`requireConfirm` in `shared.ts`). The schema allows `confirm: false` on purpose, so
  the model reads why nothing happened. What goes through drafts (`launch_repo`, `write_article`,
  `launch_from_sources`, `schedule_launch`) waits for `approve_drafts`, which is the confirmed step.
  `set_automation` and `set_triggers` ask for it only to turn something on; `run_round_now` always,
  since a round publishes what is due even while automation is off.
- **Hints.** Every tool takes one of `HINTS` in `shared.ts`: `read`; `work` (background work that
  reaches GitHub or the networks); `job` (an AI run whose result stays in Shipcast); `destructive`
  (changes or removes something public); `setting` (a write that stays in Shipcast, such as
  `edit_draft`, a version in Shipcast's own rows). The scheduling tools carry two of their own
  (`schedule.ts`), destructive because a new time replaces the old one and a time that has come
  publishes; `test_ai_provider` its own, open-world because its call reaches the provider.
- **Flows.** A tool's description names the next one: `list_attention` → the tool each kind needs;
  `list_releases` → `check_repo` → `launch_repo`; `get_launch` → `get_draft` → `edit_draft` →
  `approve_drafts` with the `versions` read; `preview_on_site` → `get_site_preview`;
  `plan_launch_deletion` → `delete_launch`; `list_comments` → `edit_reply` → `approve_reply`;
  `get_stats_overview` → `get_stats_series` and `get_stats_ranking`; `get_launch` → the post and
  scheduling tools; `review_profile` → `get_profile_review` → `apply_profile_proposal`;
  `get_automation` → `set_automation`, `set_triggers`; `save_ai_prompt` → `preview_ai_prompt`. A
  *job*'s answer has a note naming `list_jobs` and the tool that reads its result.
- **Instructions.** The server's instructions are a short intro (what Shipcast is, the confirm and
  job rules, `list_attention` as where to start) followed by each area's `guide`, one sentence or two
  each, so an area describes its tools without editing `server.ts`.

A failure is a tool error (`isError`) whose text is the API's message, its status and code, and what
to do next: `401 unauthorized` says how to make a token, `403 insufficient_scope` to use `read,write`,
`409 refused` not to retry as it is, `429` how long to wait, an unreachable app to check
`SHIPCAST_API_URL` (`packages/mcp/src/errors.ts`). The token never appears in a message: the client
removes it from anything it shows.

**Resources**: `shipcast://launches` (the latest 20) and `shipcast://launches/{id}` (one launch,
listed for the latest). **Prompts**: `launch_checklist` (`repo`, `ref`: from checking with
`list_releases` and `check_repo` that it can launch, through the drafts read and edited, to the
approved, published posts, step by step), `announce_release` (`repo`, `ref`, `lang`: an article
written with the user, true to the code, then `write_article` to drafts) and `launch_report`
(`launch_id`, the latest published launch when left out: `get_launch`, the launch's own numbers per
channel, the channels against the period before, its posts' ranking and its search index, summarised
per channel).

## Parity and adding a tool

Two tests hold the parity ([decisions/mcp-parity.md](decisions/mcp-parity.md)).
`apps/web/test/mcp-parity.test.ts` reads the API's route table (`ROUTES` in
`apps/web/src/server/api.ts`, every area module spread in) and the tools' `operations`, and fails
when:

- an operation has no tool and no entry in its `EXCLUDED` list, which takes the reason a model must
  not or cannot use it (empty today);
- a tool declares an operation the API does not serve;
- an `EXCLUDED` entry has no reason, names no operation, or names one a tool already calls;
- a read-only tool calls an operation that is not a `GET`.

`apps/web/test/app-parity.test.ts` reads every server function of `apps/web/src/server/*.functions.ts`
and fails on one that `apps/web/test/app-parity.ts` leaves out: each is mapped to the operationIds
that do the same, or to the reason it stays in the app.

So a new page action, its route and its tool go in the same change. To add one:

1. **The service** the server function and the route share, in `apps/web/src/server/<area>.server.ts`.
2. **The route**, with its `operationId`, in `apps/web/src/server/api.ts` or its area's module
   (`<area>-api.ts`), documented in [api.md](api.md), and the server function's entry in
   `app-parity.ts`.
3. **The tool** in `packages/mcp/src/tools/<area>.ts`, through `tool({...})`: a `verb_noun` name
   (`list_`, `get_` for reads), snake_case inputs with the shared fields of `shared.ts` (`launchId`,
   `postId`, `accountId`, `channel`, `limit`, `cursor`, `confirm`), `operations: ['<operationId>']`,
   one of `HINTS`, `requireConfirm` when it acts in public without a drafts review, and
   `accepted(answer, what, then)` when it starts a job. The description says what it does, when to
   use it, what it costs and which tool comes next. A new area exports `tools` and a short `guide`,
   and joins `AREAS` in `tools/index.ts`.
4. **Its tests**: the route's in `apps/web/test/<area>-api.test.ts` on PGlite through the shared
   service, the tool's in `packages/mcp/test/tools-<area>.test.ts` against the fake API
   (`fakeClient({ 'METHOD /path': answer })`): the call it makes, what it refuses before calling,
   and an API error reaching the model.
5. **Its row** in the table above.

WebMCP gets the tool too, with nothing more to do: it registers the same list.

## The HTTP endpoint

`/mcp` (`apps/web/src/routes/mcp.ts`, over `createMcpHttpHandler` in `packages/mcp/src/http.ts`):

- **Bearer only, the API's tokens.** The token is checked before MCP starts (`checkBearer` in
  `apps/web/src/server/api.ts`): the same hash, revocation and limit on wrong tokens as `/api/v1`,
  one shared limit for both. Then each tool calls the API **in-process** with the caller's own
  `Authorization` header, so every call gets the route's scope check, with no network hop.
- **Stateless.** Every request gets a fresh server; nothing is kept between requests. It serves the
  2026-07-28 protocol and, for older clients, the 2025 one statelessly (a `GET` or `DELETE` session
  call answers 405).
- **Never the cookie.** Like `/api/v1`, `/mcp` is left out of the session and same-origin middleware
  in `src/start.ts`; a request carrying an `Origin` other than the app's is refused (403), against
  DNS rebinding.

## WebMCP

[WebMCP](https://webmachinelearning.github.io/webmcp/) lets a page offer tools to an agent built into
the browser. `packages/mcp/src/webmcp.ts` (exported as `@shipcast/mcp/webmcp`) registers the **same
tools** on the browser's registry: the proposal's `document.modelContext.registerTool(tool, { signal })`,
or `navigator.modelContext` of early previews, each tool with its JSON Schema and WebMCP's hints
(`readOnlyHint`; `consequentialHint` for every tool that acts). It calls the same-origin `/api/v1` with
the owner's session cookie and the `x-shipcast-webmcp: 1` header.

Status on 2026-10-25: **experimental, off, and not mounted yet**. `mountWebMcp({ enabled })` is there
for the app's shell to call; it registers nothing unless `enabled` is true and the browser has a
registry, and `unmount()` takes every tool off again. The setting is `webmcp:enabled` in the registry
(`readWebMcp` and `writeWebMcp` in `@shipcast/runtime`), false by default; while it is off the API
refuses the cookie calls too, so turning the experiment on takes both the setting and the shell
mounting it.

## Checked

`packages/mcp/test/`: every tool's API call against a fake API (method, path, body), one file per
area (`tools-<area>.test.ts`); the schemas refusing bad arguments before any call; every `confirm`
tool calling nothing without it; the error messages per code, an unreachable app, a non-JSON answer
and the token removed from messages; an MCP client and server over the SDK's in-memory transport
(tools with their annotations, resources, the three prompts); the HTTP handler through the SDK's
Streamable HTTP client (a tool run under the token, 401 for a wrong one, 403 for a foreign origin);
and **`shipcast mcp` spawned over stdio** against the fake API on a local socket. WebMCP:
registration on a fake `modelContext`, unmounting, the session and header on its calls, and a check
that the module imports nothing from Node. `apps/web/test/api.test.ts`: the WebMCP cookie rules and
the `/mcp` bearer check. `apps/web/test/mcp-parity.test.ts` and `apps/web/test/app-parity.test.ts`:
the parity above.

Not yet run against the live app: that needs a token, which the owner makes after the merge (above),
then `claude mcp add` and a `list_launches`. The tools added on 2026-11-01 were checked against the
fake API only.

## Related

[[api.md]] · [[decisions/mcp.md]] · [[decisions/mcp-parity.md]] · [[stats.md]] · [[decisions/api-tokens.md]] · [[decisions/edit-delete.md]] · [[scheduling.md]] · [[decisions/comment-assistant.md]] · [[sources.md]] · [[launch-delete.md]] · [[web-app.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[app-review.md]] · [[launch-triggers.md]]
