---
created_at: 2026-10-24T17:39:38.711934531Z
updated_at: 2026-10-24T17:54:51.089506487Z
tags:
    - decision
    - mvp
    - scope
    - connectors
    - metrics
---
# Scope of the MVP

Decided on 2026-10-24 by the owner, at the start of the work, and widened the same day. The MVP is
the test that closes phase 1 of the [roadmap](../plans/shipcast.md#roadmap): **claudio announced on
the blog, dev.to, Bluesky, Mastodon and Instagram with no intervention beyond the merge, its Reddit
drafts ready to paste, and Shipcast showing what each channel brought.**

## Channels

| Channel | In the MVP | Why |
| --- | --- | --- |
| Blog (`yeyo11/launches`) | Yes | The canonical URL of every launch |
| dev.to | Yes | Republished with `canonical_url` to the blog; free API |
| Bluesky | Yes | Free API (AT Protocol, app password) |
| Mastodon | Yes | Free API (access token on mastodon.social) |
| Instagram | Yes | Free API (Instagram API with Instagram Login); needs a professional account and the owner's Meta app |
| Reddit | Yes, as `manual` | Shipcast writes one draft per subreddit and the owner posts it. The plan already keeps Reddit as drafts (self-promotion is judged by each subreddit's rules and a post that reads automated gets removed), and since November 2025 Reddit's API needs a manual approval under its Responsible Builder Policy, which a personal script is unlikely to get. Account: [u/josegarridodev](https://www.reddit.com/user/josegarridodev/). Subreddits are set per project in its `launch.yml`; for claudio, chosen by the owner on 2026-10-24: r/ClaudeAI, r/selfhosted, r/SideProject and r/opensource (read each one's self-promotion rules before posting) |
| LinkedIn | **No, not at all** | The owner will not publish on LinkedIn, in the MVP or after (2026-10-24) |
| X | **No, not at all** | The owner will not publish on X, in the MVP or after (2026-10-24); its API is paid besides |

Widened on 2026-10-24: the first version covered only the blog and dev.to; the owner asked for every
network they already have an account on, then excluded LinkedIn and X — first from the MVP, then for
good — and added Reddit.

**Instagram brings assets forward.** An Instagram post is an image, a carousel or a video, never text
alone; JPEG is the only image format, GIFs are not accepted, links in captions are not clickable, and
the media must sit at a public URL when it is published. So the MVP needs, from phase 3, at least a
generated image per launch (the OG image, as JPEG) and, where the project has one, its demo GIF turned
into an MP4 for a Reel. The launches repo's GitHub Pages site serves them publicly after the merge.

## Metrics are in the MVP

Decided on 2026-10-24 by the owner: **all the metrics move into the MVP**, not phase 4. Data not
collected is lost for good, and the first launch is the first data point that matters. Shipcast gets
one metrics connector per source, stores the readings in SQLite and ties each to the launch and the
channel that produced it, so it can say which channel worked.

| Source | What it measures | Access |
| --- | --- | --- |
| Blog | Visits per article and where they came from | Cloudflare Web Analytics, live on the blog since 2026-10-24 (cookieless; the privacy policy says so) |
| Google Search Console | Searches, impressions and clicks | Property `josegarrido.dev` verified by DNS on 2026-10-24, sitemap submitted; Shipcast reads it with read-only credentials, to be created |
| GitHub | Stars, forks and repo traffic | The traffic API keeps 14 days, so Shipcast copies it daily |
| dev.to | Views and reactions per article | Its API |
| Bluesky, Mastodon | Likes, reposts, replies per post | Their APIs |
| Instagram | Reach and interactions | `instagram_business_manage_insights`, granted 2026-10-24 |
| Reddit | Score and comments | No API: recorded by hand, if at all |

Every link Shipcast publishes carries a per-channel marker (`?ref=<channel>`) so the blog's analytics
attribute visits even where a network strips the referrer. A dashboard to look at them is part of the
MVP too; its form is decided when it is built. An uptime check of the blog runs in `shipcast watch`.
A Search Console MCP connector for Claude Code was considered and set aside for now: there is no
official one, only small third-party projects.

## Other decisions

- **Personal brand only.** The company brand (josegarridodigio) is left out until after the MVP. The
  schemas keep brands as a concept ([brands.md](../brands.md)), so adding the second one is
  configuration, not a redesign. One GitHub token (`GITHUB_TOKEN_PERSONAL`).
- **No paid APIs.** Nothing in the MVP calls an API that charges per use. Every MVP channel and
  metrics source above has a free API, and the AI runs through claudio, which costs nothing per
  launch.
- **The repository stays at `yeyo11/shipcast`.** The `shipcast` GitHub organisation has been taken
  since 2020 (and `launchloop`, the fallback name, is taken too). The name is free on npm, and the
  owner reserves it there.
- **No domain for Shipcast.** `shipcast.dev`, `.io` and `.app` are taken; none is bought for now.
- **The blog lives in `yeyo11/launches`**, on GitHub Pages at **`https://josegarrido.dev`**, the
  owner's personal domain bought on 2026-10-24: the blog is the personal brand's home, at the root of
  the domain, chosen by the owner over a `blog.` or `launches.` subdomain
  ([launches-repo.md](../launches-repo.md)). Dark theme by default.
- **claudio runs from this repo's `docker-compose.yml`**, configured by the owner
  ([claudio.md](../claudio.md)).

## Connectors: our own, not Postiz

Decided on 2026-10-24 by the owner: **Postiz is discarded.** Shipcast talks to every network the owner
has an account on through its own connectors — one module per network over `fetch`, in
`packages/connectors` ([plans/stack.md](../plans/stack.md)). For the MVP that is dev.to, Bluesky,
Mastodon and Instagram, plus Reddit as drafts. LinkedIn and X get no connector for the owner;
Shipcast keeps both as channels (off by default) for other brands that want them. Reddit's connector
writes drafts until the account obtains API approval, if it ever does.

Why: Postiz needs Postgres, Redis, Temporal and Elasticsearch (6–7 GB on disk, about 2 GB of RAM), too
much for a laptop tool and a hard requirement to put on the developers Shipcast is for in phase 6;
and the networks of the MVP all have free, documented APIs that a small module covers.

Postiz stays useful as **reference code**: when a connector needs to know how an API behaves in
practice (media upload, token refresh, limits), read Postiz's provider for that network
([gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app), under
`libraries/nestjs-libraries/src/integrations/social/`: `dev.to.provider.ts`, `bluesky.provider.ts`,
`mastodon.provider.ts`, `instagram.standalone.provider.ts`, `reddit.provider.ts`). Postiz is
AGPL-3.0 and Shipcast is MIT: read it to learn how an API behaves, then write the connector from the
API's own documentation; never copy its code.

## Related

[[plans/shipcast.md]] · [[claudio.md]] · [[status.md]] · [[decisions/main-until-mvp.md]] · [[brands.md]] · [[launches-repo.md]] · [[plans/stack.md]]
