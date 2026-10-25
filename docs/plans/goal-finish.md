---
created_at: 2026-10-25T00:57:20.99176043Z
updated_at: 2026-10-25T04:14:23.205402851Z
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

## Outcome (2026-10-25)

Run the same day. Every milestone is on `main` with its docs and the gates pass; the final test went
out from the app; one piece of milestone 1 waits on a credential.

| Milestone | State |
| --- | --- |
| 1. Foundations | Done: `apps/web` on TanStack Start, GitHub sign-in, signed sessions, CSRF, the keychain, accounts per brand, Cartel ([web-app.md](../web-app.md), [accounts.md](../accounts.md)). **HTTPS on the owner's domain is built but not live**: the certificate needs the Cloudflare DNS token, so the app ran on `127.0.0.1` with a console sign-in link |
| 2. Channels | Done: every integration, accounts and permissions, connect by form or OAuth (Mastodon, Instagram), check, rename, disconnect, several accounts per channel and brand, the catalog, import from `.env` (six accounts moved and checked live) |
| 3. Publishing from the app | Done: launch a repo after its pre-flight, review and edit drafts, approve, retry a channel, write an article, publish without a pull request |
| 4. What the MVP left | Done: `projects.yml` read by the blog and Shipcast, generated covers, the pre-flight check |
| 5. Phase 5 | Built and tested with fakes: Hashnode, Telegram (posts and notices), Discord, Show HN, Product Hunt. No live test: no accounts yet, and Hashnode's API needs its paid Pro plan since 2026-05-13, against the MVP's "no paid APIs" |
| 6. Final test | Done from the app: **Shipcast v0.1.0** (release, pre-flight, drafts in launches#2 reviewed in the app, approved there) published on the blog in both languages, dev.to, Bluesky, Instagram (carousel, story, comment) and the newsletter in both languages; Mastodon failed on its invalid token and waits for a retry; the metrics arrived from every source. **A free article** written in the app went out without a pull request on the blog and Bluesky |

Subagents used: Sonnet for the phase 5 connectors, the pre-flight check, the project looks and
covers, and the phase 5 channels in the engine, each in its own worktree, reviewed and integrated on
`main`; the architecture, security and app work stayed in the main session (Opus).

Found and fixed on the way: the blog treated every post as a project's launch (articles now belong
to none); media links in the review encoded the branch's slash; drafts published directly spoke of a
merge; the README promised X and LinkedIn and said nothing ran.

**Published during the run, for the owner to delete** (also in `data/goal-published.md`, local):
the test article (`/en/shipcast-now-has-its-own-app/`, `/es/shipcast-ya-tiene-su-propia-app/`, its
Bluesky post), and Shipcast v0.1.0's launch (blog, dev.to, Bluesky, Instagram, the newsletter — sent,
it cannot be unsent — and the GitHub release). Kept on purpose: the blog's updated privacy policy,
`projects.yml`, and support for articles without a project.

**Still for the owner:** the Cloudflare token (`SHIPCAST_TLS_CLOUDFLARE_TOKEN`) to put the app on its
address; the Instagram app secret for Instagram Login; a new Mastodon token or its OAuth connection,
then **Try again** on Shipcast's launch; Telegram and Discord accounts, and a decision on Hashnode's
Pro plan; the GitHub social preview; trying the app running and validating its design.

## Related

[[plans/shipcast.md]] · [[status.md]] · [[web-app.md]] · [[accounts.md]] · [[decisions/mvp-scope.md]] · [[publishing.md]] · [[engine.md]] · [[plans/design-system.md]] · [[brands.md]] · [[launch-yml.md]] · [[content-pack.md]]
