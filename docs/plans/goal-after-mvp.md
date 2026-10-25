---
created_at: 2026-10-25T14:21:47.566094505Z
updated_at: 2026-10-25T14:21:47.566094505Z
tags:
    - plan
    - goal
    - roadmap
    - phase-6
    - phase-7
    - phase-8
    - phase-9
    - phase-10
    - phase-11
---
# Goal: everything after the MVP

Written on 2026-10-25, when the owner asked for one long autonomous run (a goal) that builds every
phase still pending in [plans/after-mvp.md](after-mvp.md): the rest of phase 6 (the foundations),
phase 7 (the interface), phase 8 (AI), phase 9 (after publishing), phase 10 (engagement) and phase 11
(reach), plus the blog's project pages from [plans/search-presence.md](search-presence.md). It follows
the shape of the [previous goal](goal-finish.md). The server deployment stays out: everything runs on
the owner's machine and is built so a server changes nothing but the address.

Read first: `CLAUDE.md`, [status.md](../status.md), [plans/after-mvp.md](after-mvp.md) (its decisions
are settled and not reopened here), [engine.md](../engine.md),
[decisions/postgres.md](../decisions/postgres.md), [decisions/post-model.md](../decisions/post-model.md),
[publishing.md](../publishing.md), [accounts.md](../accounts.md), [web-app.md](../web-app.md),
[search-indexing.md](../search-indexing.md), [plans/design-system.md](design-system.md) and
[launches-repo.md](../launches-repo.md).

## Where it starts

Done before the goal, on 2026-10-25: the registry on PostgreSQL through Drizzle, one row per
published piece with metrics per post, the typed `settings` table, Search Console and Bing Webmaster
indexing and numbers, the blog on Cloudflare Workers with its SEO and AI-readiness work, and the
owner's Wikidata items.

## Decisions for the run

Proposed by the agent when the owner asked for this document; the owner confirms or changes them
before launching the goal, and this table is updated to match.

| Topic | Decision |
| --- | --- |
| Merging | The agent squash-merges its own pull requests once CI and the Sluice gates pass, then continues; never a direct push to `main`. A pull request that converts the owner's existing data waits for the owner's merge |
| Design | A design round with the owner **before** the interface work (milestone 2): questions, real reference sites, the direction approved. The goal then builds on what was approved and shows a live preview at each interface milestone; a screen whose direction was not approved is proposed on its branch and waits, while other work goes on |
| Scope | Phases 6 to 11 complete, including MCP and WebMCP, GitHub Discussions, Threads, LinkedIn (personal profile), the GitHub Action mode and the one-command install; and the blog's project pages and article index. YouTube stays out until there is video |
| Real accounts while testing | Allowed: publishing test posts and editing or deleting **only what the run itself published**, recorded in the final report; the comment assistant runs in **approval** mode during tests, so nothing is sent to a follower without the owner's click; profile edits are prepared and applied only when the owner approves them in the app |

## Rules for the run

- Every rule in `CLAUDE.md` holds: a branch and a pull request per change, Conventional Commits,
  verified through Sluice's `verify` tool, docs only through `kb_add_document`, technical text in
  English, no `any`, `noUncheckedIndexedAccess`.
- **Never `git add -A`**: stage files by name.
- **Nothing private in the public repos** (`shipcast`, `launches`, `docs/`): no account ids, no
  hostnames of the owner's machines, no tokens, nothing about the owner's own install.
- **The owner's live data comes through every change intact.** Before a migration reaches the live
  install: a dated `pg_dump` in `data/backups/` (gitignored), the conversion tested first on a copy of
  the live database restored into a throwaway Postgres, and after applying it the counts compared
  table by table. The steps and numbers of the owner's install are reported in the chat, never
  written in the repo.
- **The live app is restarted by the run** after each merge that changes it, and checked: health, the
  next automatic round, no errors in its log.
- **Every milestone ends** with its doc under `docs/` (a plan or a decision, through
  `kb_add_document`), `status.md` updated, and the roadmap in [plans/after-mvp.md](after-mvp.md)
  ticked.
- **The principles stay**: generated text tells what is implemented from what is planned; nothing is
  published without its channel's mode; a launch happens once; AI cost is never shown in the UI.

### Subagents and models

Independent work runs in parallel subagents, each in its own worktree and branch, never two on the
same files. The session on `main` reviews each pull request before merging it: CI, the diff, and an
end-to-end run against a copy of the live data whenever the registry or publishing changes.

| Model | For |
| --- | --- |
| **Opus** | Architecture and boundaries, security (the GitHub App, tokens, OAuth, the API's auth), migrations and data conversions, the job queue, reviewing a subagent's pull request |
| **Sonnet** | A connector against its documented API, a screen from an approved design, tests, an MCP tool |
| **Haiku** | Mechanical work: stale lines in docs, renames, fixtures, lookups in the code |

## What the owner provides

The run stops and asks only for these; it collects them early where it can, and keeps building what
does not depend on them.

1. **The design round** (milestone 2) and the approvals of each interface preview.
2. **The GitHub App**: the run prepares its manifest (permissions: contents, pull requests, releases
   and discussions on the repos the owner picks, metadata; webhook events; callback on the app's
   address); the owner creates it from the manifest link and installs it, and its id, client id,
   client secret, private key and webhook secret go into `.env`.
3. **Threads**: the Threads use case added to the existing Meta app with its permissions
   (`threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`,
   `threads_manage_insights`, `threads_delete`) and the callback the run gives.
4. **LinkedIn**: a LinkedIn app with "Share on LinkedIn" and "Sign In with LinkedIn using OpenID
   Connect", and the callback the run gives.
5. Any credential a new connector needs, entered in the app's Channels or Blog section, never in the
   chat.

## Milestone 1: the rest of the foundations (phase 6)

- **Durable work on pg-boss**: drafting, publishing, scheduled posts, metric reads, account syncs and
  comment polling become jobs in Postgres that survive a restart, with retries and their state in the
  app; the in-memory jobs and the automation `setTimeout` loop go.
- **Configuration in two parts**: the bootstrap from `.env` (data folder, database URL, host and port,
  public URL, the GitHub App, the allowed login), everything else from the database and the keychain,
  read when needed, so the app starts and signs in with nothing else set. The CLI shares it.
- **The GitHub App** replaces the OAuth App and `GITHUB_TOKEN_PERSONAL`: one sign-in, a fine-grained
  user token refreshed on its own, the installation's repos, app-level webhooks (polling stays while
  the app is unreachable).
- **Account snapshots**: every account's followers, following and posts recorded daily; each account
  shows when it was last synced, warns when stale, and has **Sync now**; Instagram webhooks and
  Mastodon's streaming API update it at once.
- **Avatars** of every account (saved on each check) and of the signed-in user.
- **Token auth and stable REST routes** for the MCP server and other clients, beside the server
  functions.

## Milestone 2: the design round (with the owner)

Before any screen changes: the questions and reference sites the owner's design process asks for,
covering the component layer on Base UI in Cartel, the navigation on small screens (a drawer, a
bottom bar or another pattern), lists, the stats and chart style (and the chart library, styled with
Cartel's tokens), the launch page, the onboarding and tour, the AI panel, and the illustration set
(postal metaphor, drawn SVG on Cartel's tokens). The approved direction is written as a decision doc
before milestone 3 starts.

## Milestone 3: the interface (phase 7)

- **Base UI across the app**, Cartel only: toasts on Base UI's Toast with today's API and look,
  dialogs and alert dialogs instead of `window.confirm`, comboboxes with search instead of native
  selects, menus, tabs, tooltips, popovers, a command palette, a date and time picker, a drawer.
- **Lists** with pagination, search, filters and sorting on TanStack Table, over paged and indexed
  queries.
- **Reflow and mobile** to WCAG 2.2 at 320 px: no hidden overflow, fluid layouts, clamped long text
  with the full text on hand, 44 px targets, the navigation as approved, a Lighthouse gate on the app.
- **Illustrations** for 404, 500, offline, empty lists, no accounts, waiting, shipped, failed,
  sign-in, automation and each onboarding step.
- **Channels, Blog and Drafts apart**, with several measurement sources per site in Blog.
- **Avatars** on accounts and on the signed-in user.
- **The onboarding**, in steps, on the first sign-in; each step skippable and resumable.
- **The tour** with NextStep, offered after the onboarding, restartable from help.

## Milestone 4: AI (phase 8)

- **Providers through the Vercel AI SDK**: claudio through its OpenAI-compatible API, the Anthropic
  API and others; streaming.
- **AI settings**: provider and model per task, the brand's tone, editable and versioned prompts with
  a preview against a past launch; the rules that keep generated text true to the code and the content
  pack's schema stay locked.
- **The writing assistant**: a panel beside Write and each draft (improve, shorten, translate, titles,
  adapt to a channel, check against the repo's code), every proposal as a diff to accept.
- **Generated content for search**: alt text for covers and images, a first paragraph that answers
  what the project is, question-style headings where they fit, screenshots inside the article,
  `updatedDate` when an article is regenerated.

## Milestone 5: after publishing (phase 9)

- **Edit and delete in the connectors** that allow it (Mastodon, dev.to, Hashnode, Telegram, Discord
  edit and delete; Bluesky deletes; the blog by a commit), and a capability per network the UI reads.
- **A launch's page**: numbers over time per post and per account; editing a published post, one or
  several channels at once through the shared fields; deleting one post or all; what a network cannot
  do shown and explained.
- **Stats**: a section with charts, filtered by channel, account, launch and dates, sorted by
  popularity normalised per network.
- **Account analysis**: evolution from the snapshots, an AI review with proposals, profile edits where
  the API allows (Mastodon, Bluesky, a Telegram channel), proposals to copy elsewhere.

## Milestone 6: engagement (phase 10)

- **Scheduling**: a time per post, chosen or recommended (defaults per network in the owner's time
  zone, Instagram's audience hours where given, learned from the owner's own posts); a slot missed
  while the machine was off goes out on the next round.
- **The comment assistant**: reads comments on Shipcast's posts (Mastodon, Bluesky, Instagram, Threads;
  dev.to read-only), drafts replies in the brand's tone grounded in the repo; each channel set to
  replying on its own or waiting for approval.

## Milestone 7: reach (phase 11)

- **MCP**: `shipcast mcp` over stdio, then over HTTP with a token (launch, status, drafts, approve,
  write); **WebMCP** in the app as an experiment with the same tools.
- **New networks**: GitHub Discussions, Threads, LinkedIn (personal profile: publish and delete).
- **The GitHub Action mode** and **a one-command install**, with the documentation another developer
  needs.

## Milestone 8: the blog's structure

- **Project pages** (`/<lang>/projects/<project>/`) gathering each project's launches, and an **article
  index**, with their breadcrumbs, in the design approved in milestone 2, in `yeyo11/launches`.
- Each project's README linking the blog and its launch article.

## Milestone 9: the final test

**Shipcast v0.2.0 launched with Shipcast**, using what the goal built: the release detected through the
GitHub App, drafts improved with the writing assistant, the posts scheduled at the recommended times,
one comment answered through the assistant with the owner's approval, the numbers in the stats
section, and the launch's page showing every piece with its edit and delete actions. Everything
published during the run listed in the final report.

## Outcome

Written when the goal ends.

## Related

[[plans/after-mvp.md]] · [[plans/goal-finish.md]] · [[plans/search-presence.md]] · [[status.md]] · [[decisions/postgres.md]] · [[decisions/post-model.md]] · [[engine.md]] · [[publishing.md]] · [[web-app.md]] · [[accounts.md]] · [[search-indexing.md]] · [[plans/design-system.md]] · [[launches-repo.md]]
