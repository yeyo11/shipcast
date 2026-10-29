---
created_at: 2026-10-25T10:57:26.1120447Z
updated_at: 2026-10-29T11:06:32.131036651Z
tags:
    - status
    - roadmap
    - phase-0
    - phase-1
---
# Status

**Production runs on the server `apps-1` since 2026-10-27, and since 2026-10-29 it runs the whole
performance and architecture refactor**: three processes (`web`, `worker`, `heavy`), BullMQ on Redis,
PgBouncer, the encrypted secrets table, GitHub by events through a public webhook host, and every AI
task on the AI task runner with Shipcast's own headless claudio. Every flag of the refactor is on
([server.md](server.md#what-production-runs-2026-10-29)). Shipcast v0.2.0 was released on
2026-10-27.

**The MVP closed on 2026-10-25: phases 0 to 5 done, and Shipcast v0.1.0 was launched with Shipcast,
from its app.** The same day the [goal to finish Shipcast](plans/goal-finish.md) built the web app,
accounts per brand, the phase 5 channels and what the MVP had left
([its outcome](plans/goal-finish.md#outcome-2026-10-25)). Closing the MVP is
[its own plan](plans/mvp-close.md).

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
- **The stack**: `web` (rolled out with docker-rollout), `worker` and `heavy`; Postgres behind
  PgBouncer in transaction pooling; `redis-queue` (AOF, `noeviction`) and `redis-cache` (LRU); the
  secrets in the encrypted `secrets` table (22 keys moved from the encrypted file); Shipcast's own
  headless claudio 0.11.0 with a daily spend cap ([claudio.md](claudio.md)); GitHub's webhook on the
  public host `shipcast-hooks.josegarrido.dev`, which forwards that one route only; `heavy`'s probe
  timing `web`'s pages.
- **Measurement** ([measurement.md](measurement.md)): the baseline ran from 2026-10-28T12:00Z to
  2026-10-29T08:00Z, 20 hours, ended early by the owner. The after-window compares the same 20 hours
  of the day now that the flags are on.
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
  on GitHub.
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
- **`packages/connectors`**: dev.to, Hashnode, Bluesky, Mastodon, Instagram (carousel, story, comment),
  Telegram, Discord and Brevo, the Cloudflare Web Analytics, Search Console and Bing Webmaster readers,
  and connectors for Threads, LinkedIn, Reddit, YouTube and GitHub Discussions; a `check()` per
  connector, and the OAuth flows.
- **`packages/assets`**: the launch image, the Instagram carousel and story, generated covers, and the
  demo as a video, in the blog's editorial identity.
- **`packages/capture`**: screenshots and the demo GIF of a deployed project, through Playwright and
  ffmpeg.
- **`packages/runtime`** ([accounts.md](accounts.md)): configuration, the secret stores (keychain,
  encrypted file, encrypted table), accounts per brand, the network catalog, process roles, the job
  queue (pg-boss or BullMQ), Redis, the flags, the shared round, the GitHub webhook handling and the
  automation settings, shared by the CLI and the app.
- **`packages/mcp`** ([mcp.md](mcp.md)): the MCP server over the REST API.
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
  why a chat that ends that way now says so ([claudio.md](claudio.md)).
- **The REA article** (launch 6, 2026-10-28): its scheduled pieces went out once each, on time.
- **The Sluice article** (2026-10-29), the first written by the AI task runner on production's
  claudio: staged as yeyo11/launches#13, waiting for the owner's approval.

## Waiting on the owner

- **Hashnode is out for now** (the owner's decision, 2026-10-25): its API needs a paid Pro plan since
  2026-05-13; the connector stays ready.
- Approving the Sluice article (launches#13).

## Next

The rest of the [refactor's goal](plans/goal-refactor.md): the after-window with every flag on and
the before/after report ([measurement.md](measurement.md)), the scale test and the chaos tests,
YouTube's private uploads, and the v0.2 run's leftovers. The roadmap after that is
[plans/after-mvp.md](plans/after-mvp.md).

## Related

[[plans/shipcast.md]] · [[plans/after-mvp.md]] · [[plans/performance-refactor.md]] · [[plans/goal-refactor.md]] · [[plans/search-presence.md]] · [[search-indexing.md]] · [[plans/mvp-close.md]] · [[plans/goal-finish.md]] · [[server.md]] · [[measurement.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[launches-repo.md]] · [[knowledge-base.md]] · [[decisions/mvp-scope.md]] · [[claudio.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[brands.md]] · [[mcp.md]] · [[decisions/main-until-mvp.md]] · [[decisions/web-app-stack.md]] · [[decisions/postgres.md]] · [[decisions/architecture.md]] · [[decisions/publishing-state.md]]