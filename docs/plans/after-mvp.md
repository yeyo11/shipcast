---
created_at: 2026-10-25T10:31:29.439824861Z
updated_at: 2026-10-25T10:32:09.021073093Z
tags:
    - plan
    - roadmap
    - architecture
    - decision
    - web-app
    - ai
    - connectors
    - seo
---
# After the MVP: the roadmap from phase 6

Decided on 2026-10-25 by the owner, from twenty proposals reviewed against the code, the blog, the
networks' APIs and the candidate libraries. It replaces the old phase 6 of the
[founding plan](shipcast.md#roadmap) and orders everything that follows the
[MVP](mvp-close.md). The server deployment is postponed; everything here runs locally first and is
built so a VPS changes nothing but the address.

## Decisions

| Topic | Decision |
| --- | --- |
| Database | **PostgreSQL with Drizzle ORM** (typed schema, versioned migrations), replacing `node:sqlite`. SQLite allows one writer, and the app, the CLI, the MCP server, the scheduler and the comment assistant all write. Locally it runs in the `docker-compose.yml` that already runs claudio. A script moves the current registry. Mongo was rejected: launches, posts, accounts and metrics are relational and the stats are joins and aggregates |
| Durable work | **pg-boss** on the same Postgres: scheduled jobs, retries, nothing lost on a restart, no Redis. Replaces the in-memory jobs and the `setTimeout` loop |
| GitHub | **A GitHub App** instead of the OAuth App: one sign-in gives a fine-grained user token (contents, pull requests, releases, discussions) on the repos the owner picks, expiring every 8 hours and refreshed on its own, which replaces `GITHUB_TOKEN_PERSONAL`. Installed on the owner's account it delivers webhooks for all their repos, new ones included, once the app is reachable; until then rounds poll |
| What stays in `.env` | Only what the app needs before anyone signs in: the data location and database URL, host and port, the public URL, the GitHub App (id, client id and secret, private key, webhook secret) and the allowed login, which keeps a stranger from signing in first at a public address. Everything else is set in the onboarding, kept in the keychain or the database. No console links |
| Blog hosting | **Cloudflare Workers static assets** instead of GitHub Pages: security headers through `_headers`, edge caching (a year for hashed assets), a preview URL per branch, so each drafts pull request shows its article rendered before approval, and content negotiation (Markdown for `Accept: text/markdown`). The DNS is already in Cloudflare. SEO does not suffer; Cloudflare's default blocking of AI bots must be turned off |
| AI crawlers | **All allowed**, search and training alike, in `robots.txt` and in Cloudflare |
| UI primitives | **Base UI** (unstyled, state as `data-*` attributes), **TanStack Table** and **react-day-picker**, all wearing Cartel's tokens and classes and nothing else: no library theme ships, every new component is added to the design specimen first. Not shadcn (Tailwind), not cmdk (unmaintained) |
| Product tour | **NextStep**, through its navigation adapter on TanStack Router, with a Cartel card; always optional, offered after the onboarding and restartable from help |
| Illustrations | Hand-drawn SVG scenes as React components on Cartel's role tokens, in a postal metaphor (from the blog's "Return to sender"); no generated images; proposed on a branch with a live preview before merging |
| AI providers | **The Vercel AI SDK**, brought forward from phase 6: streaming and chat need it; claudio is reached through its OpenAI-compatible API |
| AI cost | **Never shown** in the UI |
| Mobile | WCAG 2.2 reflow (1.4.10): everything works at 320 CSS px without horizontal scrolling, not as patches |
| Networks | Next: edit, delete and comments on the networks already connected; GitHub Discussions; Threads; **LinkedIn again**, on the personal profile (publish and delete need no review; comments and metrics need the Community Management API, which LinkedIn grants to verified companies, so they wait); YouTube once there is video. Dropped: X, TikTok, Pinterest, Dribbble, Whop, Twitch, Skool, Kick, Farcaster, VK, MeWe, Nostr, Lemmy, Listmonk, WordPress, Medium, Substack, Slack, Buy Me a Coffee |
| Comment replies | A per-channel setting: replies go out on their own or wait for approval |

## Phase 6: foundations

What the rest stands on.

- **Postgres and Drizzle**: the schema rewritten in Drizzle, migrations under version control, the
  current registry moved by a script, the registry's API kept for its callers.
- **A post model**: one row per piece (`post`, `story`, `comment`, `issue:<lang>`, `article:<lang>`),
  with its account, external id, URL, status (`scheduled`, `live`, `edited`, `deleted`, `failed`) and
  a hash of its content; unique per launch, channel, account and kind, so a launch still happens once.
  Metrics point at a post, or at a site for the blog's sources. The comma-joined newsletter ids and the
  Instagram extras kept in cursors become rows.
- **Typed settings**: a `settings` table for the onboarding, automation, AI settings and prompts;
  `cursors` goes back to holding positions only.
- **Durable work** on pg-boss: drafting, publishing, scheduled posts, metric reads, account syncs and
  comment polling are jobs that survive a restart, with retries and their state visible in the app.
- **Configuration in two parts**: the bootstrap from `.env`, and the settings from the database and
  the keychain, read when needed, so the app starts and signs in with nothing else configured. The CLI
  shares it.
- **The GitHub App**: sign-in, the user token and its refresh, the installation's repos, app-level
  webhooks.
- **Account snapshots**: every account's followers, following and posts recorded every day from now
  on, since no API gives the history; each account shows when it was last synced, warns when it is
  stale, and has **Sync now**; networks that push changes (Instagram webhooks, Mastodon's streaming
  API) update it at once.
- **Avatars**: each account's avatar URL saved on every check, and the signed-in user's from GitHub.
- **Token auth for the API**: scoped tokens in the keychain and stable REST routes beside the server
  functions, for the MCP server and other clients.

## Phase 7: the interface

Designed with the owner from real reference sites first, Cartel strictly.

- **Base UI across the app**: toasts on Base UI's Toast keeping today's API and look (pause on hover,
  a keyboard landmark, swipe), dialogs and alert dialogs in place of `window.confirm`, comboboxes with
  search in place of native selects, menus, tabs, tooltips, popovers, a command palette, a date and
  time picker for scheduling, a drawer for the navigation on small screens.
- **Lists**: pagination, search, filters and sorting on every list (launches, posts, accounts), on
  TanStack Table, served by paged and indexed queries (no N+1, no fixed caps).
- **Reflow and mobile**: no `overflow-x: clip` hiding overflow; fluid layouts with container queries
  and `min-width: 0`; long URLs, refs and handles break or are clamped with the full text on hand;
  targets of at least 44 px; the navigation in a drawer; checked at 320 px and by a Lighthouse gate on
  the app (accessibility at least 0.95).
- **Illustrations**: 404, 500, offline, empty lists, no accounts, waiting for you, shipped, failed,
  sign-in, automation, and one per onboarding step.
- **Channels, the blog and drafts apart**: Channels are where Shipcast publishes; **Blog** holds the
  launches repo, `brand.yml` and the blog's measurement, with several sources per site (Cloudflare Web
  Analytics, Search Console, Bing Webmaster Tools, and Plausible, Umami or GA4 when used); Drafts holds
  Hacker News and Product Hunt.
- **Avatars** on every account and on the signed-in user.
- **The onboarding**, in steps, detected on the first sign-in: the brand and the launches repo
  (creating or validating `brand.yml` by a commit), the AI provider, the channels (with the Instagram
  app), the blog's measurement, automation; each step can be skipped and resumed, and the app stays
  usable with what is set.
- **The tour**, offered when the onboarding ends.

## Phase 8: AI

- **Providers through the Vercel AI SDK**: claudio, the Anthropic API and others, chosen in the
  onboarding and in AI settings; streaming everywhere.
- **AI settings**: the provider and model per task, the brand's tone, and the prompts: each channel's
  brief and the article prompt editable, versioned, with a preview against a past launch. The rules
  that keep generated text true to the code, and the content pack's schema, stay fixed.
- **A writing assistant**: a panel beside Write and beside each draft: improve, shorten, translate,
  propose titles, adapt to a channel, and check the text against the repo's code so it promises
  nothing that does not exist. Every proposal arrives as a diff to accept or not.

## Phase 9: after publishing

- **A launch's page**: its numbers over time, per post and per account; editing a published post,
  one channel or several at once through the fields every network shares (text, link, image); deleting
  one post or all of them. What a network cannot do is shown and explained, not hidden:

  | Network | Edit | Delete |
  | --- | --- | --- |
  | Mastodon, dev.to, Hashnode, Telegram, Discord | yes | yes (dev.to unpublishes) |
  | Bluesky | no | yes |
  | Instagram | no | no |
  | Newsletter (sent) | no | no |
  | Blog | yes, by a commit | yes, by a commit |

- **Stats**: a section with charts, filtered by channel, account, launch and dates, sorted by
  popularity, normalised per network since a like and a visit are not the same thing.
- **Account analysis**: per connected account, its evolution from the snapshots, an AI review of the
  profile with proposals, and editing the profile where the API allows it (Mastodon, Bluesky, a
  Telegram channel); elsewhere the proposals are copied by hand.

## Phase 10: engagement

- **Scheduling**: a time per post, chosen or recommended. The recommendation starts from defaults per
  network in the owner's time zone, uses Instagram's audience hours where given, and learns from the
  owner's own posts and their numbers. A slot missed while the machine was off goes out on the next
  round.
- **A comment assistant**: it reads the comments on Shipcast's posts (Mastodon, Bluesky, Instagram,
  Threads; dev.to read-only) and drafts replies in the brand's tone, grounded in the repo; each channel
  says whether replies go out on their own or wait for approval.

## Phase 11: reach

- **AI clients**: an MCP server (`shipcast mcp`, local over stdio, then remote over HTTP with a
  token): launch, status, drafts, approve, write. **WebMCP** in the app as an experiment, exposing the
  same tools to the browser's agent.
- **New networks**: GitHub Discussions, Threads, LinkedIn (personal profile), then YouTube.
- **The GitHub Action mode** and a one-command install, for other developers.

## The blog, in parallel

In `yeyo11/launches`, independent of the phases above:

- **Move to Cloudflare Workers static assets**, with security headers, caching, previews per branch
  linked from each drafts pull request, and AI bots allowed.
- **Structured data**: one JSON-LD graph per page (`Person`, `WebSite`, `BlogPosting` with the project
  as `SoftwareSourceCode`).
- **For AI readers**: `llms.txt`, `llms-full.txt` and each article in Markdown; `robots.txt` naming
  the crawlers, all allowed.
- **Sitemap** with hreflang and real `lastmod`; robots meta with `max-snippet` and
  `max-image-preview`; a default OG image and the article meta; the root page without a canonical.
- **RSS** with the full content, categories and author, linked to each language's home.
- **Speed**: the hero image eager, AVIF and WebP with sizes, inlined CSS, the font preloaded with a
  metrics-matched fallback; a Lighthouse gate in CI.
- **Accessibility**: a skip link, code comments with AA contrast.
- **IndexNow** after each deploy, and the sitemap in Bing Webmaster Tools.
- **In the content Shipcast generates**: alt text for covers and images, a first paragraph that
  answers what the project is, question-style headings where they fit, screenshots inside the article,
  `updatedDate` when an article is regenerated.

## Related

[[plans/shipcast.md]] · [[plans/mvp-close.md]] · [[status.md]] · [[web-app.md]] · [[engine.md]] · [[accounts.md]] · [[publishing.md]] · [[launches-repo.md]] · [[plans/design-system.md]] · [[decisions/mvp-scope.md]] · [[decisions/web-app-stack.md]]
