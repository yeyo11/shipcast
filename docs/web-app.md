---
created_at: 2026-10-28T08:07:05.847023162Z
updated_at: 2026-10-29T15:36:58.968755675Z
tags:
    - web-app
    - dashboard
    - webhooks
    - realtime
    - services
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
and signs in with nothing else configured. On a server the app runs in a container behind a proxy
that does TLS, and the same entry point can run as a `web`, `worker` or `heavy` process
(`SHIPCAST_ROLE`); a worker serves only `/livez` and `/readyz` ([server.md](server.md)).

## How it reaches the owner, and only the owner

- **One private address on a desktop install: `https://shipcast.josegarrido.dev`.** Its A record
  points at the machine's tailnet address, so only the owner's devices on the tailnet can reach it.
- **HTTPS with a real certificate.** Tailscale Serve only issues `*.ts.net` certificates, so the app
  gets its own from Let's Encrypt through the DNS challenge (`apps/web/tls.ts`, with `acme-client`): a
  TXT record proves control, since no authority can reach a tailnet address. The record is placed by
  a `DnsSolver`: Cloudflare's API with `SHIPCAST_TLS_CLOUDFLARE_TOKEN`, or by hand with
  `scripts/certificate-by-hand.ts`. The certificate lives in `data/tls/`, its key and the ACME account
  key in the keychain; it is renewed when less than 30 days remain, checked daily and swapped in
  without a restart. `acme-client` pulls `node-forge`, whose advisory GHSA-86w9-cpqp-85rv is in a path
  Shipcast never takes: `pnpm audit` ignores it, with the reason, in `pnpm-workspace.yaml`. Behind a
  proxy (`SHIPCAST_APP_TLS=proxy`) none of this runs: the proxy does TLS.
- **Port 443 through Tailscale Serve** (desktop). The app listens on `127.0.0.1:8744` and `pnpm app`
  runs `tailscale serve --bg --tcp 443 tcp://127.0.0.1:8744`: a plain TCP forward, so TLS still ends
  in the app.
- **Sign in with GitHub, through the GitHub App.** The App's client id and secret, on the callback
  `/auth/github/callback`; the login must be in `SHIPCAST_ALLOWED_GITHUB`. The user token (8 hours)
  and its refresh token (6 months) are kept in the secret store and refreshed on their own
  ([decisions/github-app.md](decisions/github-app.md)); with the secrets table, a refresh writes only
  over the version it read, so two replicas never lose the good token. Without an App in `.env` the
  old OAuth App is used. The session is the login and an expiry signed with HMAC-SHA256 (its key
  created once, under a lock), in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie for 14 days.
- **Console links.** The app prints a single-use sign-in link (15 minutes) when it starts: a way in
  without GitHub for whoever reads the app's own log. With `redis-state` the links (and OAuth's
  `state`) are one-time values in Redis, so any replica redeems them.
- **Previews never touch TLS.** A branch's build shown to the owner before it merges runs with
  `SHIPCAST_APP_TLS=off`: `main.ts` never reads, issues or writes certificate material, never runs
  Tailscale Serve, and serves plain HTTP on `SHIPCAST_APP_HOST` (one address; every interface is
  refused), with the session cookie's `Secure` flag dropped. On 2026-10-25 an app copy run with
  another data folder obtained a certificate and wrote its key over the keychain entry the real app
  uses, which then failed to start; that is why. A preview points at a throwaway Postgres, with
  automation Off.
- **A preview with fake networks writes nowhere.** With `SHIPCAST_PREVIEW_FAKE_NETWORKS=1` and
  either `SHIPCAST_APP_TLS=off` or, behind a proxy, a database whose name ends in `_preview`
  (`packages/runtime/src/preview/guard.ts`): every channel, YouTube and the notifier are fakes that
  write what they were sent to a ledger in the preview's own database, so every replica's lands in
  one place; fixtures can stand in for GitHub's reads, and the GitHub client's writes are **dry runs**
  (`previewGitHubFetch`: shas of the right shape, pull request number 0). A process on a `_preview`
  database without the switch refuses to start, and the CLI on one only runs the commands that reach
  no network. The App's token minting and the sign-in keep the real fetch.
- **Every request is checked.** A request middleware (`src/start.ts`) sends pages without a session to
  `/login?next=<the page>` and answers everything else with 401, marked `x-shipcast-session: required`.
  When a session ends while a page is open, `components/SessionExpiry.tsx` reads that mark on the next
  server call and sends the owner to sign in again; `next` rides through GitHub in a ten-minute
  `sc_next` cookie and brings them back. Only a path of the app is followed (`server/next-path.ts`).
  Start's CSRF middleware refuses any change whose `Sec-Fetch-Site`, `Origin` or `Referer` is not the
  app's own. Server functions check the shape of their input (`src/server/input.ts`). Public on
  purpose: `/api/health` and `/livez` (they answer `ok`), `/readyz` (each check's state, never an
  address), and the GitHub webhook, which carries its own proof.
- **The REST API checks its own tokens.** `/api/v1/*` takes only `Authorization: Bearer <token>`, never
  the session cookie ([api.md](api.md), [decisions/api-tokens.md](decisions/api-tokens.md)). Its
  failure limiter keys on the client address, read from `X-Forwarded-For` only behind a listed proxy
  (`SHIPCAST_TRUSTED_PROXIES`), and lives in Redis with `redis-state`. The one exception to the
  bearer rule is WebMCP's same-origin calls while the owner has turned that experiment on
  ([decisions/mcp.md](decisions/mcp.md)).
- **The MCP endpoint takes the same tokens.** `/mcp` serves the [MCP server](mcp.md) over Streamable
  HTTP, checking the bearer token first and refusing a browser `Origin` other than the app's.

## Sections

- **Launches** (`/`): one summary card per launch in a grid (two columns on a desktop): its title
  and state pill, the repo and the date in the owner's zone, its views, reactions, comments and
  clicks, the views per day since the launch as an area chart (a line in `--sc-chart` over a fill
  fading to transparent), and one **mark** per channel (its glyph, a state dot: green published,
  yellow ring scheduled, red failed, dotted not launched; a small count when it went out on more than
  one of the brand's accounts). The marks stay on one row: problems first, as many as the card's
  width holds, the rest behind a "+n" menu. Every mark opens the same menu (`ResponsiveMenu`), a line
  per post and a way to the channel on the launch page; while it is open the card's numbers and chart
  turn to that channel, morphed with Motion (instant under reduced motion). **The cards' surface** is
  Cartel's neutral raised one, on the role tokens, so they hold AA contrast in both themes. **What
  waits leaves the grid**: a launch waiting for the owner's approval is a slim yellow row above it
  (**Review the drafts** and Edit the drafts), and one that is drafting or was not launched a quiet
  dashed row. The split is `splitLaunches` in `src/server/launch-list.ts`, tested. **A launch's state
  is read from its pieces too** (since 2026-10-28): a drafted launch with pieces out or scheduled is
  **Going out** or **Scheduled** and a card in the grid (`stateOf` in `src/server/launches.server.ts`,
  tested). **Each title has the project's picture**, the repo owner's public GitHub avatar, or our own
  parcels (a release) or typewriter (an article) when there is none. The app sends no
  Content-Security-Policy; one added later must allow `https://github.com` and
  `https://avatars.githubusercontent.com`. The queue's jobs are on Automation. `/api/launches` gives
  the launches as JSON behind the session; scripts and the MCP server use the [REST API](api.md).
- **A launch** (`/launches/<id>`): a compact header, its toolbar (All launches and the state pill;
  Open the article, and Publish what is pending in yellow), a slim yellow strip with **Approve and
  publish** while its drafts wait, then **its numbers first**: the totals and views per day as bars.
  One quiet line links what waits on the owner. Below, four tabs kept in the address (`?tab=`,
  `?channel=`): **Channels** (a strip of channel chips; each piece with its link, its numbers over
  time, Edit and Delete or Unpublish where its network allows them, Retry when it failed, its time
  while it is not out yet; Edit selected and Delete everything above the panel), **Content** (what
  went out, or the drafts, editable while the pull request is open: a save is a commit on its
  branch), **Search engines** and **Details** (properties, accounts, the last reading of every number,
  the launch's jobs). A launch that failed before its drafts were written opens on **Details**, and a
  release with nothing out has **Launch it again**. **Where the drafts come from**: with
  `github-events` the page reads the drafts snapshot in the registry, never GitHub (the
  [engine](engine.md#reviewing-and-approving) keeps it current from webhooks and an hourly poll), and
  **Refresh from GitHub** (`refreshDrafts`) reads the pull request again; without the flag every view
  reads GitHub, as before.
- **Launch a repo** (`/launch`): the owner's repos (a combobox) and their releases (a select), the
  [pre-flight check](engine.md#the-pre-flight-check) shown as Ready / Blocks / Advice, and the choice
  between reviewing the drafts first or publishing without review. Drafting is a job of the queue.
- **Write** (`/write`): an article in the owner's words, in Spanish or English; the channels it also
  goes to; review first or publish directly. See [articles](engine.md#articles-written-in-the-app).
  The text has the **writing assistant** ([decisions/writing-assistant.md](decisions/writing-assistant.md)),
  here and in each draft's editor: quick actions on the selected text (improve, shorten, translate,
  titles, adapt to a network, check against the code), a side chat, and every proposal a word-by-word
  diff to accept or reject. Its chats are saved as they stream and listed from a History button. The
  actions and the chat stream from the AI task runner, and **check against the code** is a `heavy`
  job (a clone and an AI run) that the page follows until its result, never work inside the request.
  On a phone (760 px and under) the chat is a floating bubble that opens a full-screen sheet.
- **Channels** (`/channels`): see [accounts.md](accounts.md#the-channels-page). Four tabs by kind of
  network (Social networks, Blog & newsletter, Measurement, AI providers; `?tab=`), each account a
  card. The **Anthropic API** and an **OpenAI-compatible server** are connected here too, under AI
  providers. The toolbar's **Connect a network** is a menu of every network that takes an account,
  listed from the channel adapters; networks that still work from `.env` add **Import from .env**.
- **Comments** (`/comments`): the comments on the owner's posts and the replies drafted for them
  ([decisions/comment-assistant.md](decisions/comment-assistant.md)). One page at a time (25), every
  filter in the address and applied by the database: state, channel, launch, post and words
  (`?state=&channel=&launch=&post=&q=&page=`). The query is the comments repository's `commentsPage`
  (one join of comment and post, a count of the same filter; no query per row) and `commentFacets`.
  **The words** are `ILIKE '%words%'` on the text, the author's handle and name, served since
  2026-10-27 by `pg_trgm` GIN indexes (migration `0010_comments_search`): on 50,000 synthetic comments
  a word found in one comment went from 130 ms to 2 ms. **Approve and send** asks first in the app's
  alert dialog. Each channel's reply mode is below the list.
- **Stats** (`/stats`): how the launches did, in four tabs: Overview, Ranking, Accounts and Search.
  See [stats.md](stats.md#the-page).
- **Settings** (`/settings`): one area with a submenu: General (`/settings`), AI (`/settings/ai`),
  Automation (`/settings/automation`) and API (`/settings/api`); the old `/ai`, `/automation` and
  `/tokens` redirect to them.

Every action's outcome is a toast in Cartel, and every error is explained for a person, with the
original text folded under Details (`src/components/errors.ts`). Scrolling is smoothed by Lenis, off
under reduced motion.

**AI cost is never shown**, in any page or in the CLI ([decisions/ai-providers.md](decisions/ai-providers.md)).

## Live pages

Since 2026-10-28, behind `realtime-ui` ([decisions/redis.md](decisions/redis.md#realtime)). Every
registry write announces what changed (ids only) on the event bus, from whichever process wrote it;
each browser tab opens **one** server-sent event stream (`/api/events`, `LiveHub` in
`packages/runtime/src/realtime/`), resumed with `Last-Event-ID` and answered with `resync` after a
gap. A page names its interests (`useLiveRoute` for a route's loader, `useLiveInterest` for a
component, in `components/live/Live.tsx`): the launches list, a launch (its own `launch:<id>`,
`post:<id>`, `job:<id>`, `comment:<id>`, `metrics:<id>`), Comments, Stats, Channels, Automation, the
attention bell and a profile review. Only the loader an event concerns reloads. An idle tab makes
about 0.2 requests a minute.

Without the flag (production runs with it since 2026-10-29) the pages poll as before: a launch page
every 5 s while a job runs (never a second read while one is on its way), Automation every 4 s while
work runs, the bell every three minutes, a followed job every 3 s. With processes split by role,
`realtime-ui` needs `redis-state`, whose bus carries a job's events from the worker to the web
replicas.

## The interface

Built on 2026-10-25, the first part of milestone 3 of the [goal after the MVP](plans/goal-after-mvp.md),
on the [approved design direction](decisions/app-design-direction.md).

- **The shell** (`src/routes/_app.tsx`). On wide screens the top bar holds the lockup, the five
  working sections (Launches, Write, Channels, Comments, Stats), Search as an icon-only button, the
  **attention bell** and the signed-in user as a menu: **Settings is a submenu** (General, AI,
  Automation, API), then Take the tour and Sign out. The submenu's item for the page on screen is
  `aria-current="page"`; which page is current is the pure, tested `currentSettingsPage`
  (`src/server/settings-pages.ts`). Below 860 px the sections leave the top for a **bottom bar**:
  Launches, Write, Channels, Stats and **More**, which opens a drawer with the rest. There is a skip
  link to the content, `<main>` is a landmark, every target is at least 44 px, focus is the yellow
  ring, and Escape closes any popup with focus back where it was.
- **The attention bell** (`components/AttentionBell.tsx`): a notifications inbox. A 44 px icon button
  with, when something needs the owner, the count as an 18 px yellow pill ("9+" above nine), named by
  the count for assistive technology. It opens a `ResponsiveMenu` with a link per line: launches
  waiting for approval, launches with posts that failed, comments waiting for a reply, accounts that
  need reconnecting and, not counted, posts scheduled within a day. Every line has **Dismiss**
  (Delete or Backspace on the focused line) and the panel a **Clear all**. Dismissals live in the
  registry (`attention_dismissals`, migration `0009`), so they hold across devices. **The rule**: a
  line's key names its condition with its state (`launch:<id>:waiting:<updated at>`,
  `launch:<id>:failed:<digest>`, `comments:waiting:<newest id>`, `account:<id>:reconnect:<digest>`,
  `launch:<id>:scheduled:<first time>:<posts>`); a dismissed line stays hidden while that condition
  lasts, and each read forgets the dismissals of lines no longer there. `getAttention` reads
  everything in one round, with no query per launch; the pure `attentionItems` and `buildAttention`
  (`src/server/attention.ts`, tested) turn the reads into the list. It is read again on every
  navigation, when the bell opens, and on its events with `realtime-ui` (every three minutes without).
- **Section headers are Cartel bands** (`PageHead`) at **one height on every page** (200 px on a wide
  screen), so moving between sections never shifts the work area; a Settings section's head
  (`SectionHead`) is 140 px. **The banner folds** to 104 px (80 px for a section head) with the title
  keeping its size; the choice is kept in the `sc_banner` cookie and read on the server
  (`getBanner`), so the page is drawn at the right size from the start. Phones (under 760 px) always
  get the folded design.
- **The toolbar** (`components/PageToolbar.tsx`) sits under every banner: the page's controls on the
  left, its actions on the right (`ToolbarAction`: one yellow primary, the rest quiet; `ToolbarMore`
  for the overflow). 56 px, sticky, lifted by a soft shadow once stuck. On a phone it stays one row.
  Settings' layout renders a `PageToolbarHost` under its banner, and each section's toolbar is drawn
  there through a portal. Only Launch a repo has no bar. What waits for the owner is in the bell; the
  one-line `.strip` is what a page may show for its own pending matter.
- **The command palette**: ⌘K or Ctrl+K anywhere, Search in the top bar, or More on a phone; it
  filters the sections and the main actions.
- **The first-run onboarding and the tour** ([decisions/onboarding.md](decisions/onboarding.md)): a
  centred wizard on the first sign-in (its provider test runs through the provider module's own
  readiness or one cheap call on the AI task runner), then an optional tour (NextStep) driven by one
  controller, `components/tour/TourRuntime.tsx`, which waits for each target to settle before moving.
- **The components** are Base UI wearing Cartel only, typed wrappers in `src/components/ui/`, styled in
  `src/styles/components.css`: Dialog, an AlertDialog behind `ConfirmButton` (nothing in the app calls
  the browser's `confirm` or `alert`), Combobox, Select, Menu, Tabs, Tooltip, Popover, Drawer, the
  toasts and the palette, the date pickers (`DatePicker`, `DateRangePicker`) and the **time field**
  (`TimeField`, 24 hours, its pure parts in `ui/dates.ts`, tested). **ResponsiveMenu** is the Popover
  on a desktop and the Drawer on a phone. **Collapsible** and **Accordion** replaced the native
  `<details>`; **ScrollArea** is Cartel's scrollbar for regions inside a page. See
  [decisions/component-layer.md](decisions/component-layer.md); reviewed at `/design/components`.
- **Illustrations wired in**: the 404 page, the error boundary, the empty states, the sign-in page,
  the Stats page's loading and empty states, a launch's picture when it has no avatar.
- **Reflow to WCAG 2.2 at 320 CSS px**: no hidden horizontal overflow; grids, forms and long strings
  are built to fit, and one-row strips scroll sideways on a phone.
- **The reflow check** (`apps/web/scripts/reflow-check.ts`) runs against a live instance: it signs
  in, opens every page at the widths given (320, 390 and 1280 for a full pass), opens the palette, an
  alert dialog, the drawer, the assistant, the tour, the date pickers, Comments' filters and every
  Channels tab, and fails on horizontal overflow or on a serious or critical axe-core violation. It is
  not part of `pnpm test`.

## Automation

Added on 2026-10-25 ([plans/mvp-close.md](plans/mvp-close.md)); on the job queue
([decisions/job-queue.md](decisions/job-queue.md)); a section of Settings (`/settings/automation`).
A process that works queues (`all`, `worker`) is a worker from its start, so nothing depends on a
terminal running `watch`; `server.ts` warms the app's context through `/api/health` as soon as it
listens, and the first round runs 15 seconds later. Each round sends the next one an interval later;
a round is a singleton across processes.

- **The mode**, kept in the registry: **Rounds** (polling the account's events every interval, at
  least 60 seconds), **GitHub webhooks** (deliveries claim releases and merges as they happen; the
  rounds still publish what is ready), or **Off** (only the owner's actions). With `github-events` the
  round's own detection runs at most hourly whatever the mode, as a safety net. Saving the settings
  moves the next round to 15 seconds later and, with `redis-state`, tells every replica to read the
  settings again (`settings.changed`).
- **The webhook** (`POST /api/github/webhook`, `src/server/webhook.server.ts`): trusted only with a
  valid `X-Hub-Signature-256` (HMAC-SHA256 of the exact body, compared in constant time) made with the
  GitHub App's webhook secret or the per-repo secret below; answered at once with the work queued as a
  `delivery` job. A `ping` answers; the App's `installation` events make every replica look its
  installation up again, in any mode; a published release is claimed by the same rules as polling
  (`claimEvent`); a merged pull request in the launches repo publishes its launch, while webhooks are
  the chosen mode. With `github-events` bodies over 5 MB are refused before they are read, a
  redelivery of an id already handled is dropped, a `pull_request` of the launches repo queues its
  drafts snapshot's refresh and a `push` forgets the cached files it touched, whatever the mode.
- **The GitHub App delivers for every repo it is installed on**. The per-repo secret from before the
  App is still generated in the page (32 random bytes), kept in the secret store, shown once and
  rotatable.
- **Work in progress**: the queue's jobs of the last day, each with its last log line and its state,
  followed while one runs (on its events with `realtime-ui`). Ten to a page, with a filter by state
  and its counts; the database cuts the pages (`jobsPage` in `src/server/jobs.server.ts`, over the
  jobs repository's `jobs` and `jobCounts`). See [api.md](api.md#paging-the-work-list).
- **What happened**: the last round and the last delivery; and **Run a round now**, which moves the
  queued round to now (refused while one is running, in any process).
- GitHub can only deliver once the app is reachable from it: since 2026-10-29 production's webhook
  route is public on a hostname of its own, and only that route ([server.md](server.md#webhooks)).

## AI

Added on 2026-10-25 ([decisions/ai-providers.md](decisions/ai-providers.md), superseded in part by
[decisions/ai-layer.md](decisions/ai-layer.md)); a section of Settings (`/settings/ai`,
`src/server/ai.functions.ts`), and **all** AI configuration lives there:

- **claudio**: its URL and token ([claudio.md](claudio.md)). The global AI budget that used to sit
  here (`ai-budget-usd`, `SHIPCAST_MAX_BUDGET_USD`) was removed on 2026-10-29: each task's spend
  limit, below, is the only one.
- **Providers**: per task (the launch content pack, an article's distribution, the writing
  assistant, comment replies, profile reviews) a provider (claudio, the Anthropic API, an
  OpenAI-compatible server; the ones without a connected account say so) and a model, empty for the
  provider's default; the list comes from the provider registry. Beside each model, the task's
  **spend limit** ("Spend limit, USD"; the writing assistant has two, per suggestion and per check
  against the code), empty for the task's default, shown as its placeholder; saved under the AI
  settings' `budgets`, at most 50 USD, applied only by claudio ([engine.md](engine.md#the-ai)). It
  is a limit: no spent amount is shown. And the **tone**, which replaces `brand.yml`'s in every
  prompt when set.
- **Prompts**: each channel's brief, each kind of pack's brief and the article's translation, as
  templates with `{{variables}}`. A save is a new version; any version, or the default, can be
  restored.
- **Locked**: the rules that keep generated text true to the code (and to the article), the rules
  for a profile review, and the content pack's JSON Schema, shown read-only.
- **Preview**: the final prompts a past launch would get, rendered without calling an AI.

## Settings

Added on 2026-10-25 ([decisions/github-app.md](decisions/github-app.md)). **One area with a submenu**:
General, AI, Automation and API (the REST API's tokens; see [api.md](api.md)). The layout is
`src/routes/_app/settings.tsx`; each section is a route under `src/routes/_app/settings/`, with the
same frame. A setting is configured in exactly one place. General:

- **Each setting** that is not the bootstrap and not the AI's: the launches repo and the Instagram,
  Threads, LinkedIn, Reddit and YouTube app ids and secrets. Each says where its value comes from
  (saved here, the secret store, or `.env` until it is saved here); secrets are shown as set or not,
  never sent to the page. A save checks every value first, applies to what runs next without a
  restart (on every replica, with `redis-state`), and a **Clear** removes a saved one.
- **GitHub**: how the engine reaches it, the App's installation, how the owner signs in, and the
  owner's user token with its expiry.

## How it is built

- **TanStack Start** (React 19, Vite 8), file routes in `src/routes/`, pages under the `_app`
  layout. Server functions live in `src/server/*.functions.ts`; what only the server may load in
  `*.server.ts`.
- **Entry points are thin** ([decisions/architecture.md](decisions/architecture.md)): a server
  function or an API route checks its input, calls one of the engine's application services and maps
  the result. `src/server/app-services.ts` builds the services once for the server functions, the
  launch page's actions and the REST API alike. dependency-cruiser refuses a route, component or
  `*.functions.ts` that imports a connector or a repository. Errors are mapped to an answer in one
  place, `src/server/errors.ts`, from `ShipcastError`'s own HTTP status.
- **The engine is not bundled.** The workspace packages are external to the server build and run
  through Node's own TypeScript support, so the native and wasm renderers of `@shipcast/assets` and
  Playwright never go through Vite. A change to an engine package needs a restart of `pnpm app:dev`.
- **Some npm libraries are bundled** (since 2026-10-29, `BUNDLED` in `apps/web/vite.config.ts`):
  react-day-picker, date-fns, date-fns-jalali, `@date-fns/tz`, Base UI, Floating UI, motion and their
  ESM dependencies. Left external, Node loaded them file by file on the first request that rendered
  them: react-day-picker's locale entry re-exports every locale of date-fns and date-fns-jalali and
  Base UI is hundreds of small modules, so a launch page after a restart imported about 2,900 modules
  (11 to 15 s in production). Bundled, only what the pages use is in the chunks: the launch page's
  cold import went from about 6 s to about 35 ms locally. React stays external, one copy shared with
  the router.
- **The route chunks are warmed at boot** (`src/server/warm.ts`): a process that serves pages imports
  the entry's and the router's lazy chunks before it says it is ready, and `/readyz` answers 503
  `warming` until they are loaded, for at most 60 s; a worker warms nothing
  ([server.md](server.md#health-and-shutdown)).
- **Production runs Node's own server** (`apps/web/server.ts`): the built Start handler is a `fetch`
  function; the server converts requests, serves `dist/client`, terminates TLS when it is not behind
  a proxy, reads the client address from trusted proxies, and on a stop closes idle connections and
  gives requests in flight time to finish. No Nitro. A browser that leaves an event stream aborts its
  request, and the `AbortError` that follows is not logged; every other error is.
- **One context per process** (`src/server/context.server.ts`), built by the runtime the CLI shares
  (`createRuntime`): the bootstrap, the repositories (pool sized per process), the secret store, the
  settings, the GitHub client (with its ETag cache under `github-events`), the brand (read from the
  launches repo every five minutes, and dropped on `brand.changed`), the AI task runner, the flags,
  the role, the process's Redis connections and shared state, the job queue (pg-boss, or BullMQ with
  `bullmq`), the live hub with `realtime-ui`, and the stop's steps in order (HTTP, queue, telemetry,
  Redis, database). A `web` process only sends work; the others work their role's queues.
- **Jobs are durable** ([decisions/job-queue.md](decisions/job-queue.md)): drafting, publishing, an
  article, a delivery, an assistant check are jobs (`src/server/work.server.ts` sends them,
  `@shipcast/runtime` runs them). A job sent before a restart runs after it. The pages and the REST
  API's `/jobs` read the registry's `jobs` rows.
- **Measured** ([measurement.md](measurement.md)): a function middleware times each server function
  and a request middleware each page and API request, with a `Server-Timing` header; the hourly
  `probe` job loads fixed pages in headless Chromium.
- **A launch at a glance** (`src/server/launch-summary.ts`, tested): a launch's totals from the latest
  reading of each counter through the stats section's metric families ([stats.md](stats.md)), each
  channel's totals with only what its network counts, and views per day for every launch of the list
  in one query.
- **The REST API** is one server route, `src/routes/api/v1/$.ts`, handing every request to
  `src/server/api.ts`, where one table holds each route's method, path, scope and handler, and the
  OpenAPI document is built from it. Its dependencies are built per request in
  `src/server/api-deps.server.ts`, shared with `/mcp`.
- **The MCP server** is `src/routes/mcp.ts`, a thin route over `@shipcast/mcp`: each tool calls
  `handleApi` in-process with the caller's own `Authorization` header.

## Related

[[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[server.md]] · [[measurement.md]] · [[decisions/architecture.md]] · [[decisions/redis.md]] · [[decisions/ai-layer.md]] · [[decisions/job-queue.md]] · [[plans/goal-finish.md]] · [[plans/mvp-close.md]] · [[plans/design-system.md]] · [[decisions/web-app-stack.md]] · [[api.md]] · [[decisions/api-tokens.md]] · [[decisions/ai-providers.md]] · [[decisions/app-design-direction.md]] · [[decisions/github-app.md]] · [[mcp.md]] · [[decisions/mcp.md]] · [[status.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]] · [[stats.md]] · [[decisions/comment-assistant.md]] · [[decisions/writing-assistant.md]] · [[decisions/onboarding.md]]