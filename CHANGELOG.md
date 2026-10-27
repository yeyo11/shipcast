# Changelog

What changed in each release of Shipcast. Each launch is drafted by Shipcast from the code at its tag;
this file is the plain list.

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
