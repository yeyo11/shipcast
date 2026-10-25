---
created_at: 2026-10-25T00:57:17.114493621Z
updated_at: 2026-10-25T01:50:57.068080332Z
tags:
    - status
    - roadmap
    - phase-0
    - phase-1
---
# Status

**Phases 0 and 1 done; the first real launch went out on 2026-10-25.** On the same day the
[goal to finish Shipcast](plans/goal-finish.md) built the web app, accounts per brand in the
keychain, the phase 5 channels and what the MVP had left; its final test (Shipcast launched with
Shipcast) is waiting on the credentials listed under "Waiting on the owner".

## What exists

- **The repository** [github.com/yeyo11/shipcast](https://github.com/yeyo11/shipcast): MIT, pnpm
  monorepo on TypeScript and Node 24.22.1 (pinned in `.nvmrc`, pnpm's `useNodeVersion` and `engines`),
  CI on every pull request and on main, Sluice gates for `typecheck` and `test`, pando as the
  knowledge base ([knowledge-base.md](knowledge-base.md)). Work goes straight to `main` until the MVP
  ([decisions/main-until-mvp.md](decisions/main-until-mvp.md)). The README says what Shipcast does
  today, with a demo of the app (`docs/media/tour.gif`).
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
- **`packages/runtime`** ([accounts.md](accounts.md)): configuration, the OS keychain, accounts per
  brand, the network catalog and the connectors built from them, shared by the CLI and the app.
- **`apps/cli`**: `launch` (after the pre-flight), `preflight`, `watch`, `publish [--retry]`,
  `metrics`, `status`.
- **`apps/web`** ([web-app.md](web-app.md), [decisions/web-app-stack.md](decisions/web-app-stack.md)):
  TanStack Start in Cartel; GitHub sign-in limited to the owner, signed sessions, same-origin checks;
  Launches, a launch's review (edit, approve, retry), Launch a repo, Write, and Channels (every
  integration, its accounts and permissions, connect by form or OAuth, check, rename, disconnect,
  several accounts per channel and brand, import from `.env`). It replaced the CLI's dashboard.

## Services

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches), the blog at
  <https://josegarrido.dev> ([launches-repo.md](launches-repo.md)), with `brand.yml` and, since
  2026-10-25, `projects.yml`, articles without a project, and a privacy policy that names every network
  Shipcast now reaches.
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)).
- **Search and analytics**: Search Console and Cloudflare Web Analytics on the blog.
- **The newsletter** in Brevo, live on the blog ([publishing.md](publishing.md#the-newsletter)).
- **The app's address**: an A record of a subdomain of the owner's domain at this machine's tailnet
  address (2026-10-25), and a GitHub OAuth App for the sign-in; the certificate waits on a token.
- **Credentials**: on 2026-10-25 six networks moved from `.env` into the keychain through the app's
  import (dev.to, Bluesky, Instagram, Brevo, Cloudflare, Search Console), each checked live. Accounts,
  expiry dates and machine details are in the owner's local notes, not in the public docs.

## Launches so far

- **claudio v0.9.0** (2026-10-25), the first real launch: blog in both languages, dev.to, Bluesky,
  Mastodon, Instagram (republished the same day as a carousel with its story and comment) and the
  newsletter. Judged a success by the owner, Instagram the weakest result, hence the carousel.
- **A test article written in the app and published without a pull request** (2026-10-25): the blog
  in both languages (the Spanish exactly as written, the English translated) and Bluesky. A test, for
  the owner to delete.

## Waiting on the owner

- **A Cloudflare token with Zone DNS edit** (`SHIPCAST_TLS_CLOUDFLARE_TOKEN`): the app's certificate,
  and with it GitHub sign-in and OAuth on the real address.
- **The Instagram app secret** (`INSTAGRAM_APP_SECRET`) for Instagram Login from the app.
- **A new Mastodon token**: the one in `.env` is invalid (the network answers "the access token is
  invalid"); connect it again from the app, by OAuth or by pasting a token.
- **Phase 5 accounts**: a Telegram bot and channel, a Discord webhook, a Hashnode token (whose API may
  need the Pro plan). Each connector is built and tested with fakes; each gets its real test once
  connected.
- Upload Shipcast's social preview (`design/social-preview.png`) to the GitHub repo settings.

## Next

- The goal's final test: Shipcast v0.1.0 launched from the app on every connected channel.
- Then phase 6 ([plans/shipcast.md](plans/shipcast.md#roadmap)): other AI providers, the GitHub Action
  mode, documentation and a one-command install; and the company brand's own setup.

## Related

[[plans/shipcast.md]] · [[plans/goal-finish.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[launches-repo.md]] · [[knowledge-base.md]] · [[decisions/mvp-scope.md]] · [[claudio.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[brands.md]] · [[decisions/main-until-mvp.md]] · [[decisions/web-app-stack.md]]
