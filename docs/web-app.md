---
created_at: 2026-10-26T16:39:38.711118317Z
updated_at: 2026-10-27T17:40:56.888542084Z
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
    - launch-page
    - stats
    - comments
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
- **A preview with fake networks writes nowhere.** With `SHIPCAST_PREVIEW_FAKE_NETWORKS=1` as well
  (it only works with `SHIPCAST_APP_TLS=off`, which production never is), `src/server/preview.server.ts`
  swaps every connector that would change a post for a fake that answers success, sends the
  connectors' other writes to a fetch that answers an empty success, and, since 2026-10-27, makes the
  GitHub client's writes **dry runs**: `previewGitHubFetch`, passed to `createRuntime` as
  `githubFetch`, lets reads through (drafts, releases, `brand.yml`) and answers every write to a repo
  (a drafts pull request, a commit of an article or of `brand.yml`, a merge) with a logged, plausible
  fake: shas of the right shape, pull request number 0. Before that the GitHub client was the real one
  on a preview, so the onboarding's **Commit brand.yml**, and the drafting a round would start were
  automation left on, wrote to the owner's repos for real; the drafting, draft edits and approving
  the owner starts were already refused, and still are, since they would spend an AI run or act on a
  real pull request. The App's token minting and the sign-in keep the real fetch: without them a
  preview could not read. `apps/web/test/preview-github.test.ts` drives the REST client's writes and
  a runtime through it with a GitHub that fails on any write.
- **Every request is checked.** A request middleware (`src/start.ts`) sends pages without a session to
  `/login?next=<the page>` and answers everything else with 401, marked `x-shipcast-session: required`.
  When a session ends while a page is open, `components/SessionExpiry.tsx` reads that mark on the next
  server call and sends the owner to sign in again instead of showing an error; `next` rides through
  GitHub in a ten-minute `sc_next` cookie (and on a console link) and brings them back to the same
  page. Only a path of the app is followed (`server/next-path.ts`): never another site, the sign-in
  itself, the API or MCP. Start's CSRF middleware refuses any change whose
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

- **Launches** (`/`): one summary card per launch in a grid (two columns on a desktop): its title
  and state pill, the repo and the date in the owner's zone, its views, reactions, comments and
  clicks, the views per day since the launch as an area chart (a line in `--sc-chart`, the brand
  yellow at night and a dark amber by day, where yellow is under 3:1 on the light card, over a
  yellow fill fading from 35% to transparent through an SVG gradient with one id per card; the
  waiting yellow card draws it in black), and one **mark** per channel (its
  glyph, a state dot: green published, yellow ring scheduled, red failed, dotted not launched; a
  small count when it went out on more than one of the brand's accounts). The marks stay on one row:
  problems first, as many as the card's width holds (measured), the rest behind a "+n" menu. Every
  mark opens the same menu (`ResponsiveMenu`), a line per post (labelled by account, language or
  kind; a link in a new tab, or its state) and a way to the channel on the launch page; while it is
  open the card's numbers and chart turn to that channel against the launch's own scale, counted
  and morphed with Motion (instant under reduced motion), without the card changing height.
  **The cards' surface** is Cartel's neutral raised one, like every other card of the app: `--sc-raised`,
  a hairline border and the card radius, with no yellow stamp. Text, the chart (its line on
  `--sc-chart`, 3:1 or more on the card in both themes), the state dots, the marks' tiles and
  menus, the "+n" chip, the accounts count and the scope pill are all on the role tokens, so they hold
  AA contrast in the night and the day theme. The glyphs follow the theme. **What waits leaves the
  grid** (since 2026-10-26): a launch waiting for the owner's approval is a slim yellow row above it
  (its picture, title, repo and date, "Drafts are waiting in the pull request", **Review the drafts**
  and Edit the drafts), and one that is drafting or was not launched a quiet dashed row with a way to
  it. The grid holds only launches that went out (published, in part or failing), every card the
  height of the tallest (`grid-auto-rows: 1fr`, the marks on the card's bottom edge). The split is
  `splitLaunches` in `src/server/launch-list.ts`, tested. **Each title has the project's picture**, a
  40 px tile (`components/ProjectAvatar.tsx`): the repo owner's public GitHub avatar
  (`https://github.com/<owner>.png?size=80`, built by `ownerAvatarUrl` only for a valid login and
  passed through `imageUrl` on the server), lazy and decorative; when there is none or it fails to
  load, our own parcels (a release) or typewriter (an article). A `logo:` in `launch.yml` is the hook
  for a project's own picture, not built yet. The app sends no Content-Security-Policy, so the
  avatar needs no `img-src` change; one added later must allow `https://github.com` and
  `https://avatars.githubusercontent.com`. The top bar's bell says what waits (see The interface).
  The queue's jobs are not here any more: they are on Automation. `/api/launches` gives the launches
  as JSON behind the session; scripts and the MCP server use the [REST API](api.md) instead.
- **A launch** (`/launches/<id>`): a compact header (title, repo, launch date), its toolbar (All
  launches and the state pill; Open the article, and Publish what is pending in yellow), a slim
  one-line yellow strip with **Approve and publish** (and Open the pull request) while its drafts
  wait, then **its numbers first**: the totals (views, reactions, comments, clicks, stars) and views
  per day as bars. One quiet line links what waits on the owner (comments to answer, a channel's
  scheduled time, a running job). Below, four tabs kept in the address (`?tab=`, and `?channel=`):
  **Channels**, a strip of channel chips (glyph and state dot) choosing one channel, shown with its
  totals, each piece with its link, its numbers over time, Edit and Delete (or Unpublish) where its
  network allows them or Retry when it failed, its time while it is not out yet (a day picked in the
  calendar and a time in the time field, both of the component layer), and what the
  network allows in a line; Edit selected and Delete everything sit above the panel. **Content**,
  what went out (or the drafts, editable while the pull request is open: a save is a commit on its
  branch) and the media, folded rows (an Accordion) opened on demand. **Search engines**, each
  engine's view of each language's article. **Details**, the properties, the accounts it went out
  with and how their followers moved, the last reading of every number, and the launch's jobs.
- **Launch a repo** (`/launch`): the owner's repos (a combobox with a search) and their releases (a
  select), the [pre-flight check](engine.md#the-pre-flight-check) shown as Ready / Blocks / Advice,
  and the choice between reviewing the drafts first or publishing without review. Drafting is a job
  of the queue.
- **Write** (`/write`): an article in the owner's words, in Spanish or English; the channels it
  also goes to (those with a working account, plus the drafts-only ones); review first or publish
  directly, with the toolbar's Prepare the pieces (or Publish the article). See
  [articles](engine.md#articles-written-in-the-app). The text has the **writing
  assistant** ([decisions/writing-assistant.md](decisions/writing-assistant.md)), here and in each
  draft's editor: quick actions on the selected text (improve, shorten, translate, titles, adapt to a
  network, check against the code), a side chat for open requests, and every proposal a word-by-word
  diff to accept or reject. Its chats are saved as they stream (sessions and messages in the
  registry), listed from a History button with the next page loaded as the list scrolls, and taken up
  again with what was done to each proposal. On a phone (760 px and under) the chat is a floating
  bubble that opens a full-screen sheet; messages carry avatars (the signed-in user's GitHub picture,
  the Shipcast mark for the assistant).
- **Channels** (`/channels`): see [accounts.md](accounts.md#the-channels-page). Four tabs by kind of
  network (Social networks, Blog & newsletter, Measurement, AI providers; `?tab=`), each account a
  card in the launch card's skin (the same neutral raised surface, on role tokens). A newly connected
  account lands on the list, in its tab, scrolled to and focused. The **Anthropic API** and an
  **OpenAI-compatible server** are connected here too, under AI providers. The toolbar's **Connect a
  network** is a menu of every network that takes an account; networks that still work from `.env`
  add **Import from .env** beside it, with a slim one-line strip saying why.
- **Comments** (`/comments`): the comments on the owner's posts and the replies drafted for them
  ([decisions/comment-assistant.md](decisions/comment-assistant.md)). The list can run to thousands,
  so it is one page at a time (25) and every filter is in the address and applied by the database
  (the words in the toolbar, the rest behind its Filters, a popover or a sheet on a phone; **Check
  comments now** is the toolbar's action):
  state (waiting for a reply, replied, ignored), channel, launch, post (offered once a launch is
  chosen) and words to find in the comment or its author (`?state=&channel=&launch=&post=&q=&page=`;
  a default is left out and a hand-edited link never breaks the page). The filters offer only what has
  comments, with counts. The query is `Registry.commentsPage` (one join of comment and post, a count
  of the same filter for the total, the indexes on status, channel and date; no query per row) and
  `commentFacets` (three grouped queries); "waiting" covers new, drafted, being sent and failed
  comments. **The words** are `ILIKE '%words%'` on the text, the author's handle and the author's
  name, which no btree index can serve; since 2026-10-27 migration `0010_comments_search` creates
  `pg_trgm` (if absent) and a GIN trigram index on each of the three, and Postgres ORs their bitmaps.
  Measured on a copy of production with 50,000 synthetic comments: a word found in one comment went
  from 130 ms (a sequential scan) to 2 ms, an author's handle from 138 ms to 6 ms, a word in an
  eighth of the comments from 121 ms to 54 ms (the count; the page likewise). Words of one or two
  letters have no trigram and still scan, which on this table is the 130 ms of before. **Approve and
  send** asks first in the app's alert dialog (the network, and that the reply cannot be edited
  afterwards). Each channel's reply mode is below the list.
- **Stats** (`/stats`): how the launches did, under the toolbar (the period, the rest behind Filters,
  and Export CSV, its glyph alone on a phone; the range is the caption under it) in four tabs:
  Overview (the totals, which pick the chart's metric, and the time chart), Ranking (the posts
  ranked; `?tab=posts` still opens it), Accounts (one table of the accounts' growth with Sync now)
  and Search (the articles in Google and Bing). Its header is the same band as every section's, with
  no override in `stats.css`. See [stats.md](stats.md#the-page).
- **Settings** (`/settings`): one area with a submenu, below. Its sections are General
  (`/settings`), AI (`/settings/ai`), Automation (`/settings/automation`) and API
  (`/settings/api`); the old `/ai`, `/automation` and `/tokens` redirect to them.

Every action's outcome is a toast in Cartel (Done, Failed with its diamond, Waiting for you on
yellow), and every error is explained for a person, with the original text folded under Details
(`src/components/errors.ts`). Scrolling is smoothed by Lenis, off for anyone who asks the system for
reduced motion.

**AI cost is never shown**, in any page or in the CLI ([decisions/ai-providers.md](decisions/ai-providers.md)).

## The interface

Built on 2026-10-25, the first part of milestone 3 of the [goal after the MVP](plans/goal-after-mvp.md),
on the [approved design direction](decisions/app-design-direction.md).

- **The shell** (`src/routes/_app.tsx`). On wide screens the top bar holds the lockup, the five
  working sections (Launches, Write, Channels, Comments, Stats), Search as an icon-only button
  (accessible name "Search"; its shortcut is in the tooltip), the **attention bell** (below) and the
  signed-in user as a menu: **Settings is a submenu** (General, AI, Automation, API; Right arrow
  opens it, Left closes it), then Take the tour and Sign out as top-level items. The configuration is
  not in the bar. The submenu is `kind: 'submenu'` in the typed `Menu` wrapper, on Base UI's
  `SubmenuRoot` and `SubmenuTrigger`. The submenu's item for the page on screen is
  `aria-current="page"` with a ringed yellow dot and bold, and on any `/settings` path the Settings
  trigger is `aria-current="true"` with the same dot (`current` on a `Menu` entry). Which page is
  current is the pure, tested `currentSettingsPage` (`src/server/settings-pages.ts`): `/settings` is
  General only when exact, each sub-page owns its path and what is under it, never a sibling sharing
  a prefix (`/settings/aix` is none).
  Below 860 px the sections leave the top for a **bottom bar** in reach of the thumb: Launches,
  Write, Channels, Stats and **More**, which opens a drawer with Comments, Launch a repo, Settings
  as a group of its four entries (General, AI, Automation, API), the search, the tour and the
  signed-in account with Sign out; on a Settings page the group's title wears the dot and says it is
  the current section, and its entry for the page is filled. The bell stays in the phone's top bar.
  The current section is `aria-current="page"` in both (a launch's page and Launch a repo count as
  Launches); there is a skip link to the content, `<main>` is a landmark, every target is at least
  44 px, focus is the yellow ring, and Escape closes any popup with focus back where it was.
- **The attention bell** (`components/AttentionBell.tsx`) replaced the big yellow bands on top of the
  pages: a notifications inbox. A 44 px icon button with the bell glyph centred and, when something
  needs the owner, the count as an 18 px yellow pill on its top-right corner (tabular numbers, "9+"
  above nine, a 2 px ring in the page's colour, out of the flow so it never moves the bar), named
  for assistive technology by the count ("3 things need you", "Nothing needs you"). It opens a
  `ResponsiveMenu` (a Popover on a desktop, the Drawer on a phone) with a link per line: launches
  waiting for approval (Review the drafts), launches with posts that failed (Retry), comments waiting
  for a reply (Answer), accounts that need reconnecting (Reconnect) and, informational and not
  counted, posts scheduled to go out within a day. Empty, it says "Nothing needs you."
  Every line has a **Dismiss** button beside it (Delete or Backspace on the focused line does the
  same) and the panel a **Clear all**, informational lines included. A dismissal leaves the list at
  once (optimistic, the count recomputed), then the list is read again, without closing the panel;
  focus moves to the next line, and a polite live region says "Dismissed" or "All cleared". Clear
  all sends the keys the owner saw, so a line that arrived in between is not cleared unread.
  Dismissals live in the registry (table `attention_dismissals`, migration
  `0009_attention_dismissals`: a `key` and `dismissed_at`), so they hold across devices and reloads.
  **The rule**: a line's key names its condition with its state — `launch:<id>:waiting:<updated at>`,
  `launch:<id>:failed:<digest of the launch's last change and each channel's message>`,
  `comments:waiting:<newest waiting comment id>`, `account:<id>:reconnect:<digest of the problem>`,
  `launch:<id>:scheduled:<first time>:<posts>`. A dismissed line stays hidden while that condition
  lasts; when it changes (a new comment, another failure, a retry that fails again, a launch drafted
  again) the key changes and the line is new. Each read also forgets the dismissals of lines no
  longer there, so a condition that ends and comes back is shown again, and the table stays as small
  as the bell. Server functions: `getAttention` reads launches, the failure cursors by prefix for
  all launches at once, the accounts, the comment facets, the newest waiting comment and the
  scheduled posts in one round, with no query per launch, then the dismissals; `dismissAttention`
  and `clearAttention` take `{ keys }`, checked (1 to 100 keys, each of the shape above). The pure
  `attentionItems` and `buildAttention` (`src/server/attention.ts`, tested) turn the reads into the
  list. It is read again on every navigation, when the bell opens and every three minutes.
- **Section headers are Cartel bands** (`PageHead`): the neutral band, the huge uppercase title, a line
  under it and the section's illustration, at **one height on every page** (200 px on a wide screen:
  the title on one line, the lead clamped to two), so moving between sections never shifts the work
  area. A Settings section's head (`SectionHead`) is 140 px, likewise fixed. **The banner folds**: a
  small button in its corner ("Collapse the banner", `aria-expanded`) folds it to 104 px (80 px for a
  section head) with a "+" to expand it again. Folding takes away only the lead and the illustration;
  **the title keeps its size**, so the band reads the same, just shorter (the first version shrank the
  title to a 56 px strip, which looked wrong). The lead and the illustration leave the layout as well
  as the view (their heights go to zero) and the band's grid row is pinned to the band's height, so
  the title stays centred in the folded band: an illustration that kept its height once made the row
  taller than the band and pushed the title down, cut at the bottom edge. Motion animates the height
  and the fades in 250 ms, instant under reduced motion. The choice is one for every page
  (`useBannerState` in `components/BannerState.tsx`), kept in the `sc_banner` cookie (`compact` or
  `full`, a year, `Path=/`, `SameSite=Lax`, not HttpOnly since the page writes it); the shell's loader
  reads it on the server (`getBanner`), so the page is drawn at the right size from the start. The
  helpers are `src/server/banner.ts`, tested. Section heads fold with the banner and have no button of
  their own. Phones (under 760 px) always get the folded design, the title a little smaller (44 px, in
  an 84 px band; 36 px and 68 px for a section head), without the illustration, the lead or the button.
- **The toolbar** (`components/PageToolbar.tsx`) sits under every banner and holds what the band
  used to: the page's controls on the left, its actions on the right (`ToolbarAction`: one yellow
  primary, the rest quiet; `ToolbarMore` for the overflow). It is 56 px, on the ground colour with a
  bottom hairline, sticky at the top of the window and lifted by a soft shadow once stuck (an
  IntersectionObserver on a line above it; the shadow's fade is off under reduced motion). On a phone
  it stays one row: the controls scroll sideways and each action keeps its glyph, its words its
  accessible name. A form's submit in the bar names its form (`form=`). Settings' layout renders a
  `PageToolbarHost` under its banner, and each section's toolbar is drawn there through a portal.
  Pages: Launches (Launch a repo), Write (Prepare the pieces or Publish the article), Channels
  (Import from .env, Connect a network), a channel's page (Back to channels), Comments (the search,
  Filters, Check comments now), Stats (period, Filters, Export CSV), a launch's page and its draft
  editor, and every Settings section: General (Save settings), AI (Save AI settings, for the
  providers and tone form), Automation (Run a round now, Save automation) and API (Create a token).
  Only Launch a repo, which has nothing for it, has no bar. A Settings section without its bar made
  the content sit 60 px higher than in the others, which showed as a jump when moving between
  sections, so each one has it. Below
  it the work area is calm. What waits for the owner is in the bell; the one-line `.strip` is what a
  page may show for its own pending matter (a launch's Approve, Channels' networks still on `.env`).
- **The command palette**: ⌘K or Ctrl+K anywhere, Search in the top bar, or More on a phone. It
  filters the sections (AI, Automation, API and Settings among them) and the main actions (launch a
  repo, write, connect an account, run an automation round, create a token, sign out); Enter runs
  the highlighted one. On a phone the dialog is centred with margins that respect the safe areas.
- **The first-run onboarding and the tour** ([decisions/onboarding.md](decisions/onboarding.md)): a
  centred wizard on the first sign-in, then an optional tour (NextStep) of Launches, a launch's page,
  Write and its assistant, Channels and Automation, offered when the onboarding ends and from the
  user menu or the palette (Take the tour). Moving between steps goes through one controller,
  `components/tour/TourRuntime.tsx`: it navigates without resetting the scroll, waits for the target
  and for its box to stop moving, scrolls it into the part of the window no bar covers (with Lenis,
  so nothing fights the page's scroller) and only then moves NextStep on; the card follows the
  spotlight's glide, the buttons wait while a move is under way, and a target fixed to the screen
  (the phone's bubble) keeps its spotlight through a scroll. The pointer is a notch on the card's
  edge drawn by Shipcast (`notchFor` in `components/tour/steps.ts`).
- **The components** are Base UI wearing Cartel only, typed wrappers in `src/components/ui/`, styled in
  `src/styles/components.css`: Dialog, an AlertDialog behind `ConfirmButton` (it replaced every
  `window.confirm`: disconnecting an account, rotating the webhook secret, revoking a token,
  clearing a setting, sending a comment's reply; nothing in the app calls the browser's `confirm` or
  `alert`), Combobox, Select (a release, a connection's brand, the AI page's providers and
  preview launch), Menu (an account's secondary actions, and the user menu's Settings submenu), Tabs, Tooltip, Popover, Drawer, the toasts
  and the palette, the date pickers (`DatePicker`, `DateRangePicker`, on react-day-picker: the
  Popover on a desktop, the Drawer on a phone; they replaced every native date input) and the
  **time field** (`TimeField`, beside the day picker where a piece is scheduled). The time field
  replaced the native `<input type="time">`: an hour and a minute segment in 24 hours inside one
  control in the input's skin; type the digits (a shown `01` then a 7 is 17; a last digit past 2 moves
  on to the minutes), Up and Down step a segment and wrap, Left, Right and `:` move between them,
  Backspace clears, and `inputMode="numeric"` gives a phone its number pad. Its value is still the
  `HH:MM` text of the `datetime-local` string the server helpers read; the pure parts (`parseTime`,
  `formatTime`, `stepTime`, `typeTime` in `ui/dates.ts`) are tested.
  **ResponsiveMenu** is one menu in two shapes: the Popover on a desktop (in a
  portal, flipped and shifted by Base UI to stay on screen, so opening it never scrolls the page) and
  the Drawer as a bottom sheet on a phone (640 px wide or a coarse pointer), with the same content and
  open state and nothing that needs hover; the launch cards' channel menus and the attention bell use it. **Collapsible**
  and **Accordion** replaced every native `<details>` that was outside the stats, channels, comments,
  assistant and tour components: the panel's height animates through `--collapsible-panel-height`,
  and it is instant under `prefers-reduced-motion`. **ScrollArea** is Cartel's scrollbar for the
  regions inside a page (the locked rules and previews on AI, the work list, a launch's jobs); the
  page's own scrollbar is styled in CSS with `scrollbar-color` and `scrollbar-width`, plus
  `::-webkit-scrollbar` for Safari, from the role tokens, and `scrollbar-gutter: stable` keeps its
  room whether the page scrolls or not, so a page that gets taller than the window does not narrow
  the content when the owner moves to it. See
  [decisions/component-layer.md](decisions/component-layer.md). They are reviewed running at the
  hidden route `/design/components`.
- **Illustrations wired in**: the 404 page ("Return to sender") and the error boundary ("Damaged on
  the way", with Try again), both inside the shell when a section fails and on their own otherwise;
  the empty states for no launches, no drafts on a launch's page and no connected accounts; the
  sign-in page; the Stats page's loading and empty states; a launch's picture when it has no avatar.
- **Reflow to WCAG 2.2 at 320 CSS px.** The page no longer hides horizontal overflow
  (`overflow-x: clip` is gone); what overflowed was fixed instead: the card and two-column grids use
  `minmax(min(100%, N), 1fr)`, forms and fields are `minmax(0, 1fr)` grids, flex and grid children get
  `min-width: 0`, segmented controls stack under 560 px, record tables become blocks under 640 px,
  long URLs, refs, paths, handles and secrets break with `overflow-wrap: anywhere` (`.break`,
  `.copyable`, table cells), and the strips that hold one row of marks (a launch's channel chips, its
  tabs, the toolbar's controls) scroll sideways on a phone instead of widening the page.
- **The reflow check** (`apps/web/scripts/reflow-check.ts`): a Lighthouse gate cannot run in CI
  without a database and a session, so this script runs against a live instance instead. It signs in
  with a console link (or a session saved with `--state`), opens every page at the widths given (320
  by default; 320, 390 and 1280 for a full pass), opens the command palette, an alert dialog and the
  phone's drawer, and fails on horizontal overflow (`scrollWidth > innerWidth`, naming the widest
  elements) or on any axe-core violation of serious or critical impact (WCAG 2.0–2.2 A/AA and best
  practices). `--shots <dir>` saves screenshots. It is not part of `pnpm test`.

## Automation

Added on 2026-10-25 ([plans/mvp-close.md](plans/mvp-close.md)); on the job queue since phase 6
([decisions/job-queue.md](decisions/job-queue.md)); since 2026-10-26 it is a section of Settings
(`/settings/automation`). The app is a worker of the queue from its start,
so nothing depends on a terminal running `watch`; `server.ts` warms the app's context through
`/api/health` as soon as it listens, and the first round runs 15 seconds later. Each round sends the
next one an interval later; a round is a singleton across processes, so the app and `shipcast watch`
never run the same round twice.

- **The mode**, chosen in the page and kept in the registry: **Rounds** (polling the account's events
  every interval, at least 60 seconds), **GitHub webhooks** (GitHub's deliveries claim releases and
  merges as they happen; the rounds still publish what is ready), or **Off** (only the owner's
  actions: no rounds, and the scheduled metric reads and token refreshes skip). Rounds is the
  default. The metrics are read every six hours and the Instagram tokens checked daily, as jobs of
  their own on cron schedules. Saving the settings (the toolbar's Save automation) moves the next
  round to 15 seconds later.
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
- **Work in progress**: the queue's jobs of the last day (drafting, publishing, GitHub's deliveries),
  each with its last log line and its state, followed while one runs; it moved here from the
  launches list, where it took the room of the launches. Ten to a page, with a filter by state (All,
  Running, Failed, Done, each with its count) and a box of bounded height that scrolls with
  ScrollArea. Since 2026-10-27 the database cuts the pages (`jobsPage` in `src/server/jobs.server.ts`
  over `Registry.jobs` with an offset and `Registry.jobCounts`, one grouped count per state): the
  rule of what the list leaves out (rounds that ended well, jobs that found automation off) is the
  registry's `listed` filter, in SQL. Before, the day's newest 200 rows were read and cut in memory,
  so a busy day lost its earliest jobs. A launch's own jobs (on its Details tab) are a bounded list
  too. See [api.md](api.md#paging-the-work-list) for why the page uses an offset and the API a cursor.
- **What happened**: the last round and the last delivery, with their lines; and **Run a round now**
  (in the toolbar), which moves the round already queued to now (refused while one is running, in
  any process).
- GitHub can only deliver once the app is reachable from it, which is the VPS's job; signed test
  deliveries (a ping, an ignored event, a bad signature, a merge with no launch, an installation
  change) answered as expected on 2026-10-25.

## AI

Added on 2026-10-25 ([decisions/ai-providers.md](decisions/ai-providers.md)); since 2026-10-26 it is
a section of Settings (`/settings/ai`, `src/routes/_app/settings/ai.tsx`,
`src/server/ai.functions.ts`), and **all** AI configuration lives there and nowhere else:

- **claudio**: its URL and token and the AI budget per generation. claudio stays a provider of its
  own: its REST API is what lets Claude Code explore the repo for the content pack, and its
  OpenAI-compatible surface streams the writing assistant. These three settings are not on General.
- **Providers**: per task (the launch content pack, an article's distribution, the writing
  assistant) a provider (claudio, the Anthropic API, an OpenAI-compatible server; the ones without a
  connected account say so) and a model, empty for the provider's default. And the **tone**, which
  replaces `brand.yml`'s in every prompt when set. This form saves from the toolbar (Save AI
  settings), like the other sections; claudio's group keeps its own Save under it.
- **Prompts**: each channel's brief, each kind of pack's brief and the article's translation, as
  templates with `{{variables}}`, folded in an Accordion. A save is a new version; the versions are
  listed with their dates and any of them, or the default, can be restored.
- **Locked**: the rules that keep generated text true to the code (and to the article), and the
  content pack's JSON Schema, shown read-only.
- **Preview**: the final system prompt and prompt a past launch would get with the saved prompts and
  tone, rendered without calling an AI.

## Settings

Added on 2026-10-25 ([decisions/github-app.md](decisions/github-app.md)). Since 2026-10-26 Settings is
**one area with a submenu**: a column beside the page on wide screens, tabs that scroll sideways on
phones. **General** (`/settings`), **AI** (above), **Automation** (above) and **API**
(`/settings/api`, the REST API's tokens: created with a name and scopes (`read`, `write`) from the
toolbar's Create a token, shown once, listed with when each was last used, and revoked; see
[api.md](api.md)). The layout is
`src/routes/_app/settings.tsx`; each section is a route under `src/routes/_app/settings/`. Every
section has the same frame, so moving between them changes nothing but the content: the toolbar under
the banner, one column of at most 880 px (`.settings-body`, in which a form fills the column instead
of stopping at 720 px), and the page's scrollbar gutter kept. A
setting is configured in exactly one place: the shared `SettingsForm` shows General's group and AI's
group, never the same field twice. General's page is `src/routes/_app/settings/index.tsx` with
`src/server/settings.functions.ts`:

- **Each setting** that is not the bootstrap and not the AI's: the launches repo and the Instagram,
  Threads and LinkedIn app ids and secrets. Each says where its value comes from (saved
  here, the keychain, or `.env` until it is saved here); secrets are shown as set or not, never sent
  to the page. A save (the toolbar's Save settings) checks every value first (the launches repo is
  `owner/name`), applies to what runs next without a restart, and a **Clear** beside a field (which
  asks first) removes a saved one. What is still missing is listed at the top; a page that needs a
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
- **A launch at a glance** (`src/server/launch-summary.ts`, tested, and its `.server.ts`): a launch's
  totals from the latest reading of each counter through the stats section's metric families
  ([stats.md](stats.md)), GitHub's stars apart from reactions; each channel's totals with only what
  its network counts (a metric it does not count shows a dash, not 0); and views per day for every
  launch and channel of the list in one query, the engine's daily series grouped by `launchChannel`.
- **The page frame's styles** are `src/styles/layout.css` (the toolbar, the Settings section heads,
  the Launches rows and the project pictures); the bands stay in `app.css`.
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

[[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[decisions/job-queue.md]] · [[plans/goal-finish.md]] · [[plans/mvp-close.md]] · [[plans/design-system.md]] · [[decisions/web-app-stack.md]] · [[api.md]] · [[decisions/api-tokens.md]] · [[decisions/ai-providers.md]] · [[decisions/app-design-direction.md]] · [[decisions/github-app.md]] · [[mcp.md]] · [[decisions/mcp.md]] · [[status.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]] · [[stats.md]] · [[decisions/comment-assistant.md]] · [[decisions/writing-assistant.md]] · [[decisions/onboarding.md]]