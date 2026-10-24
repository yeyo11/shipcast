---
created_at: 2026-10-24T12:00:00Z
updated_at: 2026-10-24T12:00:00Z
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
News, and the release as the trigger.

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

### Phase 0: foundations

- [ ] Check and reserve the name (GitHub organisation, npm and domain)
- [x] Create the `shipcast` repo: MIT, TypeScript and a pnpm monorepo, the same stack as claudio
- [ ] Define the schema of `launch.yml` and of the JSON content pack
- [ ] Create the launches repo with the blog in Astro, published on GitHub Pages
- [ ] Create the dev.to and Hashnode accounts

### Phase 1: local MVP, end to end

- [ ] Local engine that detects releases and manual launches on both accounts
- [ ] claudio integration to analyse the repo and generate the pack
- [ ] Pre-flight check: license, README, demo GIF and release
- [ ] Drafts in a pull request; the merge publishes
- [ ] Publishing to the blog and to dev.to with a canonical URL
- [ ] Launch registry to avoid duplicates

Test: claudio announced on the blog and on dev.to with no intervention beyond the merge.

### Phase 2: networks and brands

- [ ] Hashnode
- [ ] Bluesky and Mastodon (free APIs)
- [ ] X, with the pay-per-use API and the link in a reply
- [ ] LinkedIn
- [ ] Brand separation: accounts, tone and language
- [ ] Spanish and English versions
- [ ] Telegram notifications
- [ ] `auto`, `approval` and `manual` modes per channel

### Phase 3: assets

- [ ] Mandatory demo GIF: VHS for terminal tools, Playwright for websites
- [ ] Generated OG image and cover
- [ ] Automatic screenshots of deployed demos

### Phase 4: dashboard and metrics

- [ ] Local web dashboard, reachable through Tailscale Serve
- [ ] GitHub stars, forks and traffic with a daily copy (the traffic API keeps only 14 days)
- [ ] dev.to and Hashnode views and reactions, and blog analytics
- [ ] Clicks per channel with UTM links
- [ ] Approval and editing from the dashboard

### Phase 5: communities and extra channels

- [ ] Reddit and Show HN drafts
- [ ] Product Hunt kit
- [ ] Newsletter, Telegram channel and Discord
- [ ] Personal style guide for the AI

### Phase 6: a product for other developers

- [ ] Swappable AI providers: claudio, the Anthropic API and the Claude Code Action
- [ ] GitHub Action mode, with no local machine, alongside the local mode
- [ ] Documentation, blog template and one-command install
- [ ] Shipcast launched with Shipcast

Final test: Shipcast's launch, generated and published by Shipcast.

## Open questions

- **Launch volume:** measured with the phase 1 registry.
- **Writing style:** defined from examples in phase 5.
- **Subreddits and communities:** to be decided according to the owner's profile.
- **Postiz or our own X and LinkedIn connectors:** Postiz needs Postgres, Redis and Temporal, heavy for
  a laptop; decided in phase 2.
- **Cost of X:** a post costs about $0.015 and one with a link about $0.20; a six-post thread with
  one link comes to about $0.28 per launch.

## Sources

- [X API pay-per-use explained (OpenTweet)](https://opentweet.io/how-to/x-api-pay-per-use-explained)
- [Deploy Postiz (Railway)](https://railway.com/deploy/postiz-social-api.md)
- [claudio (GitHub)](https://github.com/yeyo11/claudio)
- [Release Announcer (MCP Market)](https://mcpmarket.com/zh/server/release-announcer)
- [Releasecast (GitHub)](https://www.github.com/superhighfives/releasecast)

## Related

[[status.md]] · [[knowledge-base.md]] · [[launch-yml]] · [[content-pack]] · [[launch-registry]]
