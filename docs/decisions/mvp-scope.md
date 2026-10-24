---
created_at: 2026-10-24T14:26:59.272362102Z
updated_at: 2026-10-24T14:58:54.170576601Z
tags:
    - decision
    - mvp
    - scope
---
# Scope of the MVP

Decided on 2026-10-24 by the owner, at the start of the work, and widened the same day. The MVP is
the test that closes phase 1 of the [roadmap](../plans/shipcast.md#roadmap): **claudio announced on
the blog, dev.to, Bluesky, Mastodon and Instagram with no intervention beyond the merge.**

## Channels

| Channel | In the MVP | Why |
| --- | --- | --- |
| Blog (`yeyo11/launches`) | Yes | The canonical URL of every launch |
| dev.to | Yes | Republished with `canonical_url` to the blog; free API |
| Bluesky | Yes | Free API (AT Protocol, app password) |
| Mastodon | Yes | Free API (access token on mastodon.social) |
| Instagram | Yes | Free API (Instagram API with Instagram Login); needs a professional account and the owner's Meta app |
| LinkedIn | **No** | The owner does not want the MVP to use the LinkedIn account |
| X | **No** | The owner does not want the MVP to use the X account; its API is paid besides |

Widened on 2026-10-24: the first version covered only the blog and dev.to; the owner asked for every
network they already have an account on, then excluded LinkedIn and X.

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
  a free API, and the AI runs through claudio on the owner's existing Claude subscription.
- **The repository stays at `yeyo11/shipcast`.** The `shipcast` GitHub organisation has been taken
  since 2020 (and `launchloop`, the fallback name, is taken too). The name is free on npm, and the
  owner reserves it there.
- **No domain.** `shipcast.dev`, `.io` and `.app` are taken; none is bought for now.
- **The blog lives in `yeyo11/launches`**, on GitHub Pages at `https://yeyo11.github.io/launches/`
  ([launches-repo.md](../launches-repo.md)), dark theme by default.
- **claudio runs from this repo's `docker-compose.yml`**, configured by the owner
  ([claudio.md](../claudio.md)).

## Open: direct connectors or Postiz

Proposed, waiting for the owner: **direct connectors** for the four MVP networks (dev.to, Bluesky,
Mastodon, Instagram), each a small module over `fetch`. All four have free, documented APIs, and
direct calls keep the MVP free of Postiz's stack (Postgres, Redis, Temporal and Elasticsearch, 6–7 GB
on disk). Postiz — which
covers dev.to, Hashnode, LinkedIn, Bluesky, Mastodon, Instagram, Threads, Reddit, Telegram, Discord,
X and Listmonk — stays the candidate for the networks after the MVP, sharing that instance.

## Related

[[plans/shipcast.md]] · [[claudio.md]] · [[status.md]] · [[decisions/main-until-mvp.md]] · [[brands.md]] · [[launches-repo.md]] · [[plans/stack.md]]
