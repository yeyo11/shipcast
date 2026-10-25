---
created_at: 2026-10-25T16:02:41.924003579Z
updated_at: 2026-10-25T19:33:14.072270582Z
tags:
    - web-app
    - dashboard
    - channels
    - auth
    - tls
    - decision
    - automation
    - webhooks
    - api
    - job-queue
    - ai
    - github-app
    - settings
    - mcp
    - base-ui
    - accessibility
    - mobile
---
# The web app

Built on 2026-10-25 for the [goal](plans/goal-finish.md): `apps/web`, the place to see the launches
and their numbers, connect the channels, review and approve drafts, launch a repo, write an article
and choose how the work runs on its own. It replaced the CLI's plain dashboard; the CLI keeps every
other command. The look is Cartel ([plans/design-system.md](plans/design-system.md)): the `design/`
folder is the app's public folder, so tokens, fonts, logo and channel glyphs have one copy.

## Running it

| Command | Does |
| --- | --- |
| `pnpm app` | Builds the app and serves it on `SHIPCAST_PUBLIC_URL` over HTTPS (tailnet only), printing a one-time sign-in link |
| `pnpm app:dev` | Vite's development server on `http://127.0.0.1:3000`, printing a one-time sign-in link |
| `SHIPCAST_APP_TLS=off SHIPCAST_APP_HOST=<tailnet address> SHIPCAST_APP_PORT=<port> node apps/web/main.ts` | A preview of a branch's build for the owner: plain HTTP on that one address, a one-time sign-in link, and no certificate code at all (below) |
| `pnpm --filter @shipcast/web check:reflow --base <url> --link <sign-in link>` | The reflow and accessibility check against a running app (below) |
| `pnpm --filter @shipcast/web exec node scripts/certificate-by-hand.ts` | Gets the certificate without a Cloudflare token: it writes the challenge's TXT record to `data/tls/challenge.json` for someone to create, and waits for DNS to answer it |

`.env` holds only the **bootstrap** (`.env.example`): the database, the public URL, host and port,
the GitHub App, the allowed logins and the Cloudflare token for the certificate. Everything else is
set in the **Settings** page ([decisions/github-app.md](decisions/github-app.md)), so the app starts
and signs in with nothing else configured. The app is meant to move to a VPS or server; until then it
runs on the owner's machine.

## How it reaches the owner, and only the owner

- **One private address: `https://shipcast.josegarrido.dev`.** Its A record points at this machine's
  tailnet address, so only the owner's devices on the tailnet can reach it. The record is public DNS,
  but the address behind it answers no one outside the tailnet. A local-network address was tried
  on 2026-10-25 and removed: the app has one address.
- **HTTPS with a real certificate.** Tailscale Serve only issues `*.ts.net` certificates, so the app
  gets its own from Let's Encrypt through the DNS challenge (`apps/web/tls.ts`, with `acme-client`): a
  TXT record proves control, since no authority can reach a tailnet address. The record is placed by
  a `DnsSolver`: Cloudflare's API with `SHIPCAST_TLS_CLOUDFLARE_TOKEN` (Zone DNS edit on the zone), or
  by hand with `scripts/certificate-by-hand.ts` when there is no token. The certificate lives in
  `data/tls/`, its key and the ACME account key in the keychain; it is renewed when less than 30 days
  remain, checked daily and swapped in without a restart. Without a token a valid certificate on disk
  is still served, and the app says how many days it has left. Since 2026-10-25 the token is set and
  the certificate renews itself. `acme-client` pulls `node-forge`, whose advisory GHSA-86w9-cpqp-85rv
  is in a path Shipcast never takes (it signs with Node's own crypto): `pnpm audit` ignores it, with
  the reason, in `pnpm-workspace.yaml`.
- **Port 443 through Tailscale Serve.** The app listens on `127.0.0.1:8744` (8443 was taken on the
  owner's machine) and `pnpm app` runs `tailscale serve --bg --tcp 443 tcp://127.0.0.1:8744`: a plain
  TCP forward, so TLS still ends in the app. A TCP forward cannot share the tailnet's port 443 with a
  Tailscale Serve web handler: another app served on 443 has to move to another port first.
- **Sign in with GitHub, through the GitHub App.** The App's client id and secret, on the callback
  `/auth/github/callback`; the login must be in `SHIPCAST_ALLOWED_GITHUB`. The user token (8 hours)
  and its refresh token (6 months) are then kept in the keychain and refreshed on their own
  ([decisions/github-app.md](decisions/github-app.md)). Without an App in `.env` the old OAuth App
  (`SHIPCAST_GITHUB_CLIENT_ID`, `SHIPCAST_GITHUB_CLIENT_SECRET`) is used, and its token is used once
  and dropped. The session is the login and an expiry signed with HMAC-SHA256 (key in the keychain),
  in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie for 14 days.
- **Console links.** The app prints a single-use sign-in link (15 minutes) when it starts: a way in
  without GitHub for whoever reads the app's own terminal.
- **Previews never touch TLS.** A branch's build shown to the owner before it merges runs with
  `SHIPCAST_APP_TLS=off`: `main.ts` never reads, issues or writes certificate material, never runs
  Tailscale Serve, and serves plain HTTP on `SHIPCAST_APP_HOST` (one address, the tailnet one; every
  interface is refused), with the session cookie's `Secure` flag dropped by `server.ts`, since a
  browser refuses a Secure cookie over HTTP on a tailnet address. On 2026-10-25 an app copy run with
  another data folder obtained a certificate there and wrote its key over the keychain entry the real
  app uses, which then failed to start; that is why. A preview points at a throwaway Postgres restored
  from a copy of the registry, with automation Off.
- **Every request is checked.** A request middleware (`src/start.ts`) sends pages without a session to
  `/login` and answers everything else with 401; Start's CSRF middleware refuses any change whose
  `Sec-Fetch-Site`, `Origin` or `Referer` is not the app's own. Server functions check the shape of
  their input (`src/server/input.ts`) before using it. Two paths are public on purpose: `/api/health`
  (it answers `ok` and nothing else) and the GitHub webhook, which carries its own proof.
- **The REST API checks its own tokens.** `/api/v1/*` takes only `Authorization: Bearer <token>`, never
  the session cookie, so it is left out of the session and same-origin checks and cannot be forged
  from another site ([api.md](api.md), [decisions/api-tokens.md](decisions/api-tokens.md)). The one
  exception is WebMCP's same-origin calls, with their marker header, while the owner has turned that
  experiment on ([decisions/mcp.md](decisions/mcp.md)).
- **The MCP endpoint takes the same tokens.** `/mcp` serves the [MCP server](mcp.md) over Streamable
  HTTP, left out of the session and same-origin checks like the API: it checks the bearer token first
  and refuses a browser `Origin` other than the app's.

## Sections

- **Launches** (`/`): every launch as the specimen's launch card (state pill, one row per channel
  with its post), what is waiting for the owner on a yellow band, and the last day's jobs of the
  queue, refreshed while something runs. `/api/launches` gives the same as JSON behind the session,
  with each launch's jobs; scripts and the MCP server use the [REST API](api.md) instead.
- **A launch** (`/launches/<id>`): its drafts read from the pull request's branch, each article and
  channel text editable (a save is a commit on that branch), the media, **Approve and publish**
  (merges the pull request with a squash, then queues the publishing, which waits for the site to
  deploy), failed channels with **Try again** (that launch only, as a job of its own), the launch's
  jobs, and the latest numbers by source.
- **Launch a repo** (`/launch`): the owner's repos (a combobox with a search) and their releases (a
  select), the [pre-flight check](engine.md#the-pre-flight-check) shown as Ready / Blocks / Advice,
  and the choice between reviewing the drafts first or publishing without review. Drafting is a job
  of the queue.
- **Write** (`/write`): an article in the owner's words, in Spanish or English; the channels it
  also goes to (those with a working account, plus the drafts-only ones); review first or publish
  directly. See [articles](engine.md#articles-written-in-the-app).
- **Channels** (`/channels`): see [accounts.md](accounts.md). A newly connected account lands on the
  list, scrolled to and focused. The **Anthropic API** and an **OpenAI-compatible server** are
  connected here too, as AI providers.
- **Automation** (`/automation`): below.
- **AI** (`/ai`): below.
- **API** (`/tokens`): the REST API's tokens, created with a name and scopes (`read`, `write`), shown
  once, listed with when each was last used, and revoked. See [api.md](api.md).
- **Stats** (`/stats`): a placeholder with its illustration until the stats section of milestone 5
  arrives, so the phone's bottom bar keeps its four sections from now on.
- **Settings** (`/settings`): below.

Every action's outcome is a toast in Cartel (Done, Failed with its diamond, Waiting for you on
yellow), and every error is explained for a person, with the original text folded under Details
(`src/components/errors.ts`). Scrolling is smoothed by Lenis, off for anyone who asks the system for
reduced motion.

**AI cost is never shown**, in any page or in the CLI ([decisions/ai-providers.md](decisions/ai-providers.md)).

## The interface

Built on 2026-10-25, the first part of milestone 3 of the [goal after the MVP](plans/goal-after-mvp.md),
on the [approved design direction](decisions/app-design-direction.md).

- **The shell** (`src/routes/_app.tsx`). On wide screens the top bar holds the lockup, the sections
  (Launches, Write, Channels, Stats, Automation, AI, API), Search with its shortcut, and the signed-in
  user as a menu with Settings and Sign out. Below 860 px the sections leave the top for a **bottom
  bar** in reach of the thumb: Launches, Write, Channels, Stats and **More**, which opens a drawer
  with Automation, AI, API, Settings, Launch a repo, the search and the signed-in account with Sign
  out. The current section is `aria-current="page"` in both (a launch's page and Launch a repo count
  as Launches); there is a skip link to the content, `<main>` is a landmark, every target is at least
  44 px, focus is the yellow ring, and Escape closes any popup with focus back where it was.
- **Section headers are Cartel bands** (`PageHead`): the neutral band, the huge uppercase title, a line
  under it and the section's main action, yellow when there is one (Launch a repo on Launches). Below
  it the work area is calm. Yellow bands stay for what waits for the owner.
- **The command palette**: ⌘K or Ctrl+K anywhere, Search in the top bar, or More on a phone. It
  filters the sections (AI and Settings among them) and the main actions (launch a repo, write,
  connect an account, run an automation round, create a token, sign out); Enter runs the
  highlighted one.
- **The components** are Base UI wearing Cartel only, typed wrappers in `src/components/ui/`, styled in
  `src/styles/components.css`: Dialog, an AlertDialog behind `ConfirmButton` (it replaced every
  `window.confirm`: disconnecting an account, rotating the webhook secret, revoking a token,
  clearing a setting), Combobox, Select (a release, a connection's brand, the AI page's providers and
  preview launch), Menu (an account's secondary actions), Tabs, Tooltip, Popover, Drawer, the toasts
  and the palette. See [decisions/component-layer.md](decisions/component-layer.md). They are
  reviewed running at the hidden route `/design/components`.
- **Illustrations wired in**: the 404 page ("Return to sender") and the error boundary ("Damaged on
  the way", with Try again), both inside the shell when a section fails and on their own otherwise;
  the empty states for no launches, no drafts on a launch's page and no connected accounts; the
  sign-in page; the Automation header; the Stats placeholder.
- **Reflow to WCAG 2.2 at 320 CSS px.** The page no longer hides horizontal overflow
  (`overflow-x: clip` is gone); what overflowed was fixed instead: the card and two-column grids use
  `minmax(min(100%, N), 1fr)`, forms and fields are `minmax(0, 1fr)` grids, flex and grid children get
  `min-width: 0`, segmented controls stack under 560 px, record tables become blocks under 640 px,
  long URLs, refs, paths, handles and secrets break with `overflow-wrap: anywhere` (`.break`,
  `.copyable`, table cells), and on phones each launch row shows its piece and link under the
  channel's name, wrapped where it must (on wide screens the link is clamped to one line with the
  full address in a tooltip).
- **The reflow check** (`apps/web/scripts/reflow-check.ts`): a Lighthouse gate cannot run in CI
  without a database and a session, so this script runs against a live instance instead. It signs in
  with a console link (or a session saved with `--state`), opens every page at the widths given (320
  by default; 320, 390 and 1280 for a full pass), opens the command palette, an alert dialog and the
  phone's drawer, and fails on horizontal overflow (`scrollWidth > innerWidth`, naming the widest
  elements) or on any axe-core violation of serious or critical impact (WCAG 2.0–2.2 A/AA and best
  practices). `--shots <dir>` saves screenshots. It is not part of `pnpm test`.

## Automation

Added on 2026-10-25 ([plans/mvp-close.md](plans/mvp-close.md)); on the job queue since phase 6
([decisions/job-queue.md](decisions/job-queue.md)). The app is a worker of the queue from its start,
so nothing depends on a terminal running `watch`; `server.ts` warms the app's context through
`/api/health` as soon as it listens, and the first round runs 15 seconds later. Each round sends the
next one an interval later; a round is a singleton across processes, so the app and `shipcast watch`
never run the same round twice.

- **The mode**, chosen in the page and kept in the registry: **Rounds** (polling the account's events
  every interval, at least 60 seconds), **GitHub webhooks** (GitHub's deliveries claim releases and
  merges as they happen; the rounds still publish what is ready), or **Off** (only the owner's
  actions: no rounds, and the scheduled metric reads and token refreshes skip). Rounds is the
  default. The metrics are read every six hours and the Instagram tokens checked daily, as jobs of
  their own on cron schedules. Saving the settings moves the next round to 15 seconds later.
- **The webhook** (`POST /api/github/webhook`): trusted only with a valid `X-Hub-Signature-256`
  (HMAC-SHA256 of the exact body, compared in constant time) made with the GitHub App's webhook
  secret or the per-repo secret below; acted on only while webhooks are the chosen mode, answered at
  once (GitHub gives up after ten seconds) with the work queued as a `delivery` job. A `ping`
  answers; the App's `installation` and `installation_repositories` events make Shipcast look its
  installation up again, in any mode; a published release is claimed by the same rules as polling
  (`claimEvent`, so a release is never launched twice whichever way it arrives) and then drafted; a
  repo made public likewise; a merged pull request in the launches repo publishes its launch.
  Everything else is answered and ignored with its reason.
- **The GitHub App delivers for every repo it is installed on**, so nothing is set per repo. The
  per-repo secret from before the App is still generated in the page (32 random bytes), kept in the
  keychain, shown once and rotatable after a confirmation, with the payload URL, the content type and
  what to tick on GitHub for a webhook set by hand.
- **What happened**: the last round and the last delivery, with their lines; and **Run a round now**,
  which moves the round already queued to now (refused while one is running, in any process).
- GitHub can only deliver once the app is reachable from it, which is the VPS's job; signed test
  deliveries (a ping, an ignored event, a bad signature, a merge with no launch, an installation
  change) answered as expected on 2026-10-25.

## AI

Added on 2026-10-25 ([decisions/ai-providers.md](decisions/ai-providers.md)); since the component
layer it has the section band and Base UI selects, the rest of its redesign comes later
(`src/routes/_app/ai.tsx`, `src/server/ai.functions.ts`):

- **Providers**: per task (the launch content pack, an article's distribution, the writing
  assistant) a provider (claudio, the Anthropic API, an OpenAI-compatible server; the ones without a
  connected account say so) and a model, empty for the provider's default. And the **tone**, which
  replaces `brand.yml`'s in every prompt when set.
- **Prompts**: each channel's brief, each kind of pack's brief and the article's translation, as
  templates with `{{variables}}`. A save is a new version; the versions are listed with their dates
  and any of them, or the default, can be restored.
- **Locked**: the rules that keep generated text true to the code (and to the article), and the
  content pack's JSON Schema, shown read-only.
- **Preview**: the final system prompt and prompt a past launch would get with the saved prompts and
  tone, rendered without calling an AI.

The selection actions and side chat of the writing assistant come later, with the redesign
([decisions/app-design-direction.md](decisions/app-design-direction.md)).

## Settings

Added on 2026-10-25 ([decisions/github-app.md](decisions/github-app.md)); since the component layer
it has the section band, and its Clear asks first (`src/routes/_app/settings.tsx`,
`src/server/settings.functions.ts`):

- **Each setting** that is not the bootstrap: the launches repo, claudio's URL and token, the AI
  budget per generation, the Instagram app id and secret. Each says where its value comes from (saved
  here, the keychain, or `.env` until it is saved here); secrets are shown as set or not, never sent
  to the page. A save checks every value first (the launches repo is `owner/name`, claudio's URL is
  `http(s)://`, the budget a positive number), applies to what runs next without a restart, and a
  **Clear** removes a saved one. What is still missing is listed at the top; a page that needs a
  missing setting says which one and to set it here.
- **GitHub**: how the engine reaches it (the App, whose commits are by `<slug>[bot]`, or the old
  token), the App's installation (account, all or selected repos, permissions), how the owner signs
  in, and the owner's user token with its expiry (refreshed on the page's own read when due).

## How it is built

- **TanStack Start** (React 19, Vite 8), file routes in `src/routes/`, pages under the `_app`
  layout. Server functions live in `src/server/*.functions.ts`; what only the server may load in
  `*.server.ts`.
- **The engine is not bundled.** The workspace packages are external to the server build and run
  through Node's own TypeScript support, as they do for the CLI, so the native and wasm renderers of
  `@shipcast/assets` and Playwright never go through Vite. Client dependency discovery is turned off
  for the same reason; the Base UI entry points the app uses are listed for pre-bundling instead
  (`BASE_UI` in `vite.config.ts`). A consequence in development: a change to an engine package needs
  a restart of `pnpm app:dev`.
- **Production runs Node's own server** (`apps/web/server.ts`): the built Start handler is a `fetch`
  function; the server converts requests, serves `dist/client` with long caching for hashed assets,
  and terminates TLS. No Nitro.
- **One context per process** (`src/server/context.server.ts`), built by the runtime the CLI shares
  (`createRuntime` in `@shipcast/runtime`): the bootstrap, the registry, the keychain, the settings
  (with the one-time import from `.env` at start), the GitHub client on the App's installation
  tokens, the brand (read from the launches repo every five minutes), the AI settings' provider for
  each task (read before each AI call) and the job queue, whose workers it starts and stops on
  SIGTERM or SIGINT. The repo's root is found by its `pnpm-workspace.yaml` from where the app runs,
  not from the module's path, which differs between development and the bundle.
- **Jobs are durable** ([decisions/job-queue.md](decisions/job-queue.md)): drafting, publishing, an
  article, a channel's retry and a delivery are pg-boss jobs on the registry's Postgres
  (`src/server/work.server.ts` sends them, `@shipcast/runtime` runs them). A job sent before a restart
  runs after it; the wait for a deploy is a retry every 30 seconds for 20 minutes. The pages and the
  REST API's `/jobs` read the registry's `jobs` rows (`src/server/jobs.server.ts`): title, state,
  attempts, log lines, link.
- **The REST API** is one server route, `src/routes/api/v1/$.ts`, handing every request to
  `src/server/api.ts`, where one table holds each route's method, path, scope and handler, and the
  OpenAPI document is built from it. Requests that start work are checked by the same functions as
  the pages' (`src/server/requests.ts`). Its dependencies are built per request in
  `src/server/api-deps.server.ts`, shared with `/mcp`.
- **The MCP server** is `src/routes/mcp.ts`, a thin route over `@shipcast/mcp` (`packages/mcp`):
  each tool calls `handleApi` in-process with the caller's own `Authorization` header. WebMCP's
  module, `@shipcast/mcp/webmcp`, exports `mountWebMcp({ enabled })` for the shell to call once it reads
  the `webmcp:enabled` setting; it is not mounted yet.

## Related

[[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[decisions/job-queue.md]] · [[plans/goal-finish.md]] · [[plans/mvp-close.md]] · [[plans/design-system.md]] · [[decisions/web-app-stack.md]] · [[api.md]] · [[decisions/api-tokens.md]] · [[decisions/ai-providers.md]] · [[decisions/app-design-direction.md]] · [[decisions/github-app.md]] · [[mcp.md]] · [[decisions/mcp.md]] · [[status.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]]
