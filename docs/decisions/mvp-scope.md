---
created_at: 2026-10-24T13:30:41.808463609Z
updated_at: 2026-10-24T14:09:23.54138243Z
tags:
    - decision
    - mvp
    - scope
---
# Scope of the MVP

Decided on 2026-10-24 by the owner, at the start of the work. The MVP is the test that closes phase 1
of the [roadmap](../plans/shipcast.md#roadmap): claudio announced on the blog and on dev.to with no
intervention beyond the merge.

## Decisions

- **Personal brand only.** The company brand (josegarridodigio) is left out until after the MVP. The
  schemas keep brands as a concept, so adding the second one is configuration, not a redesign, but no
  code path for it is built or tested now. One GitHub token (`GITHUB_TOKEN_PERSONAL`).
- **No paid APIs.** Nothing in the MVP calls an API that charges per use: the X API (pay-per-use since
  February 2026) is out. What the MVP publishes through goes over free APIs only — GitHub, GitHub
  Pages and dev.to — and the AI runs through claudio on the owner's existing Claude subscription. A
  channel whose API costs money can still exist as a `manual` channel: Shipcast writes the draft and
  the owner pastes it, at no cost. Whether X gets an API connector at all is decided after the MVP,
  with the cost figures of the [plan](../plans/shipcast.md#open-questions).
- **The repository stays at `yeyo11/shipcast`.** The `shipcast` GitHub organisation has been taken
  since 2020 (and `launchloop`, the fallback name, is taken too), so there is no organisation for now.
  The name itself is kept: it is free on npm, and the owner reserves it there.
- **No domain.** `shipcast.dev`, `.io` and `.app` are taken; none is bought for now.
- **The blog lives in `yeyo11/launches`**, published on GitHub Pages at
  `https://yeyo11.github.io/launches/`: the launches repo of the
  [approval flow](../plans/shipcast.md#approval), and the canonical URL that dev.to points to. One
  launches repo per brand when the company brand arrives. A custom domain can be added later without
  changing the repo.
- **claudio runs from this repo's `docker-compose.yml`**, configured by the owner
  ([claudio.md](../claudio.md)).

## Related

[[plans/shipcast.md]] · [[claudio.md]] · [[status.md]] · [[decisions/main-until-mvp.md]] · [[brands]]
