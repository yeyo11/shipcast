---
created_at: 2026-10-25T06:55:59.910066905Z
updated_at: 2026-10-25T09:55:48.545205562Z
tags:
    - plan
    - architecture
    - roadmap
    - decision
---
# Shipcast: automating the launch of GitHub projects

The founding design, written on 2026-10-24 by Jose Antonio. It combines the best of two AI-drafted
proposals (Claude's and ChatGPT's): a central repo with a reusable GitHub Actions workflow that, when
a release is published, analyses the project with Claude Code, generates the content and publishes
it per channel after the owner's approval. To start with, the engine runs on the laptop and uses
[claudio](https://github.com/yeyo11/claudio) as its AI provider; the GitHub Action mode arrives in
phase 6.

Both proposals agreed on the basics: Postiz for social networks, human review for Reddit and Hacker
News, and the release as the trigger. (Postiz was later discarded for Shipcast's own connectors, X
and LinkedIn dropped, and Reddit left out for now: see
[decisions/mvp-scope.md](../decisions/mvp-scope.md); the roadmap below is ticked with what was built.)

## Ideas taken from the ChatGPT proposal

**A `.github/launch.yml` per repo.** Replaces the idea of an `announce` topic. Besides turning the
launch on or off, it sets per channel whether publishing is `auto`, `approval` or `manual`. It keeps
experiments and forks from being announced and gives fine control without touching the central
system.

```yaml
# .github/launch.yml
enabled: true
brand: personal
language: en

content:
  article: true
  socialPosts: true
  technicalTutorial: true

publishing:
  blog: auto
  x: approval
  linkedin: approval
  reddit: manual
  hackerNews: manual
```

**Separate brands.** A personal account (yeyo11) and a company one (josegarridodigio): different
tone, different networks, and never a company project on the personal accounts.

**Read the code, not just the README.** The AI must tell what is implemented from what is planned
and from what only appears in the docs. An article that promises missing features hurts the
author's reputation with a technical audience.

**A structured content pack.** Instead of asking for an article, the AI returns a JSON with every
piece: article, thread, LinkedIn post, Reddit and Show HN drafts. Easy to validate, store and reuse.

**Assets and tracking.** Cover, screenshots and demo GIF, plus the published URLs and the metrics,
to learn which channel works.

**Claude Code in CI.** The local Claude Code does not run in GitHub Actions; the official Claude Code
GitHub Action runs it inside the workflow with an API key and lets it explore the whole repo.

## Gaps in the ChatGPT proposal

| Gap | Why it matters | Fix |
| --- | --- | --- |
| Cost of X | The API is pay-per-use since February 2026; a post with a link costs about $0.20 against about $0.015 without ([source](https://opentweet.io/how-to/x-api-pay-per-use-explained)) | Put the repo link in a reply of the thread |
| Webhook on a personal account | There is no global "new repo" webhook for personal accounts, only for organisations | A webhook per repo, or polling the GitHub API |
| Temporal in Postiz | Since v2.12, without Temporal the API accepts posts but never publishes them ([source](https://railway.com/deploy/postiz-social-api.md)) | Deploy the full official docker-compose |
| `launch.yml` repeated | Copying the logic into every repo is unmaintainable | A reusable workflow (`workflow_call`) in a central repo; each project carries only `launch.yml` and a five-line call |
| Duplicates | Re-running a workflow or publishing a minor version would repeat the campaign | A launch registry (a JSON in the central repo) |

## Architecture

Seven steps and three publishing paths: trigger → pre-flight checks → repo analysis by claudio →
content pack → drafts for approval → publishing per channel mode → registry and metrics. Every
launch goes through the owner's approval before publishing; Reddit and Hacker News always stay as
drafts to paste by hand. n8n was rejected: the flow is versioned code and lives on GitHub.

## Name

**Shipcast**, from *ship* and *broadcast*: short, English to reach developers everywhere, and it says
what it does. Rejected: Releasecast (an npm tool for macOS apps already uses it) and RepoHerald (too
close to releaseherald). Before fixing it, check it is free as a GitHub organisation, an npm package
and a domain. Fallback: **LaunchLoop**.

## Decisions

| Topic | Decision |
| --- | --- |
| Goal | Open source product for other developers; its own launch is the proof it works |
| License | MIT |
| Deadlines | None: the roadmap is ordered by phases |
| Trigger | Configurable (see below) |
| What is announced | Configurable: new projects and versions |
| GitHub accounts | Both are user accounts, no organisation webhooks |
| Brands | Personal and company, every network, no restrictions, each with its own tone |
| Languages | Spanish and English |
| Writing style | To be defined later, from examples |
| Assets | From the start; a demo GIF is mandatory in every launch |
| Blog | Does not exist yet: to be created |
| dev.to and Hashnode | Accounts to be created |
| Reddit and communities | To be defined later |
| Other channels | Yes: newsletter, Telegram, Discord and Product Hunt |
| Approval | Approve, reject and edit; no Slack, no email; auto-publishing configurable per channel |
| Infrastructure | Local on the laptop, Tailscale Serve if outside access is needed; no hosting at first |
| AI | claudio (Claude Code as a service with a REST API) instead of the Anthropic API |
| Metrics | All of them, in a dashboard |

## Triggers

Release and manual are on by default; the rest are enabled in `launch.yml`. In local mode the engine
polls the GitHub API every few minutes, so it needs no webhooks and does not expose the laptop.

| Trigger | Fires when | Best for |
| --- | --- | --- |
| Release published (default) | A release is published on GitHub | New projects and major versions |
| Manual (default) | `shipcast launch <repo>` or a dashboard button | Relaunching, or announcing without a release |
| Repo made public | A repo goes from private to public | A project's first launch |
| `launch.yml` activation | `enabled: true` lands in an existing repo | Announcing older projects |

## Content packs

Chosen in `launch.yml` (`pack: launch | major | minor`); when absent, inferred from the semantic
version. Every pack follows these rules:

- The article lives on the blog (canonical URL) and is republished on dev.to and Hashnode pointing
  to it, so the copies do not compete in search engines.
- Each channel gets its own text, never the same copy pasted.
- The demo GIF goes in the first post on each network.
- On X, the link goes in a reply of the thread, not in the main post.
- The blog is in both languages; English by default on dev.to, Hacker News, Reddit and Mastodon;
  language configurable per brand on X and LinkedIn.

| Pack | Used for | Pieces |
| --- | --- | --- |
| Launch | A new project | Full article (problem, solution, how it works, quick start, limitations, next steps); X thread of 5 to 7 posts; LinkedIn post; Bluesky and Mastodon posts; Show HN draft; Reddit drafts; Product Hunt kit; newsletter issue; OG image and GIF |
| Major | v2.0 and the like | What's-new article, a short post per network and improved release notes |
| Minor | Patches and improvements | Improved release notes and, optionally, a short post |

## Approval

The recommended path is the **pull request**: drafts are saved as Markdown files in a launches repo,
edited with commits or GitHub's web editor (also on a phone) and approved by merging. That same repo
is the blog's source, so the merge publishes the article and triggers distribution to the other
channels. Telegram only notifies that drafts are waiting.

| Option | Approve | Edit | Requires |
| --- | --- | --- | --- |
| Pull request (recommended) | Merge | Commits or GitHub's web editor | Nothing else |
| Telegram bot | Buttons on the message | Replying to the message | A bot (free) |
| Shipcast dashboard | Button | Built-in editor | Phase 4 |
| Discord bot | Reactions | Replying to the message | A bot |

Each channel has its mode in `launch.yml`: `auto` (no approval), `approval` or `manual` (a draft to
paste).

## Roadmap

Each phase ends with a real test. The first use case is claudio, which already has demo GIFs; the
last is Shipcast's own launch, made with Shipcast. At least one similar tool exists,
[Release Announcer](https://mcpmarket.com/zh/server/release-announcer), which only generates
drafts; Shipcast differs in that it publishes, generates assets and measures results.

Ticked on 2026-10-25, after the first real launch and again after the
[goal](goal-finish.md) that built the app and phase 5; the MVP pulled several items forward from later
phases ([decisions/mvp-scope.md](../decisions/mvp-scope.md)) and dropped others for good.

### Phase 0: foundations

- [x] Check and reserve the name: npm `shipcast` reserved; the GitHub organisation and the domains
      were taken, so the repo stays at `yeyo11/shipcast`
- [x] Create the `shipcast` repo: MIT, TypeScript and a pnpm monorepo, the same stack as claudio
- [x] Define the schema of `launch.yml` and of the JSON content pack
- [x] Create the launches repo with the blog in Astro, published on GitHub Pages (`josegarrido.dev`)
- [x] Create the dev.to account; Hashnode left the MVP

### Phase 1: local MVP, end to end

- [x] Local engine that detects releases and manual launches (the personal account; the company one
      waits until after the MVP)
- [x] claudio integration to analyse the repo and generate the pack
- [x] Pre-flight check: license, README, demo GIF, release and `launch.yml`, before every launch (2026-10-25)
- [x] Drafts in a pull request; the merge publishes
- [x] Publishing to the blog and to dev.to with a canonical URL
- [x] Launch registry to avoid duplicates

Test, passed on 2026-10-25: claudio v0.9.0 announced with no intervention beyond the merge — on the
blog and dev.to, and also on Bluesky, Mastodon, Instagram and the newsletter.

### Phase 2: networks and brands

- [x] Hashnode: connector and publishing built on 2026-10-25; its live test needs the paid Pro plan its API requires since 2026-05-13
- [x] Bluesky and Mastodon (free APIs)
- [x] ~~X~~ and ~~LinkedIn~~: dropped for good by the owner on 2026-10-24
- [x] Instagram, added to the MVP: a carousel, its story and a comment (2026-10-25)
- [x] Brand separation: accounts per brand, a launch only uses its own brand's, `.env` speaks for
      one brand only (2026-10-25). One brand, the owner's own (josegarridodev); the company brand
      of the founding plan was dropped on 2026-10-25
- [x] Spanish and English versions, each with its own URL
- [x] Telegram notifications: drafts waiting, published, failed (2026-10-25)
- [x] `auto`, `approval` and `manual` modes per channel

### Phase 3: assets

- [x] Mandatory demo GIF, as a video in the Instagram carousel; recorded from the deployed project with Playwright when the repo has none (2026-10-25)
- [x] Generated OG image, Instagram slides and story; covers per project, drawn or generated (2026-10-25)
- [x] Automatic screenshots of deployed demos, desktop and mobile, with Playwright (2026-10-25)

### Phase 4: dashboard and metrics

- [x] The web app in Cartel (TanStack Start), on the owner's domain over the tailnet, GitHub sign-in (2026-10-25)
- [x] GitHub stars, forks and traffic (read every 6 hours while `watch` runs)
- [x] dev.to views and reactions, Bluesky, Mastodon, Instagram, newsletter, blog analytics and
      Search Console
- [x] Clicks per channel: `?ref=<channel>` on every link; visits attributed by referrer, since
      Cloudflare Web Analytics drops the query string
- [x] Approval and editing from the app, retrying a channel, launching a repo, writing an article
- [x] Channels: every integration, its accounts and OAuth, connecting a new one, publishing from the app
- [x] Automation: the app runs its own rounds, or takes GitHub webhooks signed with their secret (2026-10-25)

### Phase 5: communities and extra channels

- [x] Show HN drafts (2026-10-25); Reddit drafts built, then left out by the owner on 2026-10-25 (`off` by default)
- [x] Product Hunt kit: tagline, description, first comment, gallery (2026-10-25)
- [x] Newsletter, through Brevo; Telegram channel and Discord (2026-10-25, live tests wait on accounts)
- [x] Personal style guide for the AI: the brand's `tone` in `brand.yml`, refined after the first launch

### Phase 6: a product for other developers

After the MVP, as steps of a setup wizard ([plans/mvp-close.md](mvp-close.md)): the AI providers
through the Vercel AI SDK, with claudio reached through its OpenAI-compatible API by the SDK's
adapter.

- [ ] Swappable AI providers: claudio, the Anthropic API and the Claude Code Action
- [ ] GitHub Action mode, with no local machine, alongside the local mode
- [ ] Documentation, blog template and one-command install
- [x] Shipcast launched with Shipcast: v0.1.0, from the app, on 2026-10-25

Final test: Shipcast's launch, generated and published by Shipcast — done ahead of the rest of
phase 6, as the goal's final test.

## Open questions

- **Launch volume:** measured with the registry, now that it is in use.
- **Writing style:** set in `brand.yml`'s `tone`; to refine with each launch.
- ~~**Subreddits and communities:**~~ Reddit is left out for now (2026-10-25).
- ~~**Postiz or our own connectors:**~~ decided on 2026-10-24: our own connectors, Postiz only as
  reference reading.
- ~~**Cost of X:**~~ moot: the owner does not publish on X.

## Sources

- [X API pay-per-use explained (OpenTweet)](https://opentweet.io/how-to/x-api-pay-per-use-explained)
- [Deploy Postiz (Railway)](https://railway.com/deploy/postiz-social-api.md)
- [claudio (GitHub)](https://github.com/yeyo11/claudio)
- [Release Announcer (MCP Market)](https://mcpmarket.com/zh/server/release-announcer)
- [Releasecast (GitHub)](https://www.github.com/superhighfives/releasecast)
- [Hashnode's GraphQL API needs Pro](https://hashnode.com/announcements/graphql-api)

## Related

[[status.md]] · [[plans/mvp-close.md]] · [[plans/goal-finish.md]] · [[web-app.md]] · [[knowledge-base.md]] · [[launch-yml]] · [[content-pack]] · [[launch-registry]] · [[decisions/mvp-scope.md]] · [[publishing.md]] · [[engine.md]]
