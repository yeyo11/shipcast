---
created_at: 2026-10-28T09:26:08.212715688Z
updated_at: 2026-10-28T09:26:08.212715688Z
tags:
    - plan
    - performance
    - redis
    - job-queue
    - caching
    - realtime
    - metrics
    - providers
    - observability
    - architecture
    - solid
    - scaling
---
# Plan: fewer provider calls, a fast app, clean architecture, ready to scale out

Written on 2026-10-28 with the owner, after the REA article's launch page took 5 s to load, re-read
GitHub every 5 s and ended in "Failed to fetch". It was widened the same day: the code must follow
SOLID and reuse one implementation of each piece of logic through services, and Shipcast must run as
several replicas and workers without failing. This is the **plan only**: nothing here is built yet.
It replaces the stop-gaps of that day (`0e2189b`, `f48c96a`, and `7ed9732`, which copied
`draftBody` into the web app), and it is measured before and after.

## Goals and the rule above them

1. **Spend as little as possible on external providers**: fewer and smaller calls, no repeated reads
   of unchanged data, every quota watched.
2. **A fast app**: pages read the registry only and update on events, not by polling.
3. **Clean, reusable code**:
   - one implementation of each use case and each rule, reached by every entry point (web, REST API,
     MCP, CLI, workers) through services;
   - SOLID throughout;
   - adding a network means one module, not forty edits.
4. **Horizontal scale**: N web replicas and N workers of each kind, stateless, with no lost writes,
   no double posts and no per-process truth.

**The rule: no saving and no refactor may cost correctness.**
- Postgres stays the only source of truth.
- Redis holds queues, caches, counters, locks and events, all of which can be lost and rebuilt.
- A cached answer is served only when it is known to be current (validated by the provider's ETag,
  or invalidated by an event).
- Every number keeps the time it was read.
- Behaviour is pinned by tests before code moves.

## Decisions taken with the owner (2026-10-28)

| Question | Decision |
| --- | --- |
| Redis's role | **Everything**: BullMQ replaces pg-boss for queues, schedules and crons; Redis is also used for caches, quotas, locks, shared ephemeral state and pub/sub. Supersedes part of [decisions/job-queue.md](../decisions/job-queue.md) in a new decision document |
| Metrics freshness | **Every hour, always**, for every live post, never faster than the provider updates the number |
| Webhooks | **Only `/api/github/webhook` is public**, HMAC first; polling becomes a slow safety net |
| Measurement | **48 h of baseline before, 48 h after**, weekday to weekday |
| Scale target | **The owner's installation with N replicas** (one owner and their brands; no multi-tenant model) |
| Secrets | **An encrypted table in Postgres** (envelope encryption with the environment's master key, atomic per-row writes); the OS keychain stays for a local install |
| Processes | **web + worker + heavy worker**, each scaled on its own |
| Refactor approach | **Incremental, protected by tests**: characterisation tests first, one piece moved at a time, production never broken |

## Where it stands: measured on 2026-10-28

Production on `apps-1` (8 cores, 23 GB, Postgres 17), 12 connected accounts, 6 launches, 34 posts,
about 42,000 lines of source in 103 test files' worth of coverage.

| What | Value |
| --- | --- |
| Launch page (REA article), document load | **5.2 s** |
| `getLaunch` server function | **4.7 s** (the shell's four other calls take 60–100 ms) |
| Reading one PR's 13 drafts from GitHub, one by one | ~6 s |
| Launch page while a job "runs" | reloads every 5 s, ~18 GitHub calls per reload, ~200 calls/min per open tab |
| Rounds / comment runs / metric runs in 24 h | 280 (2.8 s avg) / 47 (4.0 s) / 4 (39.4 s; 372 readings) |
| Provider calls per day | **not counted anywhere today** (phase 0 adds it) |

## What the audits found (2026-10-28)

### Provider calls

- **Pages read providers.**
  - `getLaunch` reads the drafts PR and `launch.yml` from GitHub on every view, every 5 s while a
    job runs.
  - `brand()` is read from GitHub every 5 min per process.
- **Polling instead of events.** There are 288 rounds a day. The UI polls in 4 places, each
  re-running every loader of the route.
- **N+1 loops.**
  - Metrics: one call per post on 8 networks, plus Cloudflare 1, Google 2 and Bing 2 per URL; GitHub
    stats once per launch, not per repo; the dev.to list re-paginated per post.
  - Comments: per post every 30 min, with a new connector per post, so `/me`, `verify_credentials`
    and Bluesky sessions repeat.
- **Batch endpoints unused**: Bluesky `getPosts` (25 per call), Cloudflare grouped by path, GitHub
  `nodes(ids:)`, Meta batches.
- **Rarely-changing data re-read.**
  - `launch.yml`, `pack.json` and `projects.yml` on every attempt.
  - Index status of already-indexed URLs, 4×/day.
  - Old launches' metrics, forever.
  - A fresh clone per run.
- **Tokens and sessions** live one connector instance long.
- **Only one conditional request** exists (GitHub events); there are **no HTTP timeouts** anywhere
  (no `AbortSignal.timeout`) and no handling of `Retry-After`.

### Correctness

- The round's publish step and a `publish` job can publish the same launch at once: `busy()` is
  check-then-act, and most channels are protected only by the unique `posts` row written *after*
  the network call.
- Retry state travels as strings: the cursor key `publish-failed:<launch>:<channel>` is built in 7
  places, and `' (will retry)'` is appended to a message and later searched for.

### Code structure

1. **No channel abstraction.**
   - Adding one network touches **more than 25 tables and switches in about 40 places** across
     schema, engine, runtime, web, CLI and MCP: `CHANNELS`, `LIMITS`, `PIECE_LIMITS`, prompts, draft
     blocks, `CHANNEL_FILES`, `Publishers`, `CAPABILITIES`, `Editors`, comment tables, `ADAPT_TARGETS`,
     catalog switches, the `services.ts` wiring blocks, `CHANNEL_NAMES` and `DRAFT_CHANNELS`…
   - They have **already drifted**: Threads has no icon, `DRAFT_CHANNELS` lacks three networks, and
     `draftPrefill` never matches `github-discussion.md` or `newsletter-xx.md`.
2. **God objects.**
   - `Registry`: about 77 methods across 12 areas in one class of about 1,040 lines.
   - `publishLaunch`: 356 lines, with 12 publisher closures inline.
   - `workHandlers`: 11 inline handlers.
   - The REST `ROUTES` table: about 430 lines.
   - `LaunchPage`: about 270 lines.
3. **No application-service layer.**
   - Web server functions call the registry directly (about 40 calls across 5 files).
   - Use cases are implemented more than once:
     - retry: web/API, the publish job and the CLI each have their own, with different semantics;
     - multi-edit: re-implemented in `post-actions.ts` instead of calling `editPosts`;
     - publish and notify: both in the queue handler and in `rounds.ts`;
     - error-to-HTTP mapping: three near-identical wrappers plus a fourth.
   - Business rules live in web modules (`pieces.ts`, 575 lines).
4. **Duplication.**
   - The front-matter regex appears 3 times.
   - `draftBody` appears twice (once copied on 2026-10-28).
   - The PR-number regex appears 3 times.
   - `LANGUAGE_NAMES` appears twice.
   - Channel display names appear in **11 maps** that disagree.
   - Article URL wrappers, `Refused` error classes of the same shape (4), per-connector token caching
     (4) and connector wiring written three times.
5. **No shared base error type, no logger** (output goes through `console.*`, `job.log` and injected
   callbacks), and GitHub fakes hand-written in 12+ test files.

### Horizontal scale

Every web process is also a full worker (`context.server.ts:113` calls `startWorking`).

| Hazard | Severity |
| --- | --- |
| Secrets in a local encrypted file rewritten whole (lost writes across processes), or in the per-machine keychain | blocker |
| `workspace/` clones shared with claudio by a host mount; names depend only on repo and ref, and each checkout deletes the other's | blocker |
| OAuth `state` in memory: a callback reaching another replica fails | blocker |
| Session key and API-token pepper created on first use with no lock: two replicas can create different ones | high |
| GitHub user-token refresh guarded per process: two replicas refresh with the same refresh token, the second fails and **deletes the good token** | high |
| Settings held per process: a save reaches only the replica that took it | high |
| API failure limiter per process, and behind a proxy every client is the proxy | high |
| Console sign-in links per process | high |
| Heavy work (git, Chromium, ffmpeg, satori, claudio polling up to 30 min) inside web processes; long AI work inside a web request | high |
| TLS issued per instance outside proxy mode | high |
| GitHub App installation cache refreshed only on the replica that got the webhook | medium |
| Boot-time reconcile can fail a draft that is just starting; boot re-sends crons and moves the round on every start | medium |
| About 15 DB connections per replica (postgres.js 10 + pg-boss 4 + migrator): about 6 replicas fit the default 100 | medium |
| Shutdown does not drain HTTP; a draft killed mid-run waits 2 h; no readiness check | medium |
| Brand cached per process; webhook redeliveries re-queued; display cursors last-write-wins | low |

Already safe across processes:
- migrations under an advisory lock;
- pg-boss cron and stately keys;
- unique claims with `ON CONFLICT DO NOTHING`;
- advisory locks on accounts and schedules;
- compare-and-set for comment replies;
- GitHub sign-in state in a cookie;
- a stateless MCP endpoint;
- job state read from Postgres.

## Target architecture

### Layers and the dependency rule

```text
entry points   web server functions · REST API · MCP (via the API) · CLI · workers' job handlers
                 ↓  validate input, call ONE application service, map the result; no logic
application    services (use cases)
                 ↓  depend on ports (interfaces) only
domain         schema, rules, channel definitions, value objects (pure, no I/O)
                 ↑  implemented by
adapters       Postgres repositories · BullMQ · Redis cache/locks/events · HttpClient · connectors · GitHub · AI
```

- **Application services**, one per area, are the only place a use case lives:
  - `LaunchService` (detect, claim, draft, approve);
  - `PublishingService` (publish a launch, retry a channel);
  - `PostService` (edit, delete, multi-edit);
  - `ScheduleService`, `CommentService`, `MetricsService`, `AccountService`, `DraftService`
    (snapshot, refresh, edit);
  - `SettingsService`, `NotificationService`.

  Each is reused by every entry point. Retry, multi-edit, publish+notify and error mapping each
  exist once.
- **Ports** (interface segregation): `LaunchRepository`, `PostRepository`, `MetricRepository`,
  `JobRepository`, `SecretStore`, `Queue`, `Cache`, `Lock`, `EventBus`, `Clock`, `Logger`,
  `HttpClient`, and the channel capabilities below. Services take only the ports they use.
- **Composition roots**, one per process type: web, worker, heavy worker, CLI, GitHub Action. They are
  the only places adapters are built. They replace `appContext()` being reached from 30 files and
  `buildServices` being called from 7.
- **A guard**: dependency rules checked in CI (dependency-cruiser):
  - entry points never import repositories or connectors;
  - the domain imports nothing with I/O;
  - web modules hold no business rules.

  Size budgets (file and function length) are warned on in review.

### One definition per channel (open/closed)

Each network becomes **one module** that exports a `ChannelDefinition`:

- id, display names (one source of truth for every label);
- language rules;
- its content-pack schema piece and prompt brief;
- the draft file it writes and how it is read back;
- limits and how they are counted;
- capabilities;
- connector factory and credential/OAuth spec;
- metric cadence;
- rate-limit policy;
- icon id.

A `channels` registry lists them. Every table that is keyed by channel today is derived from it.
Behaviour is split into **capability interfaces**, and a connector implements only what its network
offers:
- `Publisher`, `Editor`, `Deleter`;
- `MetricReader` (batch-first: many posts per call);
- `CommentFeed` (notifications since a cursor), `Replier`;
- `ProfileReader`, `ProfileEditor`.

**Contract tests** run every channel through the same suite. Adding a network becomes one folder plus
one line in the registry.

### Publishing as a state machine, not strings

- `publishLaunch` becomes `PublishingService`, which runs each channel's `Publisher` as a strategy.
- Each piece has a persisted state (`pending → attempting → live | retryable | failed`) in an
  attempt row (outbox), written under a per-piece lock before any network call.
- Typed results replace the `publish-failed:` cursor-key strings and `' (will retry)'`.

### The registry split by aggregate

- The `Registry` god-class becomes repositories, one per aggregate:
  - launches, posts and attempts, metrics, accounts and snapshots;
  - jobs, comments, settings, typed cursors, API tokens, assistant sessions, attention.
- They sit on the same Drizzle schema.
- A thin `Registry` facade delegates to them during the migration and is removed at the end
  (strangler).

### Cross-cutting, written once

- **`HttpClient`**: every connector and the GitHub client use one HTTP layer. It provides:
  - a timeout on every call (`AbortSignal.timeout`);
  - retries with backoff that honour `Retry-After`, on idempotent requests only;
  - rate-limit header parsing into the quota counters;
  - the ETag cache;
  - the per-call instrumentation;
  - error mapping.

  Token and session caching is one `TokenCache` (Redis, with a lock around refresh), not four
  hand-written versions.
- **Errors**: one `ShipcastError` base with a code, `retryable` and an HTTP status, mapped to HTTP in
  one place for the API and the pages.
- **Logging**: a structured logger (pino) with request and job correlation ids, replacing
  `console.*`. OpenTelemetry tracing is optional, behind the same interface.
- **Shared helpers**: front matter, draft body, PR number, article URL, language names. Each lives
  once in the domain package, and the duplicates (including the copy made on 2026-10-28) are
  removed.
- **A shared test kit**:
  - fakes for GitHub, every capability, Redis, the clock and the queue;
  - registry fixtures;
  - contract suites.

  It replaces the hand-written fakes in 12+ files.

## Scaling out: process types and shared state

| Process | Runs | Scales by |
| --- | --- | --- |
| **web** | HTTP, SSE, server functions; enqueues work, never runs it | requests |
| **worker** | publish, scheduled posts, metrics, comments (reads), snapshots, token refreshes, deliveries, rounds | queue depth, per-provider limits |
| **heavy worker** | drafting, articles, assets (satori, Chromium, ffmpeg), comment replies with AI, profile reviews, assistant checks | AI and CPU jobs |

The heavy worker runs **claudio as its sidecar** with its own ephemeral volume. Workspaces are
**per job** (a unique directory, removed at the end), so no two jobs share a clone and no host mount
is shared across machines.

| Hazard | Fix |
| --- | --- |
| Secrets file or keychain | **Encrypted `secrets` table in Postgres**: each value is encrypted with a data key wrapped by the master key from the environment; one row per secret, atomic writes, a version column for optimistic concurrency. The keychain stays only for a local single install |
| Session key and API pepper race | Created once under an advisory lock, or provisioned in the bootstrap environment; read once per process and cached |
| GitHub user-token refresh | A distributed lock; inside it, re-read the token, refresh only if still due, write, release; never delete a token that another replica just wrote |
| OAuth `state`, console links | Redis, single use, with a TTL |
| Settings per process | Settings in Postgres, a `settings.changed` event on the bus; every replica reloads on it |
| GitHub App installation cache, brand | `redis-cache`, invalidated by `installation*` and `push` webhooks for every replica at once |
| API failure limiter | Redis counters keyed by client; the client address taken from a trusted proxy header |
| Boot side effects | Crons as BullMQ job schedulers (idempotent); reconcile as a job under a lock, never at boot; the round never moved by a restart |
| Long AI work in a request | A heavy-worker job whose progress streams to the page over SSE |
| DB connections | PgBouncer (transaction mode) in front of Postgres; pool sizes set per process type |
| Shutdown and health | Graceful drain: stop taking HTTP and jobs, finish or hand back running jobs (BullMQ lock renewal), then exit. `/livez` and `/readyz` (DB and Redis ping, draining state) |
| TLS | Proxy mode only on the server; certificates are the proxy's job |
| Webhook redeliveries | Dedupe by `X-GitHub-Delivery` in Redis |
| SSE across replicas | Redis pub/sub fan-out; no sticky sessions needed |

## Provider efficiency and freshness (unchanged from the first version)

### 1. Redis, two instances

- **`redis-queue`**: `noeviction`, AOF `everysec`, on a volume, backed up with the stack.
- **`redis-cache`**: `allkeys-lru`, no persistence.

Both are private to the Docker network, password protected, Redis 7 (or Valkey 8).

### 2. Queues on BullMQ

- Stately keys become `jobId` dedupe, and crons become job schedulers.
- Scheduled posts become delayed jobs `post:<id>`, reconciled with `posts.scheduled_at` at start and
  every 10 minutes.
- The `jobs` table stays as the audit, fed by BullMQ events.
- Network calls are limited per provider, from the quota each provider reports.
- Cutover: drain pg-boss, then start BullMQ from the Postgres truth.
- Tests use a throwaway Redis. The GitHub Action mode keeps working without Redis.

### 3. GitHub by events

- **The public webhook.**
  - `pull_request` refreshes the drafts snapshot.
  - `push` to the launches repo's `main` invalidates `brand.yml`, `projects.yml` and the touched
    `launch.yml`/`pack.json`.
  - `release`/`installation` work as today.
- **Hourly conditional polling** as a safety net.
- **The drafts snapshot table**:
  - written when the PR is opened, on every edit, on `synchronize` and on merge;
  - pages read it, with **Refresh from GitHub** to force a read;
  - every GitHub GET goes through the ETag cache (a 304 is free and proves the body is current);
  - repo stats are read once per repo;
  - clones of immutable tags are reused within a heavy worker.

### 4. Networks

- One connector per account per run; sessions, tokens and identities cached in Redis.
- **Batching**: Bluesky 25 posts per call, Cloudflare one query, one dev.to list per run, GitHub
  `nodes(ids:)`, Meta batches, Brevo.
- **Comments from notification feeds**, one call per account.
- **Quotas watched** from the rate-limit headers, with breakers on repeated 429/5xx shown on Channels.

### 5. Metrics every hour, never faster than the source

| Source | Cadence | Why |
| --- | --- | --- |
| Bluesky, Mastodon, dev.to, Hashnode, Threads, Instagram, Discussions, Brevo, Cloudflare RUM | hourly, batched | changes within the hour |
| GitHub stars | hourly, conditional | live |
| GitHub traffic | daily | bucketed by day |
| Search Console analytics | daily | 2–3 days of lag |
| Google URL inspection | daily until indexed, then weekly | 2,000 per day per property |
| Bing | daily | daily data |

Each reading keeps the provider's "as of" and Shipcast's `checked_at`, and the page says when it was
checked.

### 6. A live UI

- **One SSE stream per tab** over Redis pub/sub.
- **Events name what changed**, so only the matching loader reloads.
- **Reconnect** with `Last-Event-ID`.
- **The four `setInterval`s are removed.**

### 7. Pages read the registry only

- Parallel, indexed queries.
- Heavy aggregates cached under version keys bumped by events.
- **A test fails** if a page's server function makes an external call.

## Instrumentation and the before/after comparison

**Phase 0 instruments and changes nothing else.**
- **Every outbound call**: provider, endpoint template, status, latency, bytes, 304, cache hit or
  retry, and quota headers. Stored hourly in `provider_calls`, with raw samples in Redis for a day.
- **Pages**: `Server-Timing` per server function, stored per hour (p50, p95, p99), plus scheduled
  browser timings of fixed pages.
- **Jobs**: duration, attempts, queue wait and failures.
- **Freshness**: the age of each post's newest reading per source.
- **Correctness**: a daily check of the registry against every connected account, plus duplicates
  and missed schedules.

48 h of baseline before, 48 h after, then a table of before, after and change for each KPI:

| KPI | Target after |
| --- | --- |
| Provider calls per day, total and per provider | −70 % or better, with metrics read more often |
| GitHub calls per day; share answered 304 | −80 %; 304s above 60 % |
| `getLaunch` p95 (server) | under 150 ms, 0 external calls |
| Launch page with 13 drafts, load p95 | under 1 s |
| UI requests per idle open tab per minute | under 1 |
| Comment runs | one call per account, not per post |
| Metric freshness | within cadence 99 % of the time |
| Duplicates / missed schedules / registry vs network mismatches | 0 / 0 / 0 |
| Peak quota use per provider | under 50 % of its limit |
| **Scale test**: 3 web + 2 worker + 1 heavy replicas for 48 h | the same 0 / 0 / 0, no lost secret writes, no failed OAuth callbacks |
| **Chaos**: kill a worker mid-publish, restart Redis, roll a deploy | no duplicate, no lost job, schedules rebuilt from Postgres |
| Code: places to edit to add a network | from about 40 to 1 module plus 1 registry line |
| Code: duplicated helpers and channel-name maps | 0 duplicates; one channel registry |

## Phases

Incremental. Every phase ships alone, is verified, is deployed by whoever deploys the server, and is
reversible. Each refactor phase starts with characterisation tests of the current behaviour.

0. **Instrument and baseline.** The call counter, page timings, job and freshness metrics, a feature
   flag per phase. Deploy, then 48 h of baseline.
1. **Foundations.**
   - The shared test kit and characterisation tests of publishing, editing, scheduling, comments and
     metrics.
   - `HttpClient` (timeouts, retries, quota headers, instrumentation), `ShipcastError`, the logger.
   - The domain helpers de-duplicated.
   - The dependency rules in CI.
2. **Correctness.**
   - `PublishingService`: every publish through it.
   - The piece state machine with attempt rows and per-piece locks.
   - Idempotency keys.
   - The round only enqueues.

   Tests run the round and a publish job together.
3. **Channel plugins and services.**
   - `ChannelDefinition`, the capability interfaces and contract tests, one channel at a time.
   - The application services, with entry points thinned to call them.
   - The duplicate implementations of retry, multi-edit, notify and error mapping removed.
4. **Registry split** into repositories behind the facade, then the facade removed.
5. **Scale-out state.**
   - The encrypted `secrets` table (migrated from the file and keychain, verified, backed up) and the
     locks for token refreshes.
   - Redis for OAuth state, links, the limiter and caches.
   - The settings event, health and readiness, graceful shutdown, PgBouncer.
6. **Redis and BullMQ, and the process split.**
   - Both Redis instances in the stack.
   - BullMQ replaces pg-boss.
   - web / worker / heavy worker with claudio as the sidecar and per-job workspaces.
7. **GitHub by events.** The public webhook route, the drafts snapshot, `push`/`pull_request`
   invalidation, the ETag cache, polling down to hourly.
8. **Metrics and comments.** Hourly batched reads at each source's cadence, notification feeds,
   repo-level stats.
9. **Realtime UI.** SSE over Redis, the `setInterval`s removed, registry-only loaders, the
   external-call guard.
10. **Measure and prove.**
    - 48 h after.
    - The scale test and the chaos tests.
    - The comparison report.
    - The docs: `decisions/redis.md` and `decisions/architecture.md` (layers, services, channel
      plugins), plus updates to `web-app.md`, `engine.md`, `stats.md`, `publishing.md`, `server.md`
      and `accounts.md`.

## Risks and how each is handled

| Risk | Handling |
| --- | --- |
| A refactor changes behaviour | Characterisation tests before each move; one piece at a time behind a flag |
| Redis lost or flushed | Postgres is the truth: schedules, drafts and state are rebuilt; caches cost re-reads |
| A cached value served after it changed | Only ETag-validated caches or event-invalidated version keys |
| A missed webhook | Hourly conditional poll, and **Refresh** on the page |
| Duplicate posts during the queue cutover | Phase 2 first; pg-boss drained before BullMQ starts |
| Secrets migration loses a token | Copied with a verification read-back, the old store kept read-only until verified, a backup in `data/backups/` |
| Provider bans for bursts | Per-provider limiters, breakers, batching |
| A public webhook endpoint | One path, HMAC first, size and rate limits, delivery dedupe |
| Too many DB connections with replicas | PgBouncer, pools sized per process type |

## Still to settle with the owner

- Unchanged metric values: a new row each hour, or `checked_at` moved on the last row.
- The tunnel for the public webhook: Cloudflare Tunnel or a Traefik route (infra repo, server agent).
- Who deploys each phase, since the agent does not deploy Shipcast on the server.

## Related

[[decisions/job-queue.md]] · [[web-app.md]] · [[engine.md]] · [[stats.md]] · [[publishing.md]] · [[accounts.md]] · [[decisions/github-app.md]] · [[decisions/comment-assistant.md]] · [[plans/after-mvp.md]] · [[status.md]]
