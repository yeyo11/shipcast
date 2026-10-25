---
created_at: 2026-10-25T09:57:37.470820711Z
updated_at: 2026-10-25T10:02:30.35494427Z
tags:
    - status
    - roadmap
    - phase-0
    - phase-1
---
# Status

**The MVP is closed (2026-10-25): phases 0 to 5 done, and Shipcast v0.1.0 was launched with Shipcast,
from its app.** The
same day the [goal to finish Shipcast](plans/goal-finish.md) built the web app, accounts per brand in
the keychain, the phase 5 channels and what the MVP had left ([its outcome](plans/goal-finish.md#outcome-2026-10-25)).
The app is live at its address, signed in with GitHub, with Instagram connected through its OAuth;
it runs its own rounds or takes GitHub webhooks, and phase 3 records the demo and screenshots of a
deployed project with Playwright. Closing the MVP is [its own plan](plans/mvp-close.md).

## What exists

- **The repository** [github.com/yeyo11/shipcast](https://github.com/yeyo11/shipcast): MIT, pnpm
  monorepo on TypeScript and Node 24.22.1 (pinned in `.nvmrc`, pnpm's `useNodeVersion` and `engines`),
  CI on every pull request and on main, Sluice gates for `typecheck` and `test`, pando as the
  knowledge base ([knowledge-base.md](knowledge-base.md)). Since the MVP every change is a pull request,
  squash-merged, on a protected `main` ([decisions/main-until-mvp.md](decisions/main-until-mvp.md)). The README says what Shipcast does
  today, with a demo of the app (`docs/media/tour.gif`). Release v0.1.0 on GitHub.
- **`packages/schema`**: `launch.yml` ([launch-yml.md](launch-yml.md)), `brand.yml`
  ([brands.md](brands.md)), `projects.yml` (the project looks) and the content pack
  ([content-pack.md](content-pack.md)), with line-aware YAML errors and the pack's draft-07 JSON Schema.
- **`packages/engine`** ([engine.md](engine.md)): the registry on `node:sqlite` (launches, posts,
  cursors, metrics, accounts), detection from the account's public events, the pre-flight check,
  claudio as the AI provider, drafting to a pull request or straight onto main, articles written in
  the app, reviewing and approving, publishing once per channel, the newsletter and metrics
  ([publishing.md](publishing.md)).
- **`packages/connectors`**: dev.to, Hashnode, Bluesky, Mastodon, Instagram (carousel, story, comment),
  Telegram, Discord and Brevo, the Cloudflare Web Analytics and Search Console readers, a `check()` per
  connector, and the Mastodon and Instagram OAuth flows.
- **`packages/assets`**: the launch image, the Instagram carousel and story, generated covers, and the
  demo as a video, in the blog's editorial identity.
- **`packages/capture`**: screenshots and the demo GIF of a deployed project, through Playwright and
  ffmpeg.
- **`packages/runtime`** ([accounts.md](accounts.md)): configuration, the OS keychain, accounts per
  brand, the network catalog and the connectors built from them, the shared round, the GitHub webhook
  handling and the automation settings, shared by the CLI and the app.
- **`apps/cli`**: `launch` (after the pre-flight), `preflight`, `watch`, `publish [--retry]`,
  `metrics`, `status`.
- **`apps/web`** ([web-app.md](web-app.md), [decisions/web-app-stack.md](decisions/web-app-stack.md)):
  TanStack Start in Cartel; GitHub sign-in limited to the owner, signed sessions, same-origin checks;
  Launches, a launch's review (edit, approve, retry), Launch a repo, Write, and Channels (every
  integration, its accounts and permissions, connect by form or OAuth, check, rename, disconnect,
  several accounts per channel and brand, import from `.env`), and Automation (rounds, GitHub webhooks
  or off, the webhook's secret); outcomes and errors as toasts in Cartel, explained for a person;
  smooth scrolling. It replaced the CLI's dashboard.

## Services

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches), the blog at
  <https://josegarrido.dev> ([launches-repo.md](launches-repo.md)), with `brand.yml` and, since
  2026-10-25, `projects.yml`, articles without a project, and a privacy policy that names every network
  Shipcast now reaches.
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)).
- **Search and analytics**: Search Console and Cloudflare Web Analytics on the blog.
- **The newsletter** in Brevo, live on the blog ([publishing.md](publishing.md#the-newsletter)).
- **The app's address**: `https://shipcast.josegarrido.dev`, an A record at this machine's tailnet
  address, the tailnet's port 443 forwarded to it by Tailscale Serve, a GitHub OAuth App for the
  sign-in (used for real on 2026-10-25), and a Let's Encrypt certificate renewed through the
  Cloudflare token.
- **Credentials**: on 2026-10-25 every network moved from `.env` into the keychain as a connected
  account, each checked live: dev.to, Bluesky, Instagram, Brevo, Cloudflare, Search Console, then
  Mastodon (a new token), Telegram (a bot posting to the owner's channel) and Discord (a webhook),
  and a second Instagram account connected through Instagram Login from the app. Accounts,
  expiry dates and machine details are in the owner's local notes, not in the public docs.

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
  languages, with the metrics read from every source. Mastodon failed on its old token and went out
  the same day once the new one was connected. Telegram and Discord got a live post and the owner's
  notices the same day; they were not in Shipcast's `launch.yml` for this launch.
- **The first reply**: a question on Mastodon about how claudio's parallel agents handle merge
  conflicts, answered from claudio's code (2026-10-25).

## Waiting on the owner

- **Hashnode is out for now** (the owner's decision, 2026-10-25): its API needs a paid Pro plan since
  2026-05-13; the connector stays ready.
- Try the app running and validate its design (built in Cartel, as approved).

## Next

- The app on a VPS or server, which also lets GitHub's webhooks reach it.
- Phase 6, after the MVP, as steps of a setup wizard: the AI providers through the Vercel AI SDK
  (claudio through its OpenAI-compatible API), the GitHub Action mode, documentation, a blog template
  and a one-command install. The company brand of the founding plan is dropped: the brand is the
  owner's own, josegarridodev.

## Related

[[plans/shipcast.md]] · [[plans/mvp-close.md]] · [[plans/goal-finish.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[launches-repo.md]] · [[knowledge-base.md]] · [[decisions/mvp-scope.md]] · [[claudio.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[brands.md]] · [[decisions/main-until-mvp.md]] · [[decisions/web-app-stack.md]]
