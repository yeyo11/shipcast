---
created_at: 2026-11-06T07:39:04.453445752Z
updated_at: 2026-11-06T07:39:04.453445752Z
tags:
    - status
    - roadmap
    - phase-0
    - phase-1
    - meta
---
# Status

**Production runs on the server `apps-1` since 2026-10-27, and since 2026-10-29 it runs the whole
performance and architecture refactor**: three processes (`web`, `worker`, `heavy`), BullMQ on Redis,
PgBouncer, the encrypted secrets table, GitHub by events through a public webhook host, and every AI
task on the AI task runner with Shipcast's own headless claudio. Every flag of the refactor was turned
on ([server.md](server.md#what-production-runs-2026-10-29)); the same day `ai-runner` was retired, its
runner the only AI path, and the global AI budget went with the first AI layer
([decisions/ai-layer.md](decisions/ai-layer.md)). On 2026-11-01 the other seven were retired: each new
path is the only one, and Redis is required by the split processes ([server.md](server.md#the-flags)). Shipcast v0.2.0 was released on 2026-10-27.

**v0.3.0 was released and launched on 2026-11-03; v0.3.1 is prepared (2026-11-06) and waits for the owner to
publish the release**: every package is at `0.3.1`, the [CHANGELOG](../CHANGELOG.md) has its entry, and publishing the
GitHub release publishes `@yeyo11/shipcast` to npm (`.github/workflows/npm-publish.yml`, whose tag must match
`apps/cli`'s version). The GitHub Action is at v1.3.1 (`@v1`).

**Every Meta login and the Facebook channel are built and deployed (2026-11-05 and 2026-11-06), and
wait for the owner's tests against Meta** ([decisions/meta-logins.md](decisions/meta-logins.md)):
Instagram connects through Instagram Login, Unified Login or Facebook Login for Business, whichever
the owner's Meta app has, and a Facebook Page is a channel Shipcast publishes on. Proven with fakes and
in a preview only: no call to Meta was made. The owner's test list, with the spike's three open
questions, is in [plans/goal-meta-logins.md](plans/goal-meta-logins.md#what-the-owner-does-after-the-run).

**The MVP closed on 2026-10-25: phases 0 to 5 done, and Shipcast v0.1.0 was launched with Shipcast,
from its app.** The same day the [goal to finish Shipcast](plans/goal-finish.md) built the web app,
accounts per brand, the phase 5 channels and what the MVP had left
([its outcome](plans/goal-finish.md#outcome-2026-10-25)). Closing the MVP is
[its own plan](plans/mvp-close.md).

## Every Meta login (2026-11-05)

A new Meta app can no longer set up Instagram Login, so nobody with one could connect Instagram. The
owner asked for every login Meta offers ([plans/meta-logins.md](plans/meta-logins.md)), and an
autonomous run built it by its [implementation plan](plans/meta-logins-implementation.md#outcome).

- **Built**: sign-in variants chosen in Settings (`instagramLogin`), the shared Meta app and its
  configuration ids, several accounts per sign-in, Meta's flows in `packages/connectors/src/meta/`,
  the Instagram connector on `graph.instagram.com` or `graph.facebook.com` by the account's login, and
  the `facebook` channel: a link post on a Page, edited, deleted, its comments answered, its numbers
  read hourly ([accounts.md](accounts.md#oauth-flows), [publishing.md](publishing.md#facebook)).
  Accounts are now matched on reconnection by their network id.
- **Deployed**: pushed to `main` in three steps (after Unified Login, after Facebook Login for
  Instagram, after the Facebook channel), each deploy healthy; the final review's fixes and these
  documents are on `main` too. No migration.
- **The owner's existing Instagram account** stays on Instagram Login, untouched; tests pin its host,
  calls and refresh.
- **Pending, the owner's**: a Meta app with Unified Login to connect Instagram; a Facebook Login for
  Business configuration to connect a Page and publish, edit, delete and read a test post; optionally
  Facebook Login for an Instagram account linked to a Page. Those tests answer the spike the run
  skipped (does Instagram on `graph.facebook.com` take a Page token; which Page metrics Meta
  accepts; does a Unified configuration's token never expire).
- **Known limit**: Action mode and the `.env` import carry only Instagram Login tokens.

## Production (2026-10-29)

- **Where**: `apps-1` (yeyo11/infra, `stacks/shipcast`), the app on the tailnet at
  `https://shipcast.josegarrido.dev`, TLS by Traefik. A push to `main` deploys: CI, then the image,
  then the deploy ([server.md](server.md)).
- **The refactor's deploys** ([plans/performance-refactor.md](plans/performance-refactor.md)), each
  after a `pg_dump` kept on the server and copied to the laptop, the table counts compared, and no
  scheduled post due within 20 minutes: `a6db7c4` (the Telegram notifier fix), `8bab777` (the whole
  refactor with every flag off; migrations 0013 to 0016, tried first on a restored copy of
  production), then the flags one at a time: `publishing-service`, `batched-metrics`, `realtime-ui`,
  `redis-state`, `bullmq`, `secrets-table`, `ai-runner`, `github-events`.
- **After the flags** (2026-10-29, up to `b72cf0b`, deployed by CI at 16:13 UTC; the deploy of
  `9d68d49` before it had failed):
  - **The first AI layer is gone**: the AI task runner is the only AI path; `ai-runner` is retired
    (an environment that still lists it starts as before, the name ignored), and compose no longer
    mounts `./workspace` into claudio ([claudio.md](claudio.md)).
  - **No global AI budget**: `SHIPCAST_MAX_BUDGET_USD` and the `ai-budget-usd` setting are gone; a
    task's limit is the owner's in the AI settings, else the task's default. A stored row and the
    variable left in an env are ignored ([engine.md](engine.md#the-ai)).
  - **Cold start**: the date, Base UI and motion libraries are bundled into the server build, and a
    page-serving process warms its route chunks at boot, answering `/readyz` 503 `warming` until
    done (60 s at most); workers warm nothing. A launch page's first visit after a restart took 11 to
    15 s before ([server.md](server.md#health-and-shutdown), [web-app.md](web-app.md#how-it-is-built)).
  - **Freshness** counts only the pieces whose channel reads numbers for them (`readsMetrics`), so
    Instagram's story and comment no longer count as never read; production had shown 0.76 with
    every readable piece read within the hour ([measurement.md](measurement.md#the-checks)).
  - **The migration lock** never goes through PgBouncer and is released by hand (`3797ae7`), after a
    lock left on a pooled connection kept `worker` and `heavy` from starting on 2026-10-29
    ([decisions/migration-lock.md](decisions/migration-lock.md)).
  - A browser leaving its event stream no longer logs an `AbortError`, and `scripts/measure.ts`
    opens the registry through `connectRepositories`, so the before/after report runs on the server.
- **The stack**: `web` (rolled out with docker-rollout), `worker` and `heavy`; Postgres behind
  PgBouncer in transaction pooling; `redis-queue` (AOF, `noeviction`) and `redis-cache` (LRU); the
  secrets in the encrypted `secrets` table (22 keys moved from the encrypted file); Shipcast's own
  headless claudio 0.11.0 with a daily spend cap ([claudio.md](claudio.md)); GitHub's webhook on the
  public host `shipcast-hooks.josegarrido.dev`, which forwards that one route only; `heavy`'s probe
  timing `web`'s pages.
- **Measurement** ([measurement.md](measurement.md)): the baseline ran from 2026-10-28T12:00Z to
  2026-10-29T08:00Z, 20 hours, and the after-window from 2026-10-29T13:00Z to 15:00Z, 2 hours with
  every flag on, when the owner stopped the measurement. The before/after report, with its caveats,
  is [plans/refactor-report.md](plans/refactor-report.md).
- **Checked on production**: the reflow check at 320, 390 and 1280 px found no horizontal overflow;
  its small-target and accessibility findings were fixed in `a2e31b0`. The date picker's days stay
  about 38 px at 320 px by the owner's choice, to be revisited.

## What exists

- **The repository** [github.com/yeyo11/shipcast](https://github.com/yeyo11/shipcast): MIT, pnpm
  monorepo on TypeScript and Node 24.22.1 (pinned in `.nvmrc`, pnpm's `useNodeVersion` and `engines`),
  CI on main, Sluice gates for `typecheck` and `test`, pando as the knowledge base
  ([knowledge-base.md](knowledge-base.md)). Until a stable version, changes go straight to `main`,
  without pull requests ([decisions/main-until-mvp.md](decisions/main-until-mvp.md)). The README says
  what Shipcast does today, with a demo of the app (`docs/media/tour.gif`). Releases v0.1.0 and v0.2.0
  on GitHub, v0.3.0 prepared; the CLI on npm as `@yeyo11/shipcast` (`npx @yeyo11/shipcast init`).
- **`packages/schema`**: `launch.yml` ([launch-yml.md](launch-yml.md)), `brand.yml`
  ([brands.md](brands.md)), `projects.yml` (the project looks) and the content pack
  ([content-pack.md](content-pack.md)), with line-aware YAML errors and the pack's draft-07 JSON Schema.
- **`packages/engine`** ([engine.md](engine.md)): the registry on PostgreSQL through Drizzle
  ([decisions/postgres.md](decisions/postgres.md)), split into repositories; detection from GitHub's
  events; the pre-flight check; the AI task runner with claudio, the Anthropic API or an
  OpenAI-compatible server as providers; drafting to a pull request or straight onto main, articles
  written in the app, reviewing and approving, publishing once per channel through one module per
  channel ([decisions/architecture.md](decisions/architecture.md),
  [decisions/publishing-state.md](decisions/publishing-state.md)), the newsletter and metrics
  ([publishing.md](publishing.md)).
- **`packages/connectors`**: dev.to, Hashnode, Bluesky, Mastodon, Instagram (carousel, story, comment;
  on either of Meta's hosts), Telegram, Discord and Brevo, the Cloudflare Web Analytics, Search
  Console and Bing Webmaster readers, and connectors for Threads, LinkedIn, Reddit, YouTube, GitHub
  Discussions and Facebook Pages; a `check()` per connector, and the OAuth flows, Meta's three among
  them.
- **`packages/assets`**: the launch image, the Instagram carousel and story, generated covers, and the
  demo as a video, in the blog's editorial identity.
- **`packages/capture`**: screenshots and the demo GIF of a deployed project, through Playwright and
  ffmpeg.
- **`packages/runtime`** ([accounts.md](accounts.md)): configuration, the secret stores (keychain,
  encrypted file, encrypted table), accounts per brand, the network catalog, process roles, the job
  queue (BullMQ with Redis, pg-boss for a single process without it), Redis, the flags, the shared round, the GitHub webhook handling and the
  automation settings, shared by the CLI and the app.
- **`packages/mcp`** ([mcp.md](mcp.md)): the MCP server over the REST API, one tool per `/api/v1`
  operation (69), and since 2026-11-01 one route per page action too, the attention list, accounts,
  drafts, repos, automation and AI settings included; what stays in the app (credentials, tokens,
  onboarding) has its written reason. Two tests keep the parity
  ([decisions/mcp-parity.md](decisions/mcp-parity.md)).
- **`apps/cli`**: `launch` (after the pre-flight), `preflight`, `watch`, `publish [--retry]`,
  `metrics`, `status`, `secrets migrate`.
- **`apps/web`** ([web-app.md](web-app.md), [decisions/web-app-stack.md](decisions/web-app-stack.md)):
  TanStack Start in Cartel; GitHub sign-in limited to the owner, signed sessions, same-origin checks;
  Launches, a launch's review (edit, approve, retry), Launch a repo, Write, Channels, Stats, Comments,
  Settings (General, AI, Automation, API); pages updated over server-sent events; outcomes and errors
  as toasts in Cartel, explained for a person. It replaced the CLI's dashboard.

## Services

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches), the blog at
  <https://josegarrido.dev> ([launches-repo.md](launches-repo.md)), with `brand.yml` and, since
  2026-10-25, `projects.yml`, articles without a project, and a privacy policy that names every network
  Shipcast now reaches. Since 2026-10-25 on Cloudflare Workers (GitHub Pages before): the bare domain
  opens in the reader's language, security headers, a preview per pull request, IndexNow, a Lighthouse
  gate, structured data, `llms.txt`, and PageSpeed at 93-94 on mobile and 100 on desktop.
- **Wikidata**: the owner's item ([Q141856101](https://www.wikidata.org/wiki/Q141856101)) and the
  projects' (claudio Q141856151, Shipcast Q141856152), created on 2026-10-25 from the owner's account
  with the conflict of interest disclosed, and linked from the blog's `Person`
  ([plans/search-presence.md](plans/search-presence.md)).
- **claudio**: production runs its own headless instance in Shipcast's stack; a local install runs
  one from `docker-compose.yml` ([claudio.md](claudio.md)), and so does the registry's Postgres
  (`docker compose up -d postgres`).
- **Search and analytics**: Search Console and Cloudflare Web Analytics on the blog; Shipcast
  resubmits the sitemap and tracks each article's index status ([search-indexing.md](search-indexing.md)).
- **The newsletter** in Brevo, live on the blog ([publishing.md](publishing.md#the-newsletter)).
- **The app's address**: `https://shipcast.josegarrido.dev` on the tailnet, served from `apps-1`
  behind Traefik, with GitHub sign-in. GitHub's webhook deliveries reach it at
  `shipcast-hooks.josegarrido.dev`.
- **Credentials**: every network is a connected account, each checked live; on the server they live
  in the encrypted `secrets` table. Accounts, expiry dates and machine details are in the owner's
  local notes, not in the public docs.

## Launches so far

- **claudio v0.9.0** (2026-10-25), the first real launch: blog in both languages, dev.to, Bluesky,
  Mastodon, Instagram (republished the same day as a carousel with its story and comment) and the
  newsletter. Judged a success by the owner, Instagram the weakest result, hence the carousel.
- **A test article written in the app and published without a pull request** (2026-10-25): the blog
  in both languages (the Spanish exactly as written, the English translated) and Bluesky; removed
  from the blog the same day.
- **Shipcast v0.1.0** (2026-10-25), the goal's final test, launched from the app: release, pre-flight,
  drafts reviewed in the app (launches#2, AI cost $0.32) and approved there; out on the blog in both
  languages, dev.to, Bluesky, Instagram (carousel, story, comment) and the newsletter in both
  languages, with the metrics read from every source.
- **The first reply**: a question on Mastodon about how claudio's parallel agents handle merge
  conflicts, answered from claudio's code (2026-10-25).
- **Shipcast v0.2.0** (released 2026-10-27): its drafting stopped at a Claude usage limit, which is
  why that limit is now a retryable error with its reset time rather than a silent end
  ([claudio.md](claudio.md)).
- **The REA article** (launch 6, 2026-10-28): its scheduled pieces went out once each, on time.
- **The Sluice article** (2026-10-29), the first written by the AI task runner on production's
  claudio: staged as yeyo11/launches#13, approved by the owner and merged the same day. Its two
  YouTube videos are the first Shipcast uploaded, and they came out **public**: Shipcast asks for
  `public`, and Google did not hold this project's uploads private although it is not audited
  ([decisions/youtube.md](decisions/youtube.md#privacy-and-googles-audit)).
- **The GitHub Action, end to end** (2026-11-02): Action v1.1.0 drafted a real release of another
  project with a real Anthropic key into a private test launches repo, nothing published; v1.0.0 had
  only run with the fake provider.
- **Shipcast v0.3.0** (prepared 2026-11-03, not yet released): its `.github/launch.yml` turns YouTube
  on and Reddit off, since Reddit closed self-service API apps and the owner's brand drops it.

## Waiting on the owner

- **Hashnode is out for now** (the owner's decision, 2026-10-25): its API needs a paid Pro plan since
  2026-05-13; the connector stays ready.
- **The Meta logins' tests** (since 2026-11-06): setting up the Meta app's Unified Login and Facebook
  Login for Business configurations, connecting, and a test launch on Instagram and on a Facebook
  Page ([plans/goal-meta-logins.md](plans/goal-meta-logins.md#what-the-owner-does-after-the-run)).

## Launches owned by Shipcast

The launch model ([decisions/launch-model.md](decisions/launch-model.md#where-it-stands)) is built:
media on R2, every launch held, reviewed and approved in Shipcast, launches from sources, trigger
rules and deletion. On 2026-11-01 its flags were retired and phase 8 was done in the code: no pull
request for a new launch in the app, no drafts snapshot, the `pull_request` webhook ignored, launches
decided in pull requests read and published from their rows. Before that image is deployed the
import must have run in production ([launch-import.md](launch-import.md#in-production)). On
2026-11-02 the import's script was removed and the old draft folders' deletion from the launches repo
was prepared for the owner to push, and migration `0022_drop_draft_snapshots` drops the
`draft_snapshots` table: the one agreed exception to additive-only migrations
([decisions/launch-model.md](decisions/launch-model.md#where-it-stands)).

## Next

The refactor is closed ([plans/refactor-report.md](plans/refactor-report.md), and its goal's
[outcome](plans/goal-refactor.md#outcome-2026-10-29)). Launches owned by Shipcast and UTM tracking on
every channel's links, the first items of
[plans/handoff-2026-10-29.md](plans/handoff-2026-10-29.md#pending), are done and part of v0.3.0.
Next: the owner publishes the v0.3.0 release, which publishes the CLI to npm, and Shipcast launches
it; web push notifications follow once deployed. The owner tries the Meta logins and the Facebook
channel against Meta, and what those tests find is fixed forward. After that, the scale and chaos
tests on a preview stack and the roadmap in [plans/after-mvp.md](plans/after-mvp.md).

## Related

[[plans/shipcast.md]] · [[plans/after-mvp.md]] · [[plans/performance-refactor.md]] · [[plans/goal-refactor.md]] · [[plans/search-presence.md]] · [[search-indexing.md]] · [[plans/mvp-close.md]] · [[plans/goal-finish.md]] · [[server.md]] · [[measurement.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[launches-repo.md]] · [[knowledge-base.md]] · [[decisions/mvp-scope.md]] · [[claudio.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[brands.md]] · [[mcp.md]] · [[decisions/mcp-parity.md]] · [[decisions/main-until-mvp.md]] · [[decisions/web-app-stack.md]] · [[decisions/postgres.md]] · [[decisions/architecture.md]] · [[decisions/publishing-state.md]] · [[decisions/ai-layer.md]] · [[decisions/youtube.md]] · [[plans/refactor-report.md]] · [[plans/handoff-2026-10-29.md]] · [[decisions/migration-lock.md]] · [[decisions/meta-logins.md]] · [[plans/meta-logins.md]] · [[plans/meta-logins-implementation.md]] · [[plans/goal-meta-logins.md]]