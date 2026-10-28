---
created_at: 2026-10-28T10:56:57.542623147Z
updated_at: 2026-10-28T12:00:32.654105637Z
tags:
    - plan
    - goal
    - refactor
    - performance
    - redis
    - architecture
    - scaling
    - handoff
    - youtube
---
# Goal: the performance and architecture refactor, YouTube on it, and the v0.2 run closed

The brief of an autonomous run, agreed with the owner on 2026-10-28. It does three things:

- It builds everything in [performance-refactor.md](performance-refactor.md) (**the plan**): fewer
  provider calls, a fast app, Redis (BullMQ, caches, locks, events), a layered architecture with one
  module per channel and application services, and Shipcast running as N replicas. It proves the
  result with numbers taken before and after.
- It adds **YouTube as the first new network built on the channel modules**, the proof that a network
  costs one module.
- It **closes what the v0.2 run left open** ([goal-v0.2.md](goal-v0.2.md)). That run stopped after
  releasing v0.2.0 on 2026-10-27, most likely at a Claude usage limit, and was never resumed.

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
| Deploys | **Continuous deployment** (corrected on 2026-10-28). Every push to Shipcast's `main` runs `CI → Image → Deploy` and lands on `apps-1` by itself (`.github/workflows/deploy.yml`, infra decision `0003-continuous-deployment.md`). **Pushing to `main` is deploying.** The run watches each `Deploy` workflow to the end and checks production after it. A hand-run `deploy-stack` over SSH is only for a rollback or an emergency, and then the run tells the owner. Never on the owner's laptop |
| Measurement windows | **Keep working during them, on branches.** Nothing reaches `main` while a window runs, because any push deploys and restarts the app, which disturbs the measurement. The exception is a production fix that cannot wait: it restarts the window and is reported. Work done during a window is merged to `main` when the window ends |
| YouTube | **Built in this run, right after the channel modules (phase 3b)**, as the first new network on them |
| YouTube on the real channel | **Allowed, private only**: upload v0.2.0's two videos privately (Google keeps an unaudited project's uploads private anyway), edit one's description, delete nothing |

## Facts to start from (2026-10-28)

- **Production runs on `apps-1`**, from the infra repo `yeyo11/infra`:
  - its checkout is `~/Escritorio/infra`; the stack is `stacks/shipcast`, the tunnel is in
    `stacks/edge`;
  - the image is `ghcr.io/yeyo11/shipcast:sha-<12>`, built by CI from `main` and deployed by the
    `Deploy` workflow over Tailscale (`tag:ci`, the `deploy` user, which can only run `deploy-stack`);
  - Postgres 17 is in the stack;
  - TLS is Traefik's, and the server is tailnet-only today;
  - read `stacks/shipcast/README.md`, the infra repo's own README, `AGENTS.md` (its safety rules) and
    `docs/decisions/0003-continuous-deployment.md`, and Shipcast's `docs/server.md`.
- **No claudio on the server**: the AI there is the Anthropic API or an OpenAI-compatible server,
  chosen in the app's AI settings. claudio stays supported for local installs. The heavy worker must
  not depend on a claudio sidecar; where claudio is used, its workspace must be per job.
- **The owner's laptop never runs Shipcast**: no `systemctl --user` units and no `pnpm app`. Its old
  Tailscale Serve forward was removed on 2026-10-28.
- **Measured** before any of this, before the stop-gap commits of 2026-10-28 (up to `7ed9732`) were
  deployed:
  - the launch page loaded in 5.2 s;
  - `getLaunch` took 4.7 s;
  - in 24 h: 280 rounds, 47 comment runs, 4 metric runs (39 s each);
  - provider calls were not counted.

  Those stop-gaps were deployed by CI on 2026-10-28, with phase 0's telemetry (`2ea5497`, `1be7c00`).
- **What the audits found** (provider calls, correctness, code structure, horizontal-scale hazards,
  with file references) is summarised in the plan. Treat it as a map and verify each point in the
  code before changing it.
- **Live work not to disturb**: the REA article's launch (launch 6) still had scheduled pieces on
  2026-10-28 (Instagram 18:00 Madrid, the newsletter on Thursday 29th at 09:00). Before every push to
  `main`, list the scheduled posts and keep **at least 20 minutes clear** of any of them.
- **YouTube's token**: the owner prepared `~/Escritorio/shipcast/data/youtube-oauth.json`.
  - It is on the laptop, mode 600, created 2026-10-27 18:04, with `client_id`, `client_secret` and
    `refresh_token`.
  - Whether the Google consent screen is *In production* or *Testing* is not known.
  - In *Testing*, the refresh token expires 7 days after it was made, around **2026-11-03**. Use it
    before then, or ask the owner to publish the consent screen and make a new one.

## Rules for the run

- **How work is done** (as in the handoff):
  - verify only through Sluice's `verify`, never with test commands in the shell;
  - documents only through pando's `kb_add_document`. It writes into the main checkout's `docs/`:
    copy the file into your worktree, then restore or remove it in the main checkout, which stays on
    `main` and clean;
  - stage files by name, never `git add -A`;
  - Conventional Commits with the `Co-Authored-By` line;
  - work in your own worktree from `origin/main`;
  - outside a measurement window, push straight to `origin main` (no pull requests), knowing that it
    deploys; inside a window, push to a branch only;
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
- **Ship each verified phase by pushing to `main`**, since that deploys it:
  1. check the scheduled posts: **no push within 20 minutes of one**;
  2. `pg_dump -Fc` of the registry on the server, kept, and a copy into the laptop's
     `~/Escritorio/shipcast/data/backups/`;
  3. note the table counts;
  4. push, then follow the run's `CI`, `Image` and `Deploy` workflows to the end;
  5. check that the server runs the commit's image (`sha-<12 chars>`);
  6. check `https://shipcast.josegarrido.dev/api/health` (and `/readyz` once it exists);
  7. compare the counts;
  8. watch the next round and the next scheduled post.

  If anything is off, roll back by pushing a revert (CI deploys it). A hand-run
  `deploy-stack shipcast sha-<previous>` is only for an emergency the revert cannot wait for; tell the
  owner, then stop to report.
- **Migrations are additive only**; data is only ever copied, verified and then switched. **The
  owner's data is never lost.**
- **Infra changes** (Redis, PgBouncer, the tunnel route, new services, health checks) are commits to
  `yeyo11/infra`, following its conventions and safety rules. Secrets go on the server's `.env` or in
  the encrypted table, never in a repository.
- **Real accounts**: this run publishes nothing new, **except v0.2.0's two private YouTube videos**
  (phase 3b). Any other test that touches a network uses a preview with fake networks
  (`SHIPCAST_PREVIEW_FAKE_NETWORKS=1`, its own throwaway Postgres, never TLS). Scheduled pieces already
  in production must go out exactly once, on time.
- **Secrets** never appear in a repository, a log, a commit message, a metric label or a screenshot.
  The YouTube token file moves to the server only through the app's own connection path, then is
  deleted from the laptop, and the report says so.
- **Disk**: check `df -h` before builds, video rendering and Docker work; stop and report under 5 GB
  free.

## Phases

The plan's phases, in its order, with YouTube after the channel modules. Each ends with its exit
criteria met, verified and deployed (except where a measurement window forbids deploying).

0. **Instrument, then the baseline.**
   - The outbound-call counter (`provider_calls`), `Server-Timing` and page timings, job metrics, the
     freshness and correctness checks, and a feature flag per later phase.
   - Deploy it (it also ships the stop-gaps of 2026-10-28; record that).
   - **Start the 48 h baseline window**, and keep the instrumentation unchanged during it. Record the
     window's start (the deploy's time) and its end in the docs, so the after-window compares the
     same hours.

   *Exit*: one full day of numbers is visible per provider, endpoint, page and job; the correctness
   checks run green.
1. **Foundations** (proceeds during the baseline **on branches**, merged to `main` once the window
   ends):
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
3b. **YouTube, the first network on the channel modules.** It is built as one `ChannelDefinition`
    module plus its connector and its video renderer, with no edits scattered elsewhere; count and
    report how many files outside the module had to change. The scope is milestone 6 of
    [goal-v0.2.md](goal-v0.2.md), adapted to the new architecture:
    - **The decision first**: `decisions/youtube.md`. It publishes itself, never a draft for the
      owner to post ([decisions/automatic-channels-only.md](../decisions/automatic-channels-only.md)).
    - **Two videos per launch**, rendered on the heavy worker with ffmpeg from what the launch has
      (the demo, screenshots, cover, the pack's texts), in the brand's look, with no voice:
      - a **Short** (1080x1920, under 60 s);
      - a **horizontal video** (1920x1080, 1 to 3 min), with burned-in subtitles **and** an SRT
        uploaded as captions, in the launch's languages.

      Music only if a clearly licensed track is bundled. An article without a demo gets both from
      its screenshots and texts. The server's image must carry ffmpeg; check it.
    - **The content pack's `youtube` piece**: for each video a title (≤ 100), a description (≤ 5,000,
      the article first, chapters for the horizontal one), tags and a language, under the truth rule.
    - **The connector**, built on `HttpClient`:
      - resumable upload, captions, a custom thumbnail when the channel is verified (if refused,
        record why and go on);
      - edit and delete;
      - numbers (batched `videos.list`) and the channel's snapshot;
      - comments read and answered.

      Its **quota** (10,000 units a day, an upload far more than a read) goes into the per-provider
      limiter and is shown in the app when spent.
    - **Privacy**: request `public`. When Google keeps a video `private` (an unaudited project),
      record it and show "private until Google audits the project". That is not a failure.
    - **Connecting**: the OAuth flow at `/auth/youtube/callback` and the client in Settings, like
      Reddit and LinkedIn. Import `data/youtube-oauth.json` once, through that path, into the server's
      secret store (whichever store is current; phase 5's migration carries it), then delete the
      file.
    - **The real test (allowed, private only)**: turn `youtube` on in Shipcast's own `launch.yml` and
      publish **v0.2.0's two videos privately** through the launch's normal path. Edit one's
      description through Shipcast, read its numbers, delete nothing. If the token has expired, stop
      short of real uploads and add reconnecting to the owner's steps.
    - **The audit form**: `docs/plans/youtube-audit.md` with everything Google's YouTube API audit
      asks (what the app does, the scopes and why, the screens, the data kept, the privacy policy
      address), and the blog's privacy page updated for YouTube data. The owner sends it at the end.

    *Exit*: contract tests green for YouTube; v0.2.0's two private videos up and edited, or the reason
    they are not.
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
   - The `Deploy` workflow and the infra stack updated to roll out the new services, so a deploy
     still never runs two engines' rounds at once.

   *Exit*: a worker can be killed mid-job and a Redis restarted with no duplicate and no lost job;
   the schedule is rebuilt from Postgres.
7. **GitHub by events.** The webhook route through the Cloudflare Tunnel; the drafts snapshot table;
   `push` and `pull_request` invalidation; the ETag cache on every GitHub GET; polling hourly.
   *Exit*: no page calls GitHub; a test fails if one does.
8. **Metrics and comments.** Hourly batched reads at each source's cadence, YouTube included;
   `checked_at` on unchanged values; notification feeds for comments; repo-level stats; the
   index-status cadence. *Exit*: freshness within cadence; comments read with one call per account.
9. **Realtime UI.** SSE over Redis pub/sub; the four `setInterval`s removed; registry-only loaders.
   *Exit*: an idle open tab makes under one request per minute.
10. **Measure and prove.**
    - The 48 h after-window.
    - Then **the scale test**: 3 web + 2 worker + 1 heavy replicas for 48 h.
    - **The chaos tests**: kill a worker mid-publish, restart Redis, roll a deploy.
    - **The comparison report**: one table per KPI of the plan, with before, after and change, from
      the stored numbers rather than estimates.
    - The docs (below).

## Also in this run: what the v0.2 run left open

Done alongside the phases, where they fit:

- **Milestone 1 of goal-v0.2, the two items with no trace**:
  - the cause of "The queue no longer has this job", seen once in an Automation round. With BullMQ it
    may disappear: say so with evidence, or fix it;
  - the production check at 320, 390 and 1280 px (assistant history and phone bubble, the tour, date
    and time pickers, Channels, Comments' filters, launch cards) with
    `apps/web/scripts/reflow-check.ts`, read-only, before and after phase 9.
- **Milestone 2 of goal-v0.2**: go through milestones 1 to 8 of
  [goal-after-mvp.md](goal-after-mvp.md) point by point against the code and production. Write the
  table (item, state, evidence) into that goal's **Outcome**; fix what fits, list what does not.
- **Milestone 5 of goal-v0.2 and this run's own docs**:
  - `status.md`, which still described the app running on the owner's laptop (last updated
    2026-10-25), rewritten for the server, continuous deployment, v0.2.0, YouTube and this refactor;
  - the roadmap ticks in [after-mvp.md](after-mvp.md);
  - `decisions/redis.md`, `decisions/architecture.md` and `decisions/youtube.md`;
  - updates to `web-app.md`, `engine.md`, `stats.md`, `publishing.md`, `server.md`, `accounts.md`
    and `content-pack.md`;
  - the plan's Outcome, the Outcome of goal-v0.2 (what it did, and that this run finished it), and a
    new handoff.
- **The final test of v0.2 runs on the REA article's launch (launch 6)**, by the owner's decision of
  2026-10-28, not on v0.2.0:
  - check that its last scheduled pieces went out (the newsletter on 2026-10-29);
  - a comment answered through the comment assistant once one arrives (none had arrived by
    2026-10-28);
  - the numbers in Stats;
  - delete proven end to end on a preview with fake networks.

## Done when

- [ ] every phase's exit criteria met, each phase deployed (through CI) and verified on `apps-1`
- [ ] YouTube built as one channel module, v0.2.0's two videos up privately and edited (or why not),
      the audit form prepared
- [ ] the before/after report with real numbers for every KPI in the plan, and the targets met or
      each miss explained
- [ ] the scale and chaos tests passed with 0 duplicates, 0 missed schedules and 0 registry-vs-network
      mismatches
- [ ] no duplicated logic, the dependency rules enforced in CI, every channel defined in one module
- [ ] the v0.2 leftovers above closed or listed with why
- [ ] the docs, the decisions, the Outcomes and a handoff written
- [ ] a final report to the owner **in Spanish**: what changed, the numbers, what is left and why,
      ending with the owner's steps below

## What the owner may be asked during the run

Only what is costly to reverse and not covered above. For example:
- a provider whose terms or limits make the plan's cadence impossible;
- a migration that cannot be made additive;
- an infra change outside the Shipcast stack and the edge route;
- YouTube's consent screen if the token has expired.

Ask, with the options and a recommendation; meanwhile continue with work that does not depend on
the answer.

## What the owner does after the run

The run prepares each of these and ends its report with them:

1. **Request YouTube's API audit** with `docs/plans/youtube-audit.md`; until Google answers, uploads
   stay private.
2. **Publish the CLI on npm** (`@yeyo11/shipcast`, `npm publish --access public` from the prepared
   package) and **list the Action on the GitHub Marketplace**. Both were left from the v0.2 run.
3. **Review any design change** the run made (the video look included), on a preview.

## Related

[[plans/performance-refactor.md]] · [[plans/goal-v0.2.md]] · [[plans/goal-after-mvp.md]] · [[plans/after-mvp.md]] · [[decisions/job-queue.md]] · [[decisions/automatic-channels-only.md]] · [[server.md]] · [[web-app.md]] · [[engine.md]] · [[status.md]]
