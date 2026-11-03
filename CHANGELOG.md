# Changelog

What changed in each release of Shipcast. Each launch is drafted by Shipcast from the code at its tag;
this file is the plain list.

## v0.3.0

Shipcast for other developers without a server, a redesigned app you can install, and launches that
live in Shipcast instead of pull requests.

**Highlights**
- **The GitHub Action, end to end.** `yeyo11/shipcast-action@v1` (now v1.3.1) drafts a real release
  with a real Anthropic or OpenAI key: v1.0.0 had only run with the fake provider and failed before
  writing anything. A release is drafted as a release (a minor or major pack after earlier launches
  or releases), the release notes reach the AI, and publishing rounds no longer depend on GitHub's
  cron being on time (three backstop cron lines, `workflow_dispatch`, and the `curl` for an external
  cron printed by `init`).
- **`npx @yeyo11/shipcast init` from npm.** The CLI is published as `@yeyo11/shipcast` on each
  release, with npm trusted publishing and provenance. `init` asks for the brand's tone (or takes
  `--tone`) and prints the step for releases created by another workflow.
- **The redesigned app.** Every screen rebuilt on one kit: Launches with what needs you first, the
  launch page, approval, Write, Launch a repo and from sources, Channels, Stats, the comment inbox,
  Settings, onboarding, sign-in and the search palette; one 1200 px column on a desktop.
- **A rich editor.** Write and each draft's editor have Markdown and Visual modes, with a toolbar
  from the channel's formatting profile and images in articles (uploaded, committed with the article,
  alt text required). The writing assistant and a draft's save follow the same formatting; Telegram
  posts go out as formatted HTML.
- **An installable app (PWA).** Shipcast installs on a phone or a desktop and opens standalone,
  shows its own offline page when the connection is gone, and offers each new deploy as a "New
  version available" toast instead of swapping it in. It never caches a page with your data.
- **Push notifications.** Shipcast tells your devices when replies to comments or a launch's drafts
  wait for your approval, something fails, or a launch is out. Turn it on per device in Settings ›
  Notifications, with a switch per event; on iPhone and iPad it works once Shipcast is on the Home
  Screen. A notification never shows a comment or a draft's text. A server needs VAPID keys
  (`SHIPCAST_VAPID_PUBLIC_KEY`, `SHIPCAST_VAPID_PRIVATE_KEY`; see docs/push.md).
- **A starter blog.** No blog yet? [shipcast-blog](https://github.com/yeyo11/shipcast-blog) is a
  template that already reads Shipcast's articles and deploys on GitHub Pages.
- **Your blog's languages.** The article, the newsletter issue and the posts are written in the
  languages `brand.yml` lists (`languages.blog`, any ISO 639-1 code); language switches and inputs in
  the app and the MCP follow them. dev.to and Hashnode republish the English version when there is
  one, otherwise the first language.
- **Launches held and approved in the app.** A launch's drafts and media live in Shipcast (media on
  R2), and you review, edit and approve them in the app instead of in a pull request of the launches
  repo, with who edited and approved recorded. Launches can also be made from sources (further repos
  and pages), created by trigger rules, and deleted.
- **UTM-attributed links.** Every link to your site that Shipcast publishes carries `utm_source`,
  `utm_medium` and `utm_campaign`, YouTube's Short and video told apart in `utm_content`; dev.to and
  Hashnode keep the clean canonical URL. An Umami connector (behind the `umami` flag) reads the
  blog's visits by source and campaign.
- **Stats reworked.** Dated values, a second tier of metric families, each counter's lifetime beside
  the period's increase, and reads of YouTube analytics, dev.to analytics, blog sources, search CTR,
  Instagram stories and post insights, Threads link clicks and GitHub coverage.

**Changed**
- YouTube is a full channel: a vertical Short and a horizontal video drawn from the launch's demo,
  screenshots and cover, with burned-in subtitles, captions and chapters.
- Every AI task runs on one AI task runner, with claudio, the Anthropic API or an OpenAI-compatible
  server as providers, prompt caching and batch repo tools. A spend limit per AI task, set beside its
  model in Settings › AI, replaces the global AI budget.
- A server runs as three processes (`web`, `worker`, `heavy`) with BullMQ on Redis, PgBouncer and an
  encrypted secrets table (`shipcast secrets migrate`); `pnpm app` stays a single process on pg-boss.
- GitHub through events: a public webhook host, conditional requests through an ETag cache, and an
  hourly poll as the safety net for missed deliveries.
- Pages follow one server-sent event stream per tab instead of polling, show "No connection" while
  offline, and a launch's page reads everything at once.
- A route and an MCP tool for everything the app's pages do, kept in parity by tests.
- Each channel is one definition (limits, modes, pieces, formatting, metric cadence), and the app,
  the engine and `init` derive their tables from it.
- Settings › AI in four tabs; Sync all on Channels syncs every account of the tab on screen.
- claudio is optional in `docker-compose.yml`, behind its own profile.
- LinkedIn posts are written in the brand's language for it and share that language's article.

**Fixed**
- Real Anthropic and OpenAI keys: repo tools' schemas are objects at the top level, strict decoding
  gets only the JSON Schema the API takes, every task's conversation is append-only so thinking
  blocks stay valid, the tool call is never forced, and an answer that is not JSON is reported as
  such and repaired once.
- A release is compared with what was announced before, so a project the blog already covered is not
  introduced again.
- Stats: "all" starts on the first reading and a longer period never counts less; a launch's views
  per day count only the sources its total counts; accounts without an audience are left out.
- Publishing claims each channel before it sends and retries once; a deleted launch publishes nothing;
  a launch's site commit is never made twice.
- Network reads: Bluesky falls back to api.bsky.app, dev.to analytics are paced, one YouTube video's
  analytics failing no longer loses the rest, every GitHub release's downloads are read, Instagram's
  too-few-viewers is told from a missing permission, and a deleted Discord webhook from a deleted
  message.
- Telegram owner notices never go to the public channel.
- The migration lock never goes through PgBouncer and is always released; the migrator retries a
  locked table.
- The GitHub user token's refresh is locked across processes.
- 44 px touch targets in the phone layout, keyboard-scrollable chat and diff, and the bars kept in
  place on short pages and with long names.
- node-forge 1.4.2 and follow-redirects 1.16.2 for new high advisories.

**Upgrade notes**
- **Migrations 0012 to 0023** run when Shipcast starts. 0022 drops the `draft_snapshots` table, the
  one migration that is not additive. Take a `pg_dump` of the registry first.
- **Settle v0.2.0's drafts pull requests first.** The pull-request path and the import of launches
  drafted in pull requests are gone; a launch still open in a drafts pull request that the app does
  not hold cannot be read.
- **A media store is needed for launches with files.** Launches keep their media on Cloudflare R2
  (`SHIPCAST_MEDIA_ENDPOINT`, `SHIPCAST_MEDIA_BUCKET`,
  `SHIPCAST_MEDIA_ACCESS_KEY_ID`, `SHIPCAST_MEDIA_SECRET_ACCESS_KEY`). A server
  (`SHIPCAST_APP_TLS=proxy`) does not start without it; on a desktop install a launch with files fails
  its draft naming what is missing (docs/media-store.md).
- **claudio is behind a compose profile.** `docker compose up -d` no longer starts it: use
  `docker compose --profile claudio up -d`, or put `COMPOSE_PROFILES=claudio` in `.env`.
- **`languages.blog` defaults to `[en]`.** A `brand.yml` without it was written in English and
  Spanish; now it gets English only. Add `languages: { blog: [en, es] }` to keep both.
- **The Action:** use `yeyo11/shipcast-action@v1`, which is v1.3.1 or later. v1.0.0 fails with any
  real AI key and posts links with `?ref=` instead of UTM tags.
- **Removed settings:** `SHIPCAST_MAX_BUDGET_USD` and the `ai-budget-usd` setting are ignored (use the
  per-task limits), and the performance refactor's and launch model's flags are retired; an
  environment that still lists them starts as before. A server split into `web`, `worker` and `heavy`
  needs Redis (`SHIPCAST_REDIS_QUEUE_URL`).

## v0.2.0 (2026-10-27)

Everything after the MVP: an app to run Shipcast from, more networks, what happens after publishing,
and Shipcast for other developers.

**The app**
- A web app on Base UI in the Cartel design: launches, writing, channels, comments and stats in five
  sections, settings in one place, a command palette, a postal illustration set, an onboarding in
  steps and a tour; it reflows to 320 px and passes axe and a Lighthouse gate (100 for accessibility
  and best practices on every page).
- Sign-in, engine and webhooks through one GitHub App; configuration in two parts (a bootstrap in
  `.env`, everything else in the database and the keychain).
- Durable work on pg-boss: drafting, publishing, scheduled posts, metric reads, account syncs and
  comment polling survive a restart, with retries and their state in the app.
- The Launches list pages, searches, filters and sorts in the database; the work list and the
  comments page the same way, comments' search on trigram indexes.

**AI**
- Providers through the Vercel AI SDK (claudio, Anthropic, OpenAI), a provider and model per task,
  editable and versioned prompts with a preview.
- A writing assistant beside every draft: improve, shorten, translate, titles, adapt to a channel,
  check against the code, each proposal as a diff to accept.
- Articles written for search: an opening that answers what the project is, question headings, alt
  text, the project's screenshot; an article written again keeps its first date and gains
  `updatedDate`.

**Networks and publishing**
- New networks: Reddit, GitHub Discussions, Threads and LinkedIn; channels Shipcast cannot publish
  itself are gone.
- Edit and delete published posts where each network allows it, one channel or several at once.
- Scheduling at a chosen or recommended time, learned from your own posts.
- A comment assistant that reads comments, drafts replies in the brand's tone and sends them on
  approval.
- Articles written in the app can carry their own screenshots, which reach dev.to and Hashnode on the
  blog's address.

**Numbers**
- A Stats section with charts, filters, a ranking normalised per network and account growth from daily
  snapshots; Google Search Console, Bing Webmaster Tools and Cloudflare Web Analytics; a repo's traffic
  through the GitHub App.
- An account's profile reviewed by the AI, with proposals applied on Mastodon, Bluesky and a Telegram
  channel, and copied elsewhere.

**For other developers and AI clients**
- `npx @yeyo11/shipcast init` sets up Shipcast on your own repos, as a GitHub Action
  (`yeyo11/shipcast-action@v1`) with Anthropic or OpenAI and no database.
- A REST API with scoped tokens, an MCP server (`shipcast mcp` and `/mcp`) and WebMCP as an
  experiment.

## v0.1.0 (2026-10-25)

The MVP: a release read with Claude, a content pack for every channel, drafts in a pull request and
publishing on approval, launched with Shipcast itself.
