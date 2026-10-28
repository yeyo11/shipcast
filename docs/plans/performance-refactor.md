---
created_at: 2026-10-28T09:09:39.179624399Z
updated_at: 2026-10-28T09:09:39.179624399Z
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
---
# Plan: fewer provider calls, a fast app, Redis for queues, caches and events

Written on 2026-10-28 with the owner, after the REA article's launch page took 5 s to load, re-read
GitHub every 5 s and ended in "Failed to fetch". This is the **plan only**: nothing here is built
yet. It replaces the stop-gap fixes of that day (`0e2189b`, `f48c96a`) with a design that scales, and
it is measured before and after so the result is a number, not an impression.

## Goals and the rule above them

1. **Spend as little as possible on external providers**: fewer calls, smaller calls, no repeated
   reads of data that did not change, every quota watched.
2. **A fast app**: a page reads the registry only, never a provider, and updates when something
   changes instead of polling.
3. **Durable, scalable background work** on Redis (BullMQ), with per-provider rate limits.

**The rule: no saving may cost correctness.** Postgres stays the only source of truth. Redis holds
queues, short-lived caches, counters and events, all of which can be lost and rebuilt. A cached
answer is only served when it is *known* to be current (validated by the provider's ETag, or
invalidated by an event); anything else is read again. Every number shown keeps the time it was read
at, so a stale value can never pass for a fresh one.

## Decisions taken with the owner (2026-10-28)

| Question | Decision |
| --- | --- |
| Redis's role | **Everything**: BullMQ replaces pg-boss for the queues, schedules and crons; Redis also for caches, quotas and pub/sub. This reverses [decisions/job-queue.md](../decisions/job-queue.md)'s "no new server", which is why it needs its own decision document |
| Metrics freshness | **Every hour, always**, for every live post; never read more often than the provider itself updates the number (below) |
| Webhooks | **Expose only `/api/github/webhook`** to the internet, signed with HMAC; polling becomes a slow safety net |
| Measurement | **48 h of baseline before, 48 h after**, same instrumentation, same calendar shape (weekday to weekday) |

## Where it stands: measured on 2026-10-28

Production on `apps-1` (8 cores, 23 GB, Postgres 17), 12 connected accounts, 6 launches, 34 posts.

| What | Value |
| --- | --- |
| Launch page (REA article), document load | **5.2 s** |
| `getLaunch` server function | **4.7 s**; the shell's four other calls 60–100 ms |
| Reading the 13 drafts of one PR from GitHub one by one | ~6 s |
| Launch page while a job "runs" | reloads every 5 s: ~18 GitHub calls per reload, ~200 calls/min per open tab |
| Rounds in 24 h | 280 (every 300 s), 2.8 s average |
| Comment runs in 24 h | 47 (every 30 min), 4.0 s average |
| Metric runs in 24 h | 4 (every 6 h), 39.4 s average; 372 readings stored |
| Provider calls per day, per provider | **not counted anywhere today**: phase 0 adds it |

## What the inventory found

The full inventory (every outbound call, file and trigger) was taken from the code on 2026-10-28. The
waste, by size:

1. **Pages read providers.** `getLaunch` reads the drafts pull request (PR, files, one `contents` per
   draft) and `launch.yml` from GitHub on every view, merged PRs included, and every 5 s while a job
   runs. `brand()` is read from GitHub every 5 minutes per process.
2. **Polling instead of events.** 288 rounds a day poll GitHub events (with ETag, the one conditional
   request in the codebase). The UI polls in four places (launch list 5 s, launch page 5 s, Automation
   4 s, the bell 3 min), each re-running every loader of the route, the shell's included.
3. **N+1 loops against APIs.**
   - Metrics: one call per post on dev.to, Bluesky, Mastodon, Instagram, Threads, Hashnode, Brevo
     and Discussions.
   - Per URL: one call on Cloudflare, two on Google, two on Bing. GitHub repo stats are read once per
     launch, not once per repo.
   - The dev.to article list is paginated again for every post.
   - Comments: per post, every 30 minutes, with a **new connector per post**, so `/me` and
     `verify_credentials` repeat for every post, and Bluesky opens a new session per reply.
4. **Unbatched endpoints that batch.** Bluesky `getPosts` takes 25 URIs per call; Cloudflare's
   GraphQL can group by path; GitHub GraphQL `nodes(ids:)`; Meta's batch requests.
5. **Rarely-changing data read again.**
   - `launch.yml`, `pack.json` and `projects.yml` are re-read on every attempt.
   - The index status of URLs that are already indexed is inspected 4×/day.
   - Old launches' metrics are read forever.
   - A fresh `git clone` is made per comment run, even for an immutable tag.
6. **Tokens and sessions** live as long as one connector instance (Search Console, Reddit,
   Bluesky), so they are minted again for every job.
7. **A correctness gap.** The round's publish step and a `publish` job can publish the same launch
   at once. `busy()` is check-then-act, and most channels are only protected by the unique `posts`
   row written *after* the network call.

## The design

### 1. Redis on the server, two roles kept apart

- **`redis-queue`**: BullMQ needs `maxmemory-policy noeviction` and durable writes. It runs with AOF
  (`appendfsync everysec`) on a volume, is backed up with the stack, and is never a cache.
- **`redis-cache`**: `allkeys-lru`, no persistence. Losing it costs only re-reads.

Both are private to the Docker network, with a password, Redis 7 (or Valkey 8). Two instances rather
than two logical databases, because the eviction policy is per instance.

### 2. Queues on BullMQ

- **Mapping.**
  - Each pg-boss queue becomes a BullMQ queue with the same policy.
  - Stately keys become `jobId` dedupe: `round`, `launch:<id>`, `post:<id>`, `account:<id>`.
  - Retries and delays become `attempts` with backoff.
  - Crons become **job schedulers** (`upsertJobScheduler`), sent once whichever process runs them.
- **Scheduled posts** become delayed jobs with `jobId = post:<id>`. Postgres's `posts.scheduled_at`
  stays the truth: every start, and every 10 minutes, the posts table is reconciled with the delayed
  jobs, so a lost Redis rebuilds the schedule.
- **The `jobs` table stays** as the audit and the UI's list, written from BullMQ's events.
- **Per-provider rate limits** come from one queue per provider family for network calls
  (`net:github`, `net:meta`, `net:bluesky`…), each with BullMQ's limiter set from that provider's
  published limits and the remaining quota it reports (below).
- **Correctness first.** Every publish goes through the `publish` queue with `jobId = launch:<id>`;
  the round only *enqueues*. Before any network write, an **attempt row** (outbox) is written in
  Postgres under a per-piece lock (`SELECT … FOR UPDATE`, or a Redis lock with a fencing token
  checked by the row). The provider's idempotency key is sent where one exists. A retry reconciles
  with the network first (`find`, as Reddit does today) when there is no key.
- **Cutover.** pg-boss is drained (no new jobs, running ones finish), then BullMQ starts from the
  Postgres truth: drafted launches, scheduled posts, crons. pg-boss's schema stays read-only for a
  week, then is dropped.
- **Tests**: BullMQ needs a real Redis. Tests use a throwaway `redis-server` started per test run
  (testcontainers, or the binary in CI); the registry keeps PGlite.
- **GitHub Action mode** keeps working without Redis: it has no queue today, and keeps its
  registry-snapshot path.

### 3. GitHub: events in, conditional requests out

- **Public webhook, and only that.** `/api/github/webhook` is reachable from the internet (a
  Cloudflare Tunnel, or a Traefik route that admits that path alone). Everything else stays
  tailnet-only. The HMAC signature is checked before anything else, and deliveries are deduped by
  `X-GitHub-Delivery` in Redis (24 h).
- **Events that replace reads.**
  - `release`, `repository` (made public) and `installation*` as today.
  - `pull_request` (`opened`, `synchronize`, `closed`) on the launches repo refreshes that launch's
    drafts snapshot.
  - `push` to the launches repo's `main` invalidates `brand.yml`, `projects.yml` and the
    `launch.yml`/`pack.json` of the paths it touched.
- **Polling becomes a safety net**: once an hour (configurable), still conditional (ETag), so a
  missed delivery is caught.
- **Drafts in the registry.** A new table (additive migration) holds each draft's path, kind,
  content, blob `sha` and when it was read. It is written:
  - when Shipcast opens the PR;
  - on every edit Shipcast saves;
  - on `pull_request.synchronize`;
  - on the merge.

  The launch page and the API read it; GitHub is never called from a page. **Refresh from GitHub**
  forces a read, compared by `sha`.
- **One HTTP cache for every GitHub GET** (in `GitHubRest`): the body and ETag in `redis-cache`, sent
  back as `If-None-Match`. A 304 does not count against the installation's 5,000/h, and the body is
  known to be current. This covers `contents`, repos, releases, PRs and traffic.
- **Repo stats once per repo per run**, not once per launch. **Clones** of immutable tags are kept by
  `sha` and reused.

### 4. Networks: reuse, batch, read only what can have changed

- **One connector per account per run**, shared by every post of that run. Sessions and tokens (the
  Bluesky session, Reddit, Search Console OAuth) are cached in `redis-cache` until just before they
  expire. Own-identity lookups (`/me`, `verify_credentials`) are cached for a day and invalidated
  when the account is reconnected.
- **Batching.**
  - Bluesky `getPosts`, 25 per call.
  - Cloudflare: one RUM query grouped by `requestPath` for every article.
  - dev.to: one `/articles/me/all` per run, shared.
  - GitHub Discussions: `nodes(ids:)`.
  - Meta: batch requests where the Graph API allows them.
  - Brevo: one statistics call per campaign list.
- **Comments from notification feeds, not per post**:
  - Mastodon `notifications?types[]=mention&since_id=`;
  - Bluesky `listNotifications` with a cursor;
  - Threads/Instagram replies with `since`.

  Each feed is **one call per account** instead of one per post. dev.to has no feed and stays per
  article, on its comment count first.
- **Quotas watched**: every response's rate-limit headers (`X-RateLimit-*`, Meta's
  `X-App-Usage`/`X-Business-Use-Case-Usage`, Bluesky's `ratelimit-*`) update a per-provider counter
  in Redis. The limiter slows down before the limit. A **circuit breaker** pauses a provider after
  repeated 429/5xx and resumes it with backoff, and the app shows it on Channels.

### 5. Metrics every hour, never faster than the source

The owner chose hourly reads for every live post. Each source is read **every hour, or at the
pace its provider updates the number, whichever is slower**. Reading faster costs quota and adds no
truth:

| Source | Cadence | Why |
| --- | --- | --- |
| Bluesky, Mastodon, dev.to, Hashnode, Threads, Instagram, Discussions, Brevo, Cloudflare RUM | hourly, batched | they change within the hour |
| GitHub stars | hourly (one call per repo, conditional) | live number |
| GitHub traffic (views, clones) | daily | GitHub buckets it by day |
| Google Search Console analytics | daily | data lags 2–3 days |
| Google URL inspection | daily until indexed, then weekly | 2,000 inspections/day per property |
| Bing traffic and URL info | daily | daily data |

- Every reading keeps the provider's own "as of" when it gives one, and Shipcast's `checked_at`.
- An hourly run that finds a value unchanged still records that it checked. The page says "checked
  at", so the user always knows how fresh a number is.
- **Open point for the owner**: whether an unchanged value adds a new row (the series as today) or
  only moves `checked_at` on the last one (a smaller table, the same truth). It is decided before
  phase 4.

### 6. A live app without polling

- **One SSE stream** (`/api/events`, behind the session) per tab. The server subscribes to a Redis
  pub/sub channel. Every process (app, `watch`, workers) publishes there when a job changes state,
  a post is recorded, a launch changes or a comment arrives.
- **Events carry what changed**, not the data, for example `{ type: 'launch', id: 6 }`. The client
  invalidates only the matching loader, so a launch's event never reloads the shell.
- **Reconnection** with `Last-Event-ID` and a short replay buffer in Redis (a capped stream). On a
  gap, one full reload.
- **Removed**: the four `setInterval`s. A 60 s safety reload remains only while the stream is down.

### 7. Pages read the registry only

- Loaders query Postgres, in parallel, with indexes for their queries.
- Shared, heavy aggregates (the launch list's numbers, stats) are cached in `redis-cache` under a
  **version key** bumped by the events that change them. That is invalidation, not a TTL guess.
- **A test fails** if a page's server function makes any external call: a fetch guard in the web
  tests.

## Instrumentation and the before/after comparison

**Phase 0 builds it first and changes nothing else.**

- **Every outbound call is counted** by one wrapper around `fetch` in the connectors and the GitHub
  client. It records:
  - provider, endpoint template (no ids or secrets) and method;
  - status, latency and bytes;
  - whether it was a 304, a cache hit or a retry;
  - the rate-limit headers.

  Counts aggregate per hour into an additive Postgres table (`provider_calls`), and raw samples stay
  in Redis for a day.
- **Pages**: a `Server-Timing` header per server function, its duration stored per hour (p50, p95,
  p99). Browser navigation timings come from the reflow-check script run on a schedule against fixed
  pages: the launch list, a launch with 13 drafts, Stats, Comments.
- **Jobs**: duration, attempts, queue wait and failures per queue.
- **Freshness**: for every live post and source, the age of its newest reading. It must stay under
  the cadence above.
- **Correctness checks during both windows**:
  - a daily job compares the registry with every connected account (posts that exist, are deleted or
    edited; follower counts against a direct read);
  - duplicate posts must be 0;
  - missed scheduled posts must be 0.

**The comparison**: 48 h of baseline on the current code (with phase 0 deployed), the refactor, then
48 h after, weekday to weekday. The report is one table per KPI, before, after and change:

| KPI | Target after |
| --- | --- |
| Provider calls per day, total and per provider | −70 % or better, with metrics read *more* often |
| GitHub calls per day; share answered 304 | −80 %; 304s above 60 % |
| `getLaunch` p95 (server) | under 150 ms, 0 external calls |
| Launch page load, 13 drafts (p95) | under 1 s |
| UI requests per open tab per minute, idle | under 1 (today up to ~12 server calls) |
| Comment runs: calls per run | one per account, not per post |
| Metric freshness | every source within its cadence 99 % of the time |
| Duplicates, missed schedules, registry vs network mismatches | 0, 0, 0 |
| Peak quota use per provider | under 50 % of its limit |

## Phases

Each phase ships on its own, verified, deployed by the owner or the server's agent, and
reversible.

0. **Instrument** (above) and add a feature flag per phase. Deploy, then **48 h of baseline**.
1. **Redis in the stack** (both instances, backups, health checks), the HTTP cache for GitHub, the
   connector pool, and token and session caching. No behaviour change visible to the user.
2. **Correctness first**:
   - every publish through the queue;
   - attempt rows (outbox) and per-piece locks;
   - idempotency keys;
   - the round only enqueues.

   It ships before any queue swap, with tests that run the round and a publish job together.
3. **BullMQ replaces pg-boss**:
   - queues, schedulers, delayed posts reconciled with Postgres, per-provider limiters and breakers;
   - drain-and-cutover;
   - the `jobs` table fed from BullMQ events.
4. **GitHub events**:
   - the public webhook route;
   - the drafts snapshot table;
   - `push` and `pull_request` invalidation;
   - polling down to hourly.
5. **Metrics and comments**: hourly batched reads at each source's cadence, notification feeds,
   repo-level stats, the index-status cadence.
6. **Realtime UI**: SSE over Redis pub/sub, the `setInterval`s removed, registry-only loaders, the
   external-call guard test.
7. **48 h after**, the comparison report, and the docs: a new decision document
   (`decisions/redis.md`, superseding parts of `job-queue.md`), plus `web-app.md`, `engine.md`,
   `stats.md`, `publishing.md` and `server.md`.

## Risks and how each is handled

| Risk | Handling |
| --- | --- |
| Redis lost or flushed | Postgres is the truth: schedules, drafts and state are rebuilt from it; caches only cost re-reads |
| A cached value served after it changed | Only validated caches (ETag) or event-invalidated version keys; no blind TTL for data shown as current |
| A missed webhook | The hourly conditional poll, and **Refresh** on the page |
| Duplicate posts during the queue cutover | Phase 2 (outbox, locks, idempotency) ships first; the cutover drains pg-boss before BullMQ starts |
| Provider bans for bursts | Per-provider limiters fed by the headers, breakers, and batching lowering the volume |
| A public webhook endpoint | One path only, HMAC checked first, body size limit, rate limit, delivery dedupe |
| Tests needing Redis | A throwaway Redis per run, with no mock to keep in step |

## Still to settle with the owner

- Unchanged metric values: a new row each hour, or `checked_at` on the last row (section 5).
- The tunnel for the public webhook: Cloudflare Tunnel or a Traefik route (it touches the infra repo
  and the server's agent).
- Who deploys each phase, since the agent does not deploy Shipcast on the server.

## Related

[[decisions/job-queue.md]] · [[web-app.md]] · [[engine.md]] · [[stats.md]] · [[publishing.md]] · [[decisions/github-app.md]] · [[decisions/comment-assistant.md]] · [[plans/after-mvp.md]] · [[status.md]]
