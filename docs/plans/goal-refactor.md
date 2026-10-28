---
created_at: 2026-10-28T10:12:35.430520037Z
updated_at: 2026-10-28T10:12:35.430520037Z
tags:
    - plan
    - goal
    - refactor
    - performance
    - redis
    - architecture
    - scaling
    - handoff
---
# Goal: the performance and architecture refactor, measured before and after

The brief of an autonomous run, agreed with the owner on 2026-10-28. It builds everything in
[performance-refactor.md](performance-refactor.md) (**the plan**): fewer provider calls, a fast app,
Redis (BullMQ, caches, locks, events), a layered architecture with one module per channel and
application services, and Shipcast running as N replicas. It proves the result with numbers taken
before and after.

Order of authority:
1. this brief;
2. the plan;
3. [../../CLAUDE.md](../../CLAUDE.md), the latest handoff and `docs/decisions/`.

Where they are silent, pick the plan's default and write down why. **When a decision is costly to
reverse and nothing here covers it, ask the owner** instead of guessing: the owner asked for that
explicitly. Everything else goes on without waiting.

## Decisions the owner took

| Question | Decision |
| --- | --- |
| Redis | **Everything**: BullMQ replaces pg-boss; Redis also holds caches, quotas, locks, shared ephemeral state and pub/sub. Two instances: `redis-queue` (noeviction, AOF) and `redis-cache` (allkeys-lru, no persistence) |
| Source of truth | **Postgres only.** Redis can be lost and everything is rebuilt from Postgres. A cached value is shown only when validated (ETag) or invalidated by an event; every number keeps when it was read |
| Metrics | **Every hour, always**, for every live post, never faster than the provider updates the number (cadence table in the plan) |
| Unchanged metric values | **Update `checked_at` on the last reading**; a new row only when a value changes |
| Webhooks | **Only `/api/github/webhook` is public**, through the server's existing **Cloudflare Tunnel** (edge stack, Traefik entrypoint `public`); HMAC is checked first. Polling becomes hourly and conditional |
| Measurement | **48 h of baseline before, 48 h after**, weekday to weekday |
| Scale target | **The owner's installation with N replicas**, with no multi-tenant model |
| Secrets | **An encrypted `secrets` table in Postgres** (envelope encryption with `SHIPCAST_SECRETS_KEY`, atomic per-row writes, a version column); the keychain stays for a local install |
| Processes | **web + worker + heavy worker**, each scaled on its own |
| Refactor approach | **Incremental, protected by tests**: characterisation tests before moving code, one piece at a time, behind a flag where it changes behaviour |
| Deploys | **This run deploys each verified phase to `apps-1` itself**, over `tailscale ssh yeyo@apps-1`. Never on the owner's laptop |
| Measurement windows | **Keep working during them** on refactors that change no deployed behaviour; deploy nothing that would alter a window until it ends |

## Facts to start from (2026-10-28)

- **Production runs on `apps-1`**, from the infra repo `yeyo11/infra`:
  - its checkout is `~/Escritorio/infra`; the stack is `stacks/shipcast`, the tunnel is in
    `stacks/edge`;
  - the image is `ghcr.io/yeyo11/shipcast:latest`, built by CI from `main`;
  - Postgres 17 is in the stack;
  - TLS is Traefik's, and the server is tailnet-only today;
  - read `stacks/shipcast/README.md`, the infra repo's own README and conventions, and Shipcast's
    `docs/server.md`.
- **No claudio on the server**: the AI there is the Anthropic API or an OpenAI-compatible server,
  chosen in the app's AI settings. claudio stays supported for local installs. The heavy worker must
  not depend on a claudio sidecar; where claudio is used, its workspace must be per job.
- **The owner's laptop never runs Shipcast**: no `systemctl --user` units and no `pnpm app`. Its old
  Tailscale Serve forward was removed on 2026-10-28.
- **Measured** before any of this (the stop-gap commits of 2026-10-28 were not deployed yet):
  - the launch page loaded in 5.2 s;
  - `getLaunch` took 4.7 s;
  - in 24 h: 280 rounds, 47 comment runs, 4 metric runs (39 s each);
  - provider calls were not counted.
- **What the audits found** (provider calls, correctness, code structure, horizontal-scale hazards,
  with file references) is summarised in the plan. Treat it as a map and verify each point in the
  code before changing it.
- **Live work not to disturb**: the REA article's launch (launch 6) still had scheduled pieces on
  2026-10-28 (Instagram 18:00 Madrid, the newsletter on Thursday 29th at 09:00). Before every
  deploy, list the scheduled posts and keep **at least 20 minutes clear** of any of them.

## Rules for the run

- **How work is done** (as in the handoff):
  - verify only through Sluice's `verify`, never with test commands in the shell;
  - documents only through pando's `kb_add_document`. It writes into the main checkout's `docs/`:
    copy the file into your worktree, then restore or remove it in the main checkout, which stays on
    `main` and clean;
  - stage files by name, never `git add -A`;
  - Conventional Commits with the `Co-Authored-By` line;
  - work in your own worktree from `origin/main` and push straight to `origin main`, with no pull
    requests;
  - commit after every point, so a session limit loses nothing;
  - sub-agents each in their own worktree and branch, integrated by the lead.
- **Code quality is a requirement, not a nice-to-have.**
  - SOLID throughout.
  - One implementation of each use case and each rule, behind the application services; entry points
    stay thin.
  - No duplicated logic or constants.
  - The dependency rules checked in CI from phase 1 on.
  - Every new module comes with tests.
  - A phase is not done while it leaves a duplicate or a bypass of a service behind.
- **Deploy each verified phase**:
  1. check the scheduled posts (the 20-minute rule);
  2. `pg_dump -Fc` of the registry on the server, kept, and a copy into the laptop's
     `~/Escritorio/shipcast/data/backups/`;
  3. note the table counts;
  4. wait for the CI image of the commit;
  5. deploy the stack as the infra repo documents;
  6. check `https://shipcast.josegarrido.dev/api/health` (and `/readyz` once it exists);
  7. compare the counts;
  8. watch the next round and the next scheduled post.

  If anything is off, roll back to the previous image and stop to report.
- **Migrations are additive only**; data is only ever copied, verified and then switched. **The
  owner's data is never lost.**
- **Infra changes** (Redis, PgBouncer, the tunnel route, new services, health checks) are commits to
  `yeyo11/infra`, following its conventions. Secrets go on the server's `.env` or in the encrypted
  table, never in a repository.
- **Real accounts**: this run publishes nothing new. Any test that touches a network uses a preview
  with fake networks (`SHIPCAST_PREVIEW_FAKE_NETWORKS=1`, its own throwaway Postgres, never TLS).
  Scheduled pieces already in production must go out exactly once, on time.
- **Secrets** never appear in a repository, a log, a commit message, a metric label or a screenshot.
- **Disk**: check `df -h` before builds and Docker work; stop and report under 5 GB free.

## Phases

The plan's phases, in its order. Each ends with its exit criteria met, verified and deployed (except
where a measurement window forbids deploying).

0. **Instrument, then the baseline.**
   - The outbound-call counter (`provider_calls`), `Server-Timing` and page timings, job metrics, the
     freshness and correctness checks, and a feature flag per later phase.
   - Deploy it (it also ships the undeployed stop-gaps of 2026-10-28; record that).
   - **Start the 48 h baseline window**, and keep the instrumentation unchanged during it.

   *Exit*: one full day of numbers is visible per provider, endpoint, page and job; the correctness
   checks run green.
1. **Foundations** (can proceed during the baseline; deploy nothing behavioural until it ends):
   - the shared test kit and characterisation tests (publishing, editing, scheduling, comments,
     metrics);
   - `HttpClient` (timeouts, retries honouring `Retry-After`, quota headers, instrumentation, ETag
     hook), `ShipcastError`, the structured logger;
   - the domain helpers de-duplicated;
   - the dependency rules in CI.

   *Exit*: no duplicated helper left, and the rules pass.
2. **Correctness.** `PublishingService`; the piece state machine with attempt rows and per-piece
   locks; idempotency keys; the round only enqueues. *Exit*: a test runs the round and a publish job
   at the same moment and gets exactly one post per piece.
3. **Channel plugins and services.** `ChannelDefinition`, the capability interfaces and contract
   tests, migrated one channel at a time; the application services; entry points thinned.
   *Exit*: adding a fake network in a test takes one module and one registry line; the channel maps,
   retry, multi-edit, notify and error-mapping duplicates are gone; the drift found by the audit
   (Threads' icon, `DRAFT_CHANNELS`, `draftPrefill` file names) is fixed by construction.
4. **Registry split** into repositories behind a facade, then the facade removed. *Exit*: no consumer
   depends on the whole registry.
5. **Scale-out state.**
   - The encrypted `secrets` table, migrated with a read-back verification and the old store kept
     read-only until verified.
   - A lock around token refreshes.
   - Redis for OAuth state, console links and the limiter (with a trusted proxy header).
   - The `settings.changed` event, `/livez` and `/readyz`, graceful shutdown, PgBouncer.

   *Exit*: two web replicas side by side pass sign-in, OAuth connect, Settings saves and token
   refreshes.
6. **Redis and BullMQ, and the process split.**
   - Both Redis instances in the stack; BullMQ replaces pg-boss after draining it.
   - Delayed posts reconciled with Postgres; per-provider limiters and breakers.
   - The web / worker / heavy-worker processes, with per-job workspaces.

   *Exit*: a worker can be killed mid-job and a Redis restarted with no duplicate and no lost job;
   the schedule is rebuilt from Postgres.
7. **GitHub by events.** The webhook route through the Cloudflare Tunnel; the drafts snapshot table;
   `push` and `pull_request` invalidation; the ETag cache on every GitHub GET; polling hourly.
   *Exit*: no page calls GitHub; a test fails if one does.
8. **Metrics and comments.** Hourly batched reads at each source's cadence; `checked_at` on unchanged
   values; notification feeds for comments; repo-level stats; the index-status cadence. *Exit*:
   freshness within cadence; comments read with one call per account.
9. **Realtime UI.** SSE over Redis pub/sub; the four `setInterval`s removed; registry-only loaders.
   *Exit*: an idle open tab makes under one request per minute.
10. **Measure and prove.**
    - The 48 h after-window.
    - Then **the scale test**: 3 web + 2 worker + 1 heavy replicas for 48 h.
    - **The chaos tests**: kill a worker mid-publish, restart Redis, roll a deploy.
    - **The comparison report**: one table per KPI of the plan, with before, after and change, from
      the stored numbers rather than estimates.
    - The docs: `decisions/redis.md`, `decisions/architecture.md`, and the updates to `web-app.md`,
      `engine.md`, `stats.md`, `publishing.md`, `server.md`, `accounts.md` and the plan's Outcome.
    - A new handoff.

## Done when

- [ ] every phase's exit criteria met, each phase deployed and verified on `apps-1`
- [ ] the before/after report with real numbers for every KPI in the plan, and the targets met or
      each miss explained
- [ ] the scale and chaos tests passed with 0 duplicates, 0 missed schedules and 0 registry-vs-network
      mismatches
- [ ] no duplicated logic, the dependency rules enforced in CI, every channel defined in one module
- [ ] the docs, the decisions and a handoff written
- [ ] a final report to the owner **in Spanish**: what changed, the numbers, what is left and why

## What the owner may be asked during the run

Only what is costly to reverse and not covered above. For example:
- a provider whose terms or limits make the plan's cadence impossible;
- a migration that cannot be made additive;
- an infra change outside the Shipcast stack and the edge route.

Ask, with the options and a recommendation; meanwhile continue with work that does not depend on
the answer.

## Related

[[plans/performance-refactor.md]] · [[plans/goal-v0.2.md]] · [[decisions/job-queue.md]] · [[server.md]] · [[web-app.md]] · [[engine.md]] · [[status.md]]
