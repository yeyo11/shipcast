---
created_at: 2026-10-25T16:54:56.185308972Z
updated_at: 2026-10-29T01:58:00.134735146Z
tags:
    - decision
    - github-app
    - auth
    - webhooks
    - configuration
    - settings
    - phase-6
    - metrics
---
# The GitHub App, and the configuration in two parts

Decided in the roadmap after the MVP ([plans/after-mvp.md](../plans/after-mvp.md), decisions "GitHub"
and "What stays in .env") and built on 2026-10-25 as the last piece of milestone 1 of the
[goal](../plans/goal-after-mvp.md). Shipcast signs in, reads and writes on GitHub through a **GitHub
App** instead of an OAuth App plus a personal token, and its configuration is split into a
**bootstrap** in `.env` and **settings** in the database and the keychain.

## Why an App

- **One identity, scoped.** The App has exactly the permissions Shipcast uses (Contents, Pull requests
  and Discussions read and write, Metadata read, and since 2026-10-26 Administration read for a repo's
  traffic) on the repos the owner installs it on, instead of a fine-grained token the owner has to
  make, scope and renew by hand.
- **Webhooks for every repo at once.** An App's webhook covers every repo it is installed on, new ones
  included; per-repo webhooks on a user account had to be added repo by repo.
- **Tokens that expire on their own.** Installation tokens last an hour and user tokens eight hours;
  nothing long-lived sits in `.env` but the App's private key.

## Tokens

- **The engine: installation tokens** (`packages/engine/src/github-app.ts`, `GitHubApp`). A JWT
  signed RS256 with the App's private key (issuer: the client id; issued a minute back for clock
  skew; nine minutes) authenticates as the App; `POST /app/installations/{id}/access_tokens` mints an
  installation token, kept until five minutes before it expires and shared by requests that arrive
  while one is being minted. The installation is looked up for the **launches repo**
  (`GET /repos/{owner}/{repo}/installation`, which covers a user or an organisation), or for the first
  allowed login before a launches repo is set, and remembered until a webhook says it changed.
  `GitHubRest` takes either a token or such an auth: it asks for the token per request, and on a
  `401` it forgets a minted token and tries once more. Everything the engine does in the background
  goes through it: the user's events and repos, releases, `launch.yml`, the pre-flight reads,
  committing drafts and opening their pull requests in the launches repo, editing a draft, merging,
  Discussions, and the repo's numbers. One installation is used: the repos launched and the launches
  repo are expected on the same account.
- **The owner: a user token** (`packages/runtime/src/github-user.ts`, `GitHubUserTokens`). Signing in
  through the App's client id and secret is GitHub's usual web flow on the same callback
  (`/auth/github/callback`); the answer carries an access token (8 hours) and a refresh token
  (6 months). Only once the login is in `SHIPCAST_ALLOWED_GITHUB` are both kept in the keychain
  (`app:github-user`). Asking for the token within five minutes of its expiry refreshes it
  (`grant_type=refresh_token`) and saves the new pair at once, since GitHub spends the old refresh
  token; two callers share one refresh. A refused or expired refresh token is dropped: the owner
  signs in again. It is kept for what Shipcast will do as the owner rather than as the App; today the
  Settings page and `shipcast status` show it.
- **Console links stay**: the app prints a single-use sign-in link at start, which needs no GitHub.

## Commits are by the App's bot

Drafts, their pull requests, edits made in the app and merges are now made by **`<slug>[bot]`**, the
App's bot, not by the owner's account. The launches repo's history shows the bot as the author; the
pull requests are opened by it, and the owner still reviews and merges them (or approves them in the
app, which merges as the bot).

## A repo's traffic, through the App

The metrics' `github` source reads stars, forks and watchers with any token, but a repo's traffic
(`/repos/{owner}/{repo}/traffic/views`) needs **Administration: read**. On 2026-10-25 the App was not
granted it (an installation token got `403 Resource not accessible by integration`), so traffic came
from a connected **GitHub account** or from `GITHUB_TOKEN_PERSONAL` in `.env`; giving the App
Administration was not done then, thinking it would let it change repo settings.

Changed on 2026-10-26 by the owner: the App is granted **Administration: read** (read only: it can see
a repo's settings, collaborators and branch protection, and change none of them), and the traffic is
read with the installation token like the rest. The GitHub "network" in Channels, which was only that
metrics source, is gone, and so is `GITHUB_TOKEN_PERSONAL` for an install with the App; the import
from `.env` used to skip it on purpose, which left the Channels page saying one network still worked
from `.env` forever. `shipcast init`'s manifest asks for it, so a new App has it from the start; an
App created before needs the permission added in its settings and accepted on the installation. Until
then the public numbers are read and traffic is left out.

## Webhooks

The App's deliveries (`POST /api/github/webhook`) are signed with `SHIPCAST_GITHUB_APP_WEBHOOK_SECRET`;
a delivery is trusted when its `X-Hub-Signature-256` matches that secret **or** the per-repo secret
made in the Automation page, so webhooks set by hand before the App keep working. `installation` and
`installation_repositories` events make Shipcast forget the cached installation and its token (the
next request looks it up again), whatever the automation mode; `release`, `pull_request` and
`repository` events go through the `delivery` job as before, only while webhooks are the chosen mode.
Polling stays while GitHub cannot reach the app.

## The configuration in two parts

`packages/runtime/src/config.ts`, `settings.ts` and `runtime.ts`, shared by the app and the CLI.

- **The bootstrap**, from `.env` only: the database URL, the data folder, the keychain's service name,
  the host, port, public URL and Tailscale flag, the GitHub App (id, slug, client id and secret,
  webhook secret, private key file), the allowed logins and the Cloudflare token for the certificate.
  A start asks for nothing else; half an App stops it with what is missing.
- **The settings**, read when needed: the launches repo, claudio's URL, the AI budget and the
  Instagram app id are rows of the `settings` table; claudio's token and the Instagram app secret are
  keychain entries (`app:claudio-token`, `app:instagram-app-secret`). `RuntimeSettings` reads them at
  start, after each save in the **Settings** page and before every round, so a change reaches the app
  at once and `shipcast watch` within a round. The engine's `launchesRepo` and `maxBudgetUsd` are
  getters over them. The AI budget here is the single global one (`ai-budget-usd`); since 2026-10-29
  a spend limit set per task in the AI settings wins over it, with `ai-runner`
  ([engine.md](../engine.md#the-ai)). A page or job that needs a missing one fails with what is
  missing and where to set it ("The launches repo is not set: set it in Settings"); a round without a
  launches repo logs that and goes on.
- **The one-time import.** At every start, each of `SHIPCAST_LAUNCHES_REPO`, `SHIPCAST_CLAUDIO_URL`,
  `SHIPCAST_CLAUDIO_TOKEN`, `SHIPCAST_MAX_BUDGET_USD`, `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`
  still in `.env` and not yet stored is copied in, and its name recorded
  (`settings-imported-from-env`), so it is imported once: a second start does nothing, and an edit or
  a clear made in the app is never undone. A value the Settings page would refuse is left in `.env`.
  The log names what was imported, never a value. `.env` stays a fallback for each of them until the
  owner removes it. claudio's token is the exception worth knowing: `docker-compose.yml` starts claudio
  with `SHIPCAST_CLAUDIO_TOKEN` from `.env`, so it stays there while compose runs claudio.
- The networks' credentials were already connected accounts ([accounts.md](../accounts.md)); `.env`
  stays their fallback for the brand it speaks for.

## Fallback

With no App in `.env`, the engine runs on `GITHUB_TOKEN_PERSONAL` and the owner signs in through the
old OAuth App (`SHIPCAST_GITHUB_CLIENT_ID`, `SHIPCAST_GITHUB_CLIENT_SECRET`), as before, so an install
keeps working mid-way. With the App, all three are unused and can be removed once the owner has
signed in through the App.

## Related

[[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[decisions/job-queue.md]] · [[decisions/ai-providers.md]] · [[publishing.md]]
