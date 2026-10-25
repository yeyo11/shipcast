---
created_at: 2026-10-25T00:37:51.291232832Z
updated_at: 2026-10-25T00:37:51.291232832Z
tags:
    - plan
    - roadmap
    - goal
    - dashboard
    - connectors
    - channels
---
# Goal: finish Shipcast (MVP, the app and phase 5)

Written on 2026-10-25 after the first real launch, from a round of questions to the owner. It is the
brief for one long autonomous run (a goal): everything still pending in the MVP, a web app with a
**Channels** section, and phase 5 of the [roadmap](shipcast.md#roadmap). Phase 6 (other AI providers,
the GitHub Action mode, the one-command install) and setting up the company brand are **out**.
Reddit and X and LinkedIn stay out ([decisions/mvp-scope.md](../decisions/mvp-scope.md)).

Read first: [status.md](../status.md), [engine.md](../engine.md), [publishing.md](../publishing.md),
[launch-yml.md](../launch-yml.md), [content-pack.md](../content-pack.md), [brands.md](../brands.md),
[plans/design-system.md](design-system.md) and `CLAUDE.md`.

## The owner's answers

| Question | Answer |
| --- | --- |
| How far "finished" goes | MVP leftovers + the app + phase 5 |
| The app's stack | **TanStack Start** (React, TypeScript), a new `apps/web` that replaces the HTML dashboard |
| Where secrets live | **The operating system's keychain**; `.env` stays as a fallback |
| Login | **Sign in with GitHub**, restricted to the owner's account |
| Publishing from the app | All four: launch a repo, write a free article, review and approve drafts in the app, publish without a pull request |
| A new integration | Connect an account, several accounts per channel (each tied to a brand), and add a network from a catalog |
| Design | **Cartel counts as approved**: build the app in it on `main`; the owner reviews at the end |
| Real publishing while testing | Allowed: publish what the tests need; the owner deletes it afterwards |
| Company brand | Only the infrastructure (accounts per brand, a brand selector); no josegarridodigio setup |
| Phase 5 accounts | Build each connector with tests and mocks, list what the owner must create, test for real once the credentials are entered in the app |
| OAuth callbacks | **A subdomain of the owner's domain, served over Tailscale** |
| Final test | **Shipcast v0.1 launched with Shipcast from the app**, plus a free article published without a pull request |

## Rules for the run

- Every rule in `CLAUDE.md` holds: work on `main`, small Conventional Commits that pass the Sluice
  gates, verified through the `verify` tool, pushed without asking; docs only through
  `kb_add_document`; technical text in English; no `any`.
- **Never `git add -A`**: stage files by name.
- **Nothing private in the public repos**: no hostnames of the owner's machines or tailnet, no
  account ids, no private sources. They go in `.env` or the keychain.
- **Real publishing is allowed** for testing; keep a list of everything published (channel, URL) in
  the final report, so the owner can delete it.
- **Pushing to `launches/main` deploys the blog**: allowed for the tests above, each push recorded in
  the same list.
- Every milestone ends with its doc under `docs/` (a plan or a decision) and `status.md` updated.

### Subagents and models

Independent work runs in parallel subagents, each in its own worktree and branch; the session on
`main` reviews their branches, integrates them, verifies and pushes. Pick the model by what the task
needs, not by habit:

| Model | For |
| --- | --- |
| **Opus** | Architecture and boundaries (the engine API the app calls, the account store), security (GitHub login, OAuth flows, the keychain, TLS), migrations of the registry, reviewing a subagent's branch before it is integrated |
| **Sonnet** | A connector against its documented API, a screen of the app from an agreed design, tests, a Satori template |
| **Haiku** | Mechanical work: sweeping docs for stale lines, renames, looking things up in the code, filling fixtures |

A subagent gets a narrow brief: the files to read, the interface to build against, what is out of
scope. Never two subagents on the same files.

## Before starting: what the owner provides

The run stops and asks only for these; collect them at the start where possible.

1. **The app's subdomain** (for example `shipcast.<domain>`), its tailnet address, and confirmation
   that the run may create its DNS record through the Cloudflare API.
2. **A GitHub OAuth App** with that subdomain's callback (`/auth/github/callback`): client id and
   secret, entered in the app's first-run screen or in `.env`.
3. **The Meta app's redirect URI**: add the subdomain's Instagram callback in the Meta developer
   dashboard (the run tells the exact URL).
4. Phase 5 credentials, whenever ready (the connectors do not wait for them): a Hashnode personal
   access token and publication, a Telegram bot (BotFather) and the chat or channel id, a Discord
   webhook, and nothing for Product Hunt or Hacker News (drafts only: neither has a posting API).

## Milestone 1: the app's foundations

- **`apps/web`** on TanStack Start: server functions call `@shipcast/engine` directly (one process,
  the same SQLite registry); the CLI keeps working. `pnpm shipcast app` starts it.
- **HTTPS on the owner's subdomain, private to the tailnet**: the DNS record points at the laptop's
  tailnet address, and a certificate for the subdomain comes from Let's Encrypt through the DNS-01
  challenge on Cloudflare (Tailscale Serve only issues `*.ts.net` certificates, so it cannot serve a
  custom domain). OAuth redirects go through the owner's browser, so a private address is enough.
  Write the choice (Caddy or Node's own TLS) as a decision doc.
- **Sign in with GitHub**: OAuth App, the session in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie;
  only the logins in `SHIPCAST_ALLOWED_GITHUB` get in; CSRF protection on every mutation.
- **The secret store**: an interface with a keychain backend (`secret-tool`/libsecret on Linux,
  `security` on macOS, called as commands, so no native module) and the `.env` fallback; the
  registry keeps only references and non-secret metadata. The Instagram token refresh moves to it.
- **Accounts per brand**: a registry migration for `accounts` (channel, brand, label, public settings,
  secret reference, status, last check). `services.ts` builds connectors from the accounts of the
  launch's brand, falling back to `.env` for the personal brand, so nothing breaks for the CLI.
- **The look**: Cartel from `design/` ([plans/design-system.md](design-system.md)), dark.

## Milestone 2: the Channels section

One page lists every integration with its state: connected accounts per brand, the last check, what
it is used for (publishing, metrics or both) and its permissions.

- **Connect an account**, by the network's own method:
  - Mastodon: OAuth, registering the app on the chosen instance through `POST /api/v1/apps`, with the
    scopes publishing and metrics need (`write:statuses`, `write:media`, `read:statuses`).
  - Instagram: Instagram Login OAuth, the short-lived token exchanged for a long-lived one, refreshed
    every 30 days; the permissions in use today (publishing, insights, comments).
  - Bluesky: app password (atproto OAuth needs its client metadata at a public URL; it can come later
    from the blog's domain).
  - dev.to, Brevo, Hashnode: API keys; Telegram: the bot token and chat; Discord: the webhook.
  - Metrics sources: GitHub (the app's own sign-in or a fine-grained token with traffic access),
    Cloudflare Web Analytics, Search Console (a service account's JSON).
- **Test** every account (a read call that proves the credential and its permissions) and show what
  failed in words, not a status code.
- **Reconnect, rename, disconnect** (disconnecting deletes the secret from the keychain).
- **Several accounts per channel**, each tied to a brand; a launch only uses its brand's accounts,
  which keeps brands from mixing.
- **The catalog**: every network Shipcast knows, the ones connected and the ones to add; adding one
  starts its connect flow. A network is a connector module plus a descriptor (name, auth method,
  fields, permissions), so a new one is code plus one entry.

## Milestone 3: publishing from the app

- **Launches**: the list with status, pull request, posts and latest metrics, in Cartel (it replaces
  `dashboard.ts`, whose `/api/launches` JSON stays).
- **Launch a repo**: pick a repo and a version, see the pre-flight result, start the pipeline, follow
  it until the drafts pull request.
- **Review and approve in the app**: every channel's draft from the pull request, edited in the app
  (commits on the pull request's branch), the carousel and images previewed; approving merges the
  pull request, and publishing follows as today; a failed channel can be retried from the app.
- **A free article**: a Markdown editor for a post that comes from no release, in one language; the
  AI translates it (the owner's words stay theirs) and writes each channel's piece from it under the
  same truth rule. It goes through the same review.
- **Publishing without a pull request**: for a free article or an approved launch, pick the channels
  and publish at once; the blog article is a direct commit to the launches repo. Recorded in the
  registry like any launch, so it is never published twice.

## Milestone 4: what the MVP left

- **One source for the project colours and motifs**, read by both the blog and `packages/assets`,
  instead of the copy in `og.ts`.
- **Generated covers per article** in the house style, when a project has no drawn cover.
- **The pre-flight check**: license, README, demo GIF and a release; its result shown before a
  launch, in the CLI and the app.

## Milestone 5: phase 5

Built with tests and mocks first, then tested for real once the owner enters the credentials:

- **Hashnode**: the English article republished with the blog's canonical URL (GraphQL API).
- **Show HN**: a draft (title, URL, first comment) in the drafts pull request, `manual` only.
- **Product Hunt kit**: tagline, description, first comment and the gallery images, as a draft.
- **Telegram**: notifications to the owner (drafts waiting, published, failed) and, as a channel, a
  post to a Telegram channel.
- **Discord**: a post through a webhook.

Each new channel gets its schema piece, its `launch.yml` key (`off` by default), its draft file, its
connector, its catalog entry and its metrics where the API gives any.

## Milestone 6: the final test

1. Shipcast gets its `.github/launch.yml`, a demo GIF and a release `v0.1.0`.
2. From the app: launch `yeyo11/shipcast`, review the drafts, approve, and see it published on every
   connected channel and the metrics arrive.
3. From the app: write a free article and publish it without a pull request.
4. The owner tries the app running and validates the design.

Finished when: every milestone is merged on `main` with its docs, the gates pass, both tests went out,
`status.md` and the roadmap are ticked, and the final report lists what was published (to delete),
what the owner still has to create, and anything left undone with its reason.

## Related

[[plans/shipcast.md]] · [[status.md]] · [[decisions/mvp-scope.md]] · [[publishing.md]] · [[engine.md]] · [[plans/design-system.md]] · [[brands.md]] · [[launch-yml.md]] · [[content-pack.md]]
