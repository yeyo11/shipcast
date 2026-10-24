---
created_at: 2026-10-24T16:21:40.656881834Z
updated_at: 2026-10-24T16:37:57.017845674Z
tags:
    - decision
    - mvp
    - scope
    - connectors
---
# Scope of the MVP

Decided on 2026-10-24 by the owner, at the start of the work, and widened the same day. The MVP is
the test that closes phase 1 of the [roadmap](../plans/shipcast.md#roadmap): **claudio announced on
the blog, dev.to, Bluesky, Mastodon and Instagram with no intervention beyond the merge, and its
Reddit drafts ready to paste.**

## Channels

| Channel | In the MVP | Why |
| --- | --- | --- |
| Blog (`yeyo11/launches`) | Yes | The canonical URL of every launch |
| dev.to | Yes | Republished with `canonical_url` to the blog; free API |
| Bluesky | Yes | Free API (AT Protocol, app password) |
| Mastodon | Yes | Free API (access token on mastodon.social) |
| Instagram | Yes | Free API (Instagram API with Instagram Login); needs a professional account and the owner's Meta app |
| Reddit | Yes, as `manual` | Shipcast writes one draft per subreddit and the owner posts it. The plan already keeps Reddit as drafts (self-promotion is judged by each subreddit's rules and a post that reads automated gets removed), and since November 2025 Reddit's API needs a manual approval under its Responsible Builder Policy, which a personal script is unlikely to get. Account: [u/josegarridodev](https://www.reddit.com/user/josegarridodev/). The subreddits are still to be chosen |
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

## Other decisions

- **Personal brand only.** The company brand (josegarridodigio) is left out until after the MVP. The
  schemas keep brands as a concept ([brands.md](../brands.md)), so adding the second one is
  configuration, not a redesign. One GitHub token (`GITHUB_TOKEN_PERSONAL`).
- **No paid APIs.** Nothing in the MVP calls an API that charges per use. Every MVP channel above has
  a free API, and the AI runs through claudio, which costs nothing per launch.
- **The repository stays at `yeyo11/shipcast`.** The `shipcast` GitHub organisation has been taken
  since 2020 (and `launchloop`, the fallback name, is taken too). The name is free on npm, and the
  owner reserves it there.
- **No domain for Shipcast.** `shipcast.dev`, `.io` and `.app` are taken; none is bought for now. The
  owner did buy a personal domain on 2026-10-24, `josegarrido.dev`; how the blog uses it is being
  decided.
- **The blog lives in `yeyo11/launches`**, on GitHub Pages at `https://yeyo11.github.io/launches/`
  ([launches-repo.md](../launches-repo.md)), dark theme by default.
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
