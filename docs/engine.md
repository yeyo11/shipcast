---
created_at: 2026-10-25T20:20:29.537359897Z
updated_at: 2026-10-30T02:03:09.164228172Z
tags:
    - engine
    - registry
    - detection
    - claudio
    - pipeline
    - cli
    - architecture
    - postgres
    - post-model
    - job-queue
    - ai
    - snapshots
    - github-app
    - settings
    - stats
    - scheduling
---
# The engine

`packages/engine` ([source](../packages/engine/src/)) decides what gets launched, asks the AI for the
content, opens the drafts pull request and publishes; `apps/cli` ([source](../apps/cli/src/)) is the
`shipcast` command around it and `apps/web` the [web app](web-app.md). What both share (configuration,
the settings, the secret store, connected accounts, the channel adapters and connectors built from
them, the job queue with its handlers, Redis) is `@shipcast/runtime` ([accounts.md](accounts.md),
[decisions/job-queue.md](decisions/job-queue.md), [decisions/redis.md](decisions/redis.md)). It
depends on `@shipcast/schema` ([launch-yml.md](launch-yml.md), [content-pack.md](content-pack.md),
[brands.md](brands.md)). Written on 2026-10-24, extended on 2026-10-25, and restructured on
2026-10-28 into layers ([decisions/architecture.md](decisions/architecture.md)).

## How the engine is laid out

| Layer | Where | Holds |
| --- | --- | --- |
| Domain | `packages/schema` | channel definitions (`src/channels`), the pack's schema, AI task definitions (`src/ai`), rules, `ShipcastError`, the failure keys (`failures.ts`); pure, no I/O |
| Application | `packages/engine/src/services`, `src/publishing` | one service per area, the only place a use case lives |
| Ports | `packages/engine/src/ports.ts` | narrow `Pick`s of the repositories a service takes (`PostStore`, `ScheduleStore`, `MetricStore`…) |
| Adapters | `src/repositories`, `github.ts`, `src/ai`, `src/media`, connectors, runtime's channel adapters | Postgres, GitHub, AI providers, the media store ([media-store.md](media-store.md)), networks |

dependency-cruiser checks the direction in `pnpm typecheck`: entry points never import a connector
or a repository, and the domain imports no I/O. (The rule that fenced the old AI layer went with it
on 2026-10-29.)

### Application services

| Service | Use cases |
| --- | --- |
| `LaunchService` | the launches list, claim by hand (with the pre-flight check), claim an article, edit a draft (`editDraft`: the commit, then the snapshot and the launch model's copy), approve |
| `PublishingService` (`src/publishing/service.ts`) | publish a launch under per-piece claims, Try again on a channel, publish again ([decisions/publishing-state.md](decisions/publishing-state.md)) |
| `PostService` | edit, delete, edit many, delete a launch's posts |
| `ScheduleService` | schedule, move, cancel, recommended times, time zone ([scheduling.md](scheduling.md)) |
| `CommentService` | list, edit a reply's draft, send, dismiss, settings |
| `MetricsService` | read now; the hourly reads (`readHourly`) |
| `DraftSnapshotService` | the drafts pull request as last read: written when opened and on each edit, refreshed on a webhook or by hand |
| `LaunchStoreService` | with `launch-store`: the launch model's shadow write beside the drafts pull request, and its check ([launch-store.md](launch-store.md)) |
| `AccountService`, `SettingsService` | rename, make primary; settings |
| `NotificationService` | the owner's notices (drafted, published), to the private chat only |

The web server functions, the REST API (and the MCP through it), the CLI and the job handlers each
call one of them and map the result. Errors share `ShipcastError` (code, `retryable`, HTTP status),
mapped to HTTP in one place in the web app.

## The launch registry

The registry lives in **PostgreSQL**, reached through Drizzle ORM
([decisions/postgres.md](decisions/postgres.md)). Since 2026-10-28 it is **one repository per
aggregate** in `src/repositories/`, bundled as `Repositories`; the `Registry` class is gone. A
composition root (the app's context, the CLI, the runtime, Action mode, `scripts/measure.ts`) opens
them once with `connectRepositories(SHIPCAST_DATABASE_URL, pool)`, which applies the migrations; the
tests use `memoryRepositories()`, an in-process PGlite. A consumer takes only the repositories it
uses; `inTransaction` runs a use case over several in one transaction.

| Repository | Holds |
| --- | --- |
| `launches` | claim, statuses, the paged and filtered list, `lastPublishedRef` |
| `posts` | one row per piece, scheduling |
| `attempts` (`PublishAttempts`) | the outbox of publish claims (`publish_attempts`) |
| `metrics` | readings, history, `lastChecked` |
| `accounts` | connected accounts and their daily snapshots |
| `drafts` | the drafts snapshot (`draft_snapshots`) |
| `launchStore` | the launch model's packs, channel rows, drafts and versions, media and approvals |
| `jobs`, `comments`, `settings`, `cursors`, `apiTokens`, `assistant`, `attention` | as named |
| `queries` | the raw read-only SQL the query builder cannot say (stats, telemetry reports, checks) |

The schema is `src/db/schema.ts`; `pnpm --filter @shipcast/engine db:generate` writes a change as a
new SQL migration in `packages/engine/drizzle/`, committed and never edited once applied; migrations
run under an advisory lock and are additive. The pool is sized per process (`PoolOptions`: `max`,
`prepare: false` behind PgBouncer, a direct `migrateUrl`; [server.md](server.md)). What makes "a
launch happens once" hold:

- **`launches.claim(launch)`** inserts a row unique on `(repo, ref)` and reports whether this call
  made it. A launch is claimed *before* anything is generated, so a second poll, a re-run, a manual
  launch of the same release or a crash halfway through never starts the same campaign twice.
- **Statuses**: `detected`, `generating`, `drafted` (the detail is the pull request, or
  `direct:<sha> <commit URL>` when published without one), `published`, `skipped`, `failed`.
  **Triggers**: `release`, `manual`, `public`, `enabled`, `article`.
- **Posts** are one row per published piece (`posts`, [decisions/post-model.md](decisions/post-model.md)):
  the channel's `post`, Instagram's `story` and `comment`, a newsletter `issue:<lang>`, a blog
  `article:<lang>`, YouTube's two videos. Each has its `account_id`, `external_id`, `url`, `status`
  (`scheduled`, `live`, `edited`, `deleted`, `failed`), `content_hash`, `scheduled_at`,
  `published_at` and `updated_at`. **`recordPost`** is unique on `(launch, channel, account, kind)`
  with `NULLS NOT DISTINCT` and returns the row already there; a `scheduled` row of the same piece is
  turned into the published one. Scheduling: `schedulePost`, `reschedulePost`, `unschedulePost`,
  `clearSchedule`, `scheduledPosts({ dueBy? })`.
- **Publish attempts** (`publish_attempts`, migration `0013`): one row per piece, claimed before the
  network is called; with `publishing-service` on, `PieceGuard` runs every send through it
  ([publishing.md](publishing.md#publishing-each-piece-once)).
- **Metrics**: `recordMetrics`, `latestMetrics`, `metricHistory`, `postMetrics`. A reading of one
  piece points at it (`post_id`); site-level sources stay the launch's. Since migration `0016` a
  reading has `checked_at`: with `batched-metrics` an unchanged value moves `checked_at` on the last
  row instead of adding one ([stats.md](stats.md)).
- **Settings** (`key`, `jsonb` value): the automation mode, the AI settings and prompts, the
  launches repo, claudio's URL, the Instagram app id, the time zone, the onboarding. (A stored
  `ai-budget-usd`, the global AI budget removed on 2026-10-29, is left in place and never read.)
- **Cursors** keep positions and state only: polling, a channel's permanent failure (its key built
  and parsed only in `@shipcast/schema/failures`), a cancelled schedule, Instagram audience hours,
  index status, the last round and delivery, and what the launch store's check last found
  (`launch-store:<launch id>`).
- **Accounts** and **account snapshots** ([accounts.md](accounts.md),
  [decisions/account-snapshots.md](decisions/account-snapshots.md)): adding, making primary and
  removing run in a transaction locked per network and brand; one snapshot row per account per UTC day.
- **Jobs** (`jobs`): one row per job of the queue, what the app shows after a job ends; the audit for
  pg-boss and BullMQ alike ([decisions/job-queue.md](decisions/job-queue.md)).
- **Secrets** (`secrets`, migration `0014`): sealed rows read through `SecretRows` by the runtime's
  `TableStore`, used with `secrets-table` ([server.md](server.md)).
- **Telemetry** (`provider_calls`, `timings`, `checks`, migration `0012`): `src/telemetry/`
  ([measurement.md](measurement.md)).
- **The launch model's tables** (migration `0018`, 2026-10-30), the first phase of
  [decisions/launch-model.md](decisions/launch-model.md). Since the second phase the
  `LaunchStoreRepository` (`repositories/launch-store.ts`) writes the packs, channel rows, drafts and
  versions, media and approvals, through the shadow write of the `launch-store` flag
  ([launch-store.md](launch-store.md)); **nothing reads them yet**. Each hangs on its launch with
  `on delete cascade`, so a purge of the launch's row takes them all (the soft delete keeps the row):

  | Table | Holds |
  | --- | --- |
  | `launch_sources` | what a launch is about, in order (`position`): its `kind` (`repo_release`, `repo_ref`, `repo`, `url`, `text`, `media`, `video`, `launch`), its `role` (`primary`, `context`), the repo, ref and frozen `sha`, a URL with what fetching it answered, the owner's text, a file (`media_id`), `meta` and a `content_hash` |
  | `launch_channels` | per launch and channel (the key), its `mode`, account, `options` (subreddits…) and a `note`: `launch.yml`'s `publishing`, copied once |
  | `packs` | every analysis: the pack as returned, its `version` (unique per launch), the AI task, provider, chat and cost, `accepted` |
  | `drafts` | one per publishable piece, unique on `(launch, channel, piece)`, with its `current_version_id` |
  | `draft_versions` | every version of a draft, never changed: `n` (unique per draft), `body`, `fields`, `origin` (`ai`, `owner`, `assistant`, `import`, `post-publish-edit`), `author`, the pack it came from |
  | `media` | what describes a file of the media store ([media-store.md](media-store.md)): its sha256 (once per launch), kind, type, size, store and key, role and `public_path` |
  | `approvals` | who approved a launch, when, and the exact version of each draft (`versions`), until `revoked_at` |

  `launches` gained `title`, `model` (`legacy`, today's pull-request flow, for every row; `app` for a
  launch held by Shipcast), `channels_source` (the `launch.yml` its channel rows came from),
  `deleted_at` and `approved_at`, and **`dedupe_key`**, unique where set (Postgres lets any number of
  nulls through): the claim for a launch with no repo and tag, as `github-release:<owner/name>@<tag>`,
  `github-public:<owner/name>` or `article:<slug>`, and null for a launch the owner may start twice.
  `repo` and `ref` stay required during the transition (a launch with no repo gets synthetic ones).
  `posts` and `publish_attempts` gained `draft_version_id`, and `publish_attempts` `approval_id`: what
  exactly went out, under which approval.

An install from before Postgres moves its `data/shipcast.db` with `pnpm sqlite-to-postgres`
([decisions/postgres.md](decisions/postgres.md#moving-an-install)).

## GitHub access

`GitHubRest` (`github.ts`) is every read and write the engine makes on GitHub. It takes a token or a
`GitHubAuth`, asked for a token on each request; that is **`GitHubApp`** (`github-app.ts`):
installation tokens minted from the App's private key, kept until five minutes before they expire. A
`401` makes it forget the token and try once more. Without an App, the old `GITHUB_TOKEN_PERSONAL`.
A repo's traffic needs Administration: read, which the App lacks, so traffic comes from a connected
GitHub account ([decisions/github-app.md](decisions/github-app.md)).

With `github-events`, `GitHubRest` takes an ETag cache (in `redis-cache` with `redis-state`, a
bounded in-process one otherwise): **every GET is conditional**, and a 304 is answered from the cache.
A `push` to the launches repo forgets the files it touched; a `pull_request` queues the drafts
snapshot's refresh. `RepoArchiveSource` gives the AI runner a release's `codeload` tarball URL,
resolved with Shipcast's own token, for a provider that downloads the repo itself.

## Detecting launches

`detect({ github, registry, brand })` (`detect.ts`) reads the brand's account's **public events**
(`GET /users/{login}/events/public`), conditionally (ETag; a `304` costs no rate limit). Triggers:
`ReleaseEvent` published, and `PublicEvent`. `.github/launch.yml` is read **at that tag**: no file,
`enabled: false`, a pre-release, a trigger turned off, or another brand → ignored; an invalid file →
claimed and recorded `failed` with the line-numbered issues; otherwise **claimed**, with the pack from
`resolvePack`. With `github-events` releases arrive by webhook and the round's detection runs at most
hourly, as a safety net.

## The pre-flight check

`preflight(repo, ref?, { github })` (`preflight.ts`) says whether a repo is ready to launch, every
problem at once: a **published release**, a **valid `launch.yml`** with `enabled: true`, a
**license**, a **README**, and the **demo** `assets.demo` names. `shipcast launch` and the app's Launch
a repo page run it first.

## The AI

One layer: the AI task runner ([decisions/ai-layer.md](decisions/ai-layer.md)). It was built behind
the `ai-runner` flag; since 2026-10-29 it is the only path, the first layer
([decisions/ai-providers.md](decisions/ai-providers.md)) is deleted and the flag retired (a
`SHIPCAST_FLAGS` that still lists it is accepted and ignored).

- **The AI task runner** (`src/ai/runner.ts`). Every task (`AI_TASK_DEFINITIONS` in
  `@shipcast/schema`: `pack`, `article`, `assistant`, `assistant-check`, `replies`, `profile`,
  `provider-check`) runs on the AI SDK the same way: always streamed, no SDK retries (the job queue
  retries a retryable `AiError`), the task's timeout and the caller's abort, Zod validation with one
  repair, usage and timing recorded. A task's definition holds its output schema, whether it reads
  the repo and its limits.
- **A provider** is one module in `src/ai/providers/` (`claudio`, `anthropic`, `openaiCompatible`,
  and `openai` for Action mode), listed in `registry.ts`, with its settings fields, capabilities and
  how it builds its model. For a `local-tools` provider the runner gives the model read-only tools
  over the job's clone (`repo_overview`, `read_files`, `search`, `list_files`, `git`, in
  `repo-tools.ts`) and takes the answer through a strict `submit_answer` tool; a `remote-workspace`
  provider (claudio) reads the repo in a workspace it downloads itself ([claudio.md](claudio.md)).
  The runtime builds one runner per process (`aiRunnerFor`), resolving the task's provider and model
  from the AI settings when the task runs.

The **AI settings** (`ai-settings.ts`) choose a provider and model per task (`pack`, `article`,
`assistant`, `replies`, `profile`; claudio until set), the tone override and the edited prompts
(`savePrompt`, `restorePrompt`, `promptHistory`, `currentPrompts`, `previewPrompt`,
`lockedPrompts`).

They also keep the owner's **spend limit per task** under `budgets`, by task id (`pack`, `article`,
`assistant`, `assistant-check`, `replies`, `profile`), validated with Zod (above 0, at most
`MAX_AI_BUDGET_USD`, 50 USD); a stored value that no longer parses falls back on the task's default
alone. `aiBudgetUsd(settings, task)` gives the override or the default from
`DEFAULT_AI_BUDGETS_USD` (`packages/schema/src/ai/tasks.ts`: pack 5, article 3, assistant-check 2,
assistant 1, replies 1, profile 0.5 USD). The runtime's `aiRunSetup` hands them to the runner, where
the owner's limit for the task wins, else the definition's default; nothing sits in between. The
single global AI budget (`SHIPCAST_MAX_BUDGET_USD`, the `ai-budget-usd` setting) that the pack, the
article and the check used to pass was removed on 2026-10-29; a stored row or the variable left in
an env is ignored. The runner sends the result only to a provider that takes a ceiling, claudio's
`maxBudgetUsd`; the Anthropic API, OpenAI and OpenAI-compatible servers get none and are bounded by
steps, output tokens and the timeout.

## From a claimed launch to its drafts

`draftLaunch(launch, brand, deps, { direct? })` (`pipeline.ts`) records each step in the registry:

1. **`launch.yml` at the ref**, validated, and its `brand` checked against the launches repo's.
2. **A fresh shallow clone** of the release (`workspace.ts`). In a split deployment
   (`SHIPCAST_ROLE`) each job's clone has a unique name and is removed when the job ends
   (`withJobWorkspace`), so no two jobs share one; a single process keeps one
   `workspace/<owner>__<repo>@<ref>` folder per release. The clone is what the runner's `local-tools`
   providers and the launch's media read; no AI provider shares the folder (claudio downloads a
   workspace of its own).
3. **The content pack** (`generate.ts`, `prompt.ts`), on the `pack` task: a system prompt with the
   brand's name and tone closed by the **locked** truth rules (only what the code implements is
   presented as working; no invented commands or numbers; a different text per channel), and a
   prompt with the pack's brief and one brief per active channel, each from its channel definition.
   The answer is accepted only when it validates, matches the launch (its kind, and its
   `project.repo` is the launch's repo: further `repos` never stand in for it) and `missingPieces` is
   empty.
4. **The drafts** (`drafts.ts`): each article at `src/content/posts/<lang>/<slug>.md`, a draft per
   channel at the file its definition names under `launches/<project>/<ref>/`, and `pack.json`; the
   media go with them ([publishing.md](publishing.md#the-launchs-media)).
5. **Delivery** (`deliverDrafts`): a **pull request** in the launches repo (branch
   `launch/<project>-<ref>`, one commit through the Git data API), or, with `direct`, **one commit
   straight onto `main`**. The drafts snapshot is written as the pull request opens, and with
   `launch-store` the launch model's copy too ([launch-store.md](launch-store.md)).

`claimManual(repo, ref?)` starts a launch by hand. In the app and the rounds, drafting is a `draft`
job (a `heavy` one in a split), never retried on its own since it costs an AI run.

## Articles written in the app

`article.ts`: an article that comes from no release is a launch of its own, claimed once
(`claimArticle`: repo = the launches repo, ref = `article:<slug>`, trigger `article`). Its channels are
the owner's choice, written as `articles/<slug>/launch.yml` beside its drafts. **The AI translates and
distributes, never rewrites** (the `article` task): the owner's title and text replace the AI's copy
of them, and the locked truth rule becomes "only what the article says".

## Reviewing and approving

`review.ts`: `readReview` lists a launch's drafts from its pull request, `LaunchService.editDraft`
saves an edit as a commit on its branch (`editDraft`: only drafts, only while open; the snapshot is
patched with it, and with `launch-store` it is a version of the owner's), and
`LaunchService.approve` merges it with a squash, after which publishing follows as on any merge. With
`github-events` the launch page reads the drafts from the snapshot, never from GitHub; **Refresh from
GitHub** reads it again.

## Telemetry

`src/telemetry/`: the hourly store of provider calls and timings (`TelemetryStore`), the correctness
and freshness checks, and the before/after report (`scripts/measure.ts`). See
[measurement.md](measurement.md).

## The shipcast command

`pnpm shipcast <command>` from the repo root (`apps/cli`):

| Command | Does |
| --- | --- |
| `launch <owner/repo> [--ref <tag>]` | Runs the pre-flight check, then claims and drafts the launch of a release |
| `preflight <owner/repo> [--ref <tag>]` | The pre-flight check alone |
| `watch [--interval <s>]` | A worker of the job queue, as the app is: rounds in the Automation settings' mode, the metrics, token refreshes and account snapshots |
| `publish [--retry <channel>]` | Publishing, once ([publishing.md](publishing.md)); through `PublishingService` with `publishing-service` |
| `metrics` | Reads every source now, as a job of the queue |
| `sync [<account id>]` | Checks every connected account (or one) and records today's snapshot |
| `status` | The latest launches, how the engine reaches GitHub, the settings still to set, what is configured |
| `token create/list/revoke` | REST API tokens ([api.md](api.md)) |
| `youtube import <file>` | Connects YouTube once from an OAuth client and refresh token file ([decisions/youtube.md](decisions/youtube.md)) |
| `secrets migrate [--from keychain\|file]` | Copies every secret into the encrypted table, each read back ([server.md](server.md)) |
| `init`, `ci`, `mcp` | A local install's setup, Action mode ([decisions/action-mode.md](decisions/action-mode.md)), the MCP server over stdio |

The command builds the same runtime as the app (`createRuntime`): the bootstrap from `.env`, the
settings from the database and the secret store, the same flags (`SHIPCAST_FLAGS`) and queue. Every
command connects to Postgres first, so it must be running (`docker compose up -d postgres`). On a
preview with fake networks only the commands that reach no network run.

**`launch.yml` is read at the release's tag**, so a project's first launch needs a release made after
its `launch.yml` reached the default branch (or `--ref` to a tag that has it).

## After the drafts

The launch's media, publishing after the merge, the newsletter and metrics are in
[publishing.md](publishing.md); the stats section in [stats.md](stats.md); scheduled publishing in
[scheduling.md](scheduling.md).

## Related

[[launch-yml.md]] · [[content-pack.md]] · [[claudio.md]] · [[brands.md]] · [[launches-repo.md]] · [[publishing.md]] · [[web-app.md]] · [[accounts.md]] · [[stats.md]] · [[scheduling.md]] · [[server.md]] · [[measurement.md]] · [[decisions/architecture.md]] · [[decisions/publishing-state.md]] · [[decisions/redis.md]] · [[decisions/ai-layer.md]] · [[decisions/ai-providers.md]] · [[decisions/postgres.md]] · [[decisions/post-model.md]] · [[decisions/job-queue.md]] · [[decisions/account-snapshots.md]] · [[decisions/github-app.md]] · [[decisions/youtube.md]] · [[status.md]] · [[decisions/launch-model.md]] · [[media-store.md]] · [[launch-store.md]]
