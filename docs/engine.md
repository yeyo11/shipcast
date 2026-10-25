---
created_at: 2026-10-25T15:47:19.702052489Z
updated_at: 2026-10-25T15:52:28.845545328Z
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
---
# The engine

`packages/engine` ([source](../packages/engine/src/)) decides what gets launched, asks the AI for the
content and opens the drafts pull request; `apps/cli` ([source](../apps/cli/src/)) is the `shipcast`
command around it and `apps/web` the [web app](web-app.md). What both share (configuration, the
keychain, connected accounts, the connectors built from them, and the job queue with its handlers)
is `@shipcast/runtime` ([accounts.md](accounts.md), [decisions/job-queue.md](decisions/job-queue.md)).
Written on 2026-10-24, extended on 2026-10-25, each piece tested with fakes and checked against the
real service where it is safe to. It depends on `@shipcast/schema` ([launch-yml.md](launch-yml.md),
[content-pack.md](content-pack.md), [brands.md](brands.md)).

## The launch registry

`Registry` (`registry.ts`) lives in **PostgreSQL**, reached through Drizzle ORM
([decisions/postgres.md](decisions/postgres.md), since 2026-10-25; before, `node:sqlite` in
`data/shipcast.db`). `Registry.connect(SHIPCAST_DATABASE_URL)` opens it with postgres.js and applies
the migrations; the tests use `memoryRegistry()` from `@shipcast/engine/testing`, an in-process
PGlite. The schema is `src/db/schema.ts`; `pnpm --filter @shipcast/engine db:generate` writes a change
as a new SQL migration in `packages/engine/drizzle/`, committed and never edited once applied.
`migrateDatabase` applies them in one transaction for either driver, and can stop at an older one
(`upTo`), which the SQLite copy and the tests of a conversion use. The second migration,
`0001_post_model`, converted every install in place to one row per piece and typed settings
([decisions/post-model.md](decisions/post-model.md)). Every method returns a promise. It is what
makes "a launch happens once" hold:

- **`claim(launch)`** inserts a row unique on `(repo, ref)` and reports whether this call made it. A
  launch is claimed *before* anything is generated, so a second poll, a re-run, a manual launch of
  the same release or a crash halfway through never starts the same campaign twice; two processes
  claiming the same release at once get one winner.
- **Statuses**: `detected`, `generating`, `drafted` (the detail is the pull request, or
  `direct:<sha> <commit URL>` when published without one), `published`, `skipped`, `failed` (the
  detail says why). Skipped and failed launches keep their row.
- **Triggers**: `release`, `manual`, `public`, `enabled`, and `article` for an article written in the app.
- **`lastPublishedRef(repo)`** feeds the pack inference: only `published` launches count.
- **Posts** are one row per published piece (`posts`, since 2026-10-25): the channel's `post`,
  Instagram's `story` and `comment`, a newsletter `issue:<lang>`, a blog `article:<lang>`. Each has
  its `account_id` (null for the blog, or an old piece that cannot be attributed; set to null when the
  account is removed), `external_id`, `url`, `status` (`scheduled`, `live`, `edited`, `deleted`,
  `failed`; `live` today), a nullable `content_hash` and `scheduled_at`, `published_at` and
  `updated_at`. **`recordPost`** is unique on `(launch, channel, account, kind)` with `NULLS NOT
  DISTINCT`, so the same piece is never published twice, and returns the row already there when it
  is; `posts(launch, { channel?, kind? })` and `post(id)` read them.
- **`recordMetrics`**, **`latestMetrics`** and **`metricHistory`** keep every metric reading
  ([publishing.md](publishing.md#metrics)). A reading of one piece points at it (`post_id`, read back
  with `postMetrics`); the site-level sources (blog visits, search, Bing, GitHub) stay the launch's.
  A launch's numbers add up its pieces' read at the same moment, so two newsletter issues are one
  newsletter reading.
- **Settings** (`settings`: `key`, a `jsonb` value, `updated_at`) hold what the owner chose, read
  typed with `setting<T>(key)` and written with `setSetting(key, value)`: the automation mode and
  interval, the AI settings (`ai`) and the prompts' versions (`prompts`) today, the onboarding next.
- **Cursors** keep positions and state only: polling, a channel's permanent failure
  (`publish-failed:<launch>:<channel>`), each article's index status, the last round and delivery.
  `cursorsWithPrefix` lists them, `deleteCursor` forgets one (retrying one launch's channel).
  `retryChannel` reopens a launch unless that channel already has its post.
- **Accounts**: the accounts connected per brand ([accounts.md](accounts.md)); adding, making
  primary and removing one run in a transaction locked per network and brand, so each has one
  primary.
- **Jobs** (`jobs`, migration `0003_jobs`): one row per job of the queue, keyed by pg-boss's id, with
  its title, launch, state, attempts, last 40 log lines, link and times; what the app shows of the
  work after it ends and across restarts (`recordJob`, `updateJob`, `logJob`, `jobs`, `pruneJobs`).
  pg-boss keeps its own tables in the `pgboss` schema ([decisions/job-queue.md](decisions/job-queue.md)).

An install from before Postgres moves its `data/shipcast.db` with `pnpm sqlite-to-postgres`
([decisions/postgres.md](decisions/postgres.md#moving-an-install)): the rows land in the first
migration's schema, SQLite's column for column, and the later migrations convert them like any
install's.

## Detecting launches

`detect({ github, registry, brand })` (`detect.ts`) reads the brand's account's **public events**
(`GET /users/{login}/events/public`):

- **Conditional** requests (ETag): a `304` costs no rate limit. GitHub answers `x-poll-interval: 60`,
  so rounds poll at most once a minute.
- Events newer than the last seen id, oldest first; the cursor advances per event.
- **Triggers**: `ReleaseEvent` with action `published`, and `PublicEvent` (a repo made public).
- `.github/launch.yml` is read **at that tag** (the default branch for a repo made public): no file,
  `enabled: false`, a pre-release, a trigger turned off, or another brand → ignored, no row; an
  invalid file → claimed and recorded `failed` with the line-numbered issues; otherwise **claimed**,
  with the pack from `resolvePack`.

## The pre-flight check

`preflight(repo, ref?, { github })` (`preflight.ts`, 2026-10-25) says whether a repo is ready to
launch, every problem at once, each in a sentence a person can act on: a **published release** (the
tag, or the latest), a **valid `launch.yml`** with `enabled: true`, a **license** GitHub recognises, a
**README**, and the **demo** `assets.demo` names (a path in the repo at the ref, or a URL answering
`HEAD`). All are required; a launch.yml without a demo gets advice, not a block. `shipcast launch` and
the app's Launch a repo page run it first and stop when a required check fails; `shipcast preflight`
runs it alone.

## The AI providers

`AiProvider` (`ai.ts`, 2026-10-25) is the one interface every AI call goes through:
`generateObject(request)` for a schema-bound answer (the content pack, an article's distribution) and
`streamText(request)` for the coming writing assistant. Three providers implement it
([decisions/ai-providers.md](decisions/ai-providers.md)):

- **`Claudio`** (`claudio.ts`, [claudio.md](claudio.md)): `generateObject` on claudio's REST API,
  `POST /api/chats` with the prompt, the `cwd` (a path under claudio's `/workspace`), `jsonSchema`,
  `allowedTools` and `permissionMode: 'dontAsk'`; poll until the main agent calls
  **`StructuredOutput`**, whose `input` is the answer; then **stop the chat**. Failures, a turn without
  `StructuredOutput` and the timeout raise `ClaudioError` with the chat id. `streamText` goes through
  claudio's OpenAI-compatible `/api/v1` with `@ai-sdk/openai-compatible`.
- **`SdkProvider`** on the Vercel AI SDK: `anthropicProvider` (`@ai-sdk/anthropic`, default
  `claude-opus-5-5`) and `openAiCompatibleProvider` (any chat-completions server). `generateObject` is
  `generateText` with `Output.object` over the pack's JSON Schema; with a checkout on this machine
  the model gets read-only `repoTools` (`list_files`, `read_file`, `search`, `git_log`), confined to
  the checkout.

Which provider and model each task uses (`pack`, `article`, `assistant`), the tone override and the
edited prompts are the **AI settings** (`ai-settings.ts`): `readAiSettings`/`writeAiSettings`,
`savePrompt`/`restorePrompt`/`promptHistory`/`currentPrompts`, `previewPrompt` (a past launch's final
prompt, no AI call) and `lockedPrompts`. The pipeline asks `PipelineDeps.aiSetup(task)` before each AI
call (built by `aiSetup` in `@shipcast/runtime` from the settings and the keychain); without it,
`PipelineDeps.ai` and the prompts in code are used.

## From a claimed launch to its drafts

`draftLaunch(launch, brand, deps, { direct? })` (`pipeline.ts`) records each step in the registry:

1. **`launch.yml` at the ref**, validated, and its `brand` checked against the launches repo's.
2. **A fresh shallow clone** of the release (`workspace.ts`): `workspace/<owner>__<repo>@<ref>`, which
   claudio sees as `/workspace/...`; recreated every time so no run leaks into the next.
3. **The content pack** (`generate.ts`, `prompt.ts`), with the `pack` task's provider and model: a
   system prompt with the brand's name and tone (the settings' override, else `brand.yml`'s) closed by
   the **locked** truth rules (only what the code implements is presented as working; no invented
   commands or numbers; a different text per channel), and a prompt with the pack's brief and one
   brief per active channel (`channelBrief`), with its limits and links. Briefs are templates the
   owner may edit (`DEFAULT_PROMPTS`, `{{site}}`, `{{limit.…}}`). Tools are read-only. The answer is
   accepted only when it validates, matches the launch and `missingPieces` is empty.
4. **The drafts** (`drafts.ts`): each article at `src/content/posts/<lang>/<slug>.md`, a readable
   draft per channel at `launches/<project>/<ref>/<channel>.md` saying its mode, and `pack.json`; the
   media go with them ([publishing.md](publishing.md#the-launchs-media)), read with the project's
   look from the launches repo's `projects.yml` ([launches-repo.md](launches-repo.md)).
5. **Delivery** (`deliverDrafts`): a **pull request** in the launches repo (branch
   `launch/<project>-<ref>`, one commit through the Git data API; an open one is returned instead of
   a second), or, with `direct`, **one commit straight onto `main`** (`commitToBranch`, moved without
   force so a branch that moved meanwhile refuses it), which publishes the blog; the engine publishes
   the channels on its next round.

`claimManual(repo, ref?)` starts a launch by hand: the given tag or the latest release; a failed
launch asked for again is retried. `loadBrand` and `loadProjects` read `brand.yml` and `projects.yml`
from the launches repo's default branch. In the app and the rounds, drafting is a `draft` job of the
queue, never retried on its own since it costs an AI run.

## Articles written in the app

`article.ts` (2026-10-25): an article that comes from no release is a launch of its own.

- **Claimed once** (`claimArticle`): repo = the launches repo, ref = `article:<slug>` from its title,
  trigger `article`. Its pieces live in `articles/<slug>/`, its media in `public/articles/<slug>/`.
- **Its channels** are the owner's choice in the app (`articleConfig`: the blog and the chosen ones on,
  drafts-only communities manual, the rest off), written as `articles/<slug>/launch.yml` beside its
  drafts, which is where publishing reads them.
- **The AI translates and distributes, never rewrites** (`generateArticlePack`, with the `article`
  task's provider): it gets the article (`buildArticlePrompt`) and the channels' briefs, no tools, and
  returns a pack; the owner's title and text then replace the AI's copy of them, so only the other
  languages and the channels' pieces are the AI's. The locked truth rule becomes "only what the
  article says". `generateArticlePack` touches neither GitHub nor the registry; `draftArticle` adds
  the media and the delivery.
- An article draws no project cover, counts no GitHub stars, and takes its colour from its slug.

## Reviewing and approving

`review.ts` (2026-10-25), for the app: `readReview` lists a launch's drafts from its pull request (the
articles and channel texts with their content on the branch, the media with a link to their bytes),
`editDraft` saves an edit as a commit on the pull request's branch (only drafts, only while it is
open), and `approveLaunch` merges it with a squash, after which publishing follows as on any merge.

## The shipcast command

`pnpm shipcast <command>` from the repo root (`apps/cli`, run by Node's type stripping):

| Command | Does |
| --- | --- |
| `launch <owner/repo> [--ref <tag>]` | Runs the pre-flight check, then claims and drafts the launch of a release (the latest without `--ref`) |
| `preflight <owner/repo> [--ref <tag>]` | The pre-flight check alone |
| `watch [--interval <s>]` | A worker of the job queue, as the app is: rounds in the Automation settings' mode (detect, draft, publish), the metrics every 6 hours and the token refreshes; `--interval` sets the seconds between rounds (never under 60). Stops on Ctrl+C or SIGTERM ([publishing.md](publishing.md)) |
| `publish [--retry <channel>]` | Publishing, once ([publishing.md](publishing.md)) |
| `metrics` | Reads every source now, as a job of the queue, so the app lists it |
| `status` | The latest launches, their pack and status, and which networks and sources are configured |

The dashboard moved to the [web app](web-app.md) (`pnpm app`) on 2026-10-25. Configuration comes from
`.env` (`GITHUB_TOKEN_PERSONAL`, `SHIPCAST_CLAUDIO_URL`, `SHIPCAST_CLAUDIO_TOKEN`,
`SHIPCAST_LAUNCHES_REPO`, `SHIPCAST_DATABASE_URL`, optional `SHIPCAST_DATA_DIR` and
`SHIPCAST_MAX_BUDGET_USD`); every missing variable is reported at once. The networks' credentials, and
the Anthropic and OpenAI-compatible providers', come from connected accounts, with `.env` as a
fallback for the networks ([accounts.md](accounts.md)). The command uses the AI settings like the app,
and prints no AI cost. Every command connects to Postgres first, so it must be running
(`docker compose up -d postgres`).

**`launch.yml` is read at the release's tag**, so a project's first launch needs a release made after
its `launch.yml` reached the default branch (or `--ref` to a tag that has it).

## After the drafts

The launch's media, publishing after the merge, the newsletter and metrics are in
[publishing.md](publishing.md).

## Related

[[launch-yml.md]] · [[content-pack.md]] · [[claudio.md]] · [[brands.md]] · [[launches-repo.md]] · [[plans/stack.md]] · [[decisions/mvp-scope.md]] · [[status.md]] · [[publishing.md]] · [[web-app.md]] · [[accounts.md]] · [[decisions/postgres.md]] · [[decisions/post-model.md]] · [[decisions/job-queue.md]] · [[decisions/ai-providers.md]]
