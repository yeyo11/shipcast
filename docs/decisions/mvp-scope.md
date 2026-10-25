---
created_at: 2026-10-25T00:02:02.082293222Z
updated_at: 2026-10-25T00:25:21.75054675Z
tags:
    - decision
    - mvp
    - scope
    - connectors
    - metrics
    - newsletter
---
# Scope of the MVP

Decided on 2026-10-24 by the owner, at the start of the work, and widened the same day. The MVP is
the test that closes phase 1 of the [roadmap](../plans/shipcast.md#roadmap): **claudio announced on
the blog, dev.to, Bluesky, Mastodon, Instagram and the newsletter with no intervention beyond the
merge, and Shipcast showing what each channel brought.** Passed on 2026-10-25.

## Channels

| Channel | In the MVP | Why |
| --- | --- | --- |
| Blog (`yeyo11/launches`) | Yes | The canonical URL of every launch |
| dev.to | Yes | Republished with `canonical_url` to the blog; free API |
| Bluesky | Yes | Free API (AT Protocol, app password) |
| Mastodon | Yes | Free API (access token on mastodon.social) |
| Instagram | Yes | Free API (Instagram API with Instagram Login); needs a professional account and the owner's Meta app. A carousel, its story and a comment since 2026-10-25 |
| Reddit | **No, for now** | Left out by the owner on 2026-10-25, after the first launch: no drafts are generated (`publishing.reddit` is `off` by default). Before that, Shipcast wrote one draft per subreddit for the owner to post by hand; Reddit's API needs a manual approval under its Responsible Builder Policy since November 2025, which a personal script is unlikely to get. The draft code stays, for a project that turns it on (`publishing.reddit: manual` in its `launch.yml`) |
| Newsletter | Yes, through Brevo | Added on 2026-10-24 at the owner's request, before the first real launch: one issue per language, reviewed in the drafts pull request and sent on merge. See [the newsletter](#the-newsletter-brevo) below |
| LinkedIn | **No, not at all** | The owner will not publish on LinkedIn, in the MVP or after (2026-10-24) |
| X | **No, not at all** | The owner will not publish on X, in the MVP or after (2026-10-24); its API is paid besides |

Widened on 2026-10-24: the first version covered only the blog and dev.to; the owner asked for every
network they already have an account on, then excluded LinkedIn and X — first from the MVP, then for
good — added Reddit and later the newsletter, and left Reddit out again on 2026-10-25.

**Instagram brings assets forward.** An Instagram post is an image, a carousel or a video, never text
alone; JPEG is the only image format, GIFs are not accepted, links in captions are not clickable, and
the media must sit at a public URL when it is published. So the MVP generates its pieces per launch
(the carousel's slides, the demo as a video, the story) and the launches repo's GitHub Pages site
serves them publicly after the merge ([publishing.md](../publishing.md#the-launchs-media)).

## Metrics are in the MVP

Decided on 2026-10-24 by the owner: **all the metrics move into the MVP**, not phase 4. Data not
collected is lost for good, and the first launch is the first data point that matters. Shipcast gets
one metrics connector per source, stores the readings in SQLite and ties each to the launch and the
channel that produced it, so it can say which channel worked.

| Source | What it measures | Access |
| --- | --- | --- |
| Blog | Visits per article and where they came from | Cloudflare Web Analytics, live on the blog since 2026-10-24 (cookieless; the privacy policy says so) |
| Google Search Console | Searches, impressions and clicks | Property `josegarrido.dev` verified by DNS on 2026-10-24, sitemap submitted; read with a service account |
| GitHub | Stars, forks and repo traffic | The traffic API keeps 14 days, so Shipcast reads it regularly |
| dev.to | Views and reactions per article | Its API |
| Bluesky, Mastodon | Likes, reposts, replies per post | Their APIs |
| Instagram | Reach and interactions | `instagram_business_manage_insights`, granted 2026-10-24 |
| Newsletter | Sent, delivered, opens, clicks, unsubscribes, bounces | Brevo's campaign statistics |

Every link Shipcast publishes carries a per-channel marker (`?ref=<channel>`) so the blog's analytics
attribute visits even where a network strips the referrer. A dashboard to look at them is part of the
MVP too. A Search Console MCP connector for Claude Code was considered and set aside for now: there is
no official one, only small third-party projects.

## The newsletter: Brevo

Decided on 2026-10-24. The blog is static and the engine runs on a laptop that is not always on, so
subscribing, the double opt-in and unsubscribing need a service that is always reachable.

- **Brevo**, on its free plan: the limit is on sends per day (about 300), not on contacts, which is
  plenty while the list grows; a full API for campaigns, lists and statistics; double opt-in forms;
  a European company, which keeps the privacy policy simple. The free plan adds Brevo's mark to the
  footer. Free-plan figures change often; check them on Brevo's pricing page before relying on them.
- **Not the owner's own mail server**, although there is one: bulk mail from a personal server's IP
  is the quickest way to the spam folder, and complaints or bounces from a newsletter would also hurt
  the owner's everyday mail. The everyday mail stays there; the newsletter goes through a sender whose
  business is a clean reputation.
- **Rejected:** Listmonk or Keila on the owner's server (free and capable, but the same deliverability
  risk and one more service to run); a Cloudflare Worker with D1 for subscriptions and Shipcast
  sending over SMTP (more code, the same risk); Kit and MailerLite (MailerLite reportedly cut its free
  plan in June 2026; Kit's free API access was not confirmed).

The sender (`josegarrido.dev`, authenticated with Brevo's DKIM and DMARC records in Cloudflare) and the
list of each language are public and live in `brand.yml`; the API key lives in `.env`. Subscribing
happens on a Brevo form with double opt-in that the blog posts to, since the API's double opt-in call
needs the key. How it publishes is in [publishing.md](../publishing.md#the-newsletter).

## Other decisions

- **Personal brand only.** The company brand (josegarridodigio) is left out until after the MVP. The
  schemas keep brands as a concept ([brands.md](../brands.md)), so adding the second one is
  configuration, not a redesign. One GitHub token (`GITHUB_TOKEN_PERSONAL`).
- **No paid APIs.** Nothing in the MVP calls an API that charges per use. Every MVP channel and
  metrics source above has a free API or plan, and the AI runs through claudio, which costs nothing
  per launch.
- **The repository stays at `yeyo11/shipcast`.** The `shipcast` GitHub organisation has been taken
  since 2020 (and `launchloop`, the fallback name, is taken too). The name is reserved on npm: the
  owner published a placeholder `shipcast@0.0.0` on 2026-10-24.
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
Mastodon, Instagram and Brevo (Reddit drafts exist but are off by default). LinkedIn and X get no
connector for the owner; Shipcast keeps both as channels (off by default) for other brands that want
them.

Why: Postiz needs Postgres, Redis, Temporal and Elasticsearch (6–7 GB on disk, about 2 GB of RAM), too
much for a laptop tool and a hard requirement to put on the developers Shipcast is for in phase 6;
and the networks of the MVP all have free, documented APIs that a small module covers.

Postiz stays useful as **reference code**: when a connector needs to know how an API behaves in
practice (media upload, token refresh, limits), read Postiz's provider for that network
([gitroomhq/postiz-app](https://github.com/gitroomhq/postiz-app), under
`libraries/nestjs-libraries/src/integrations/social/`: `dev.to.provider.ts`, `bluesky.provider.ts`,
`mastodon.provider.ts`, `instagram.standalone.provider.ts`). Postiz is AGPL-3.0 and Shipcast is MIT:
read it to learn how an API behaves, then write the connector from the API's own documentation; never
copy its code.

## Related

[[plans/shipcast.md]] · [[claudio.md]] · [[status.md]] · [[publishing.md]] · [[decisions/main-until-mvp.md]] · [[brands.md]] · [[launches-repo.md]] · [[plans/stack.md]]
