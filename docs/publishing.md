---
created_at: 2026-10-24T18:51:28.699807047Z
updated_at: 2026-10-24T18:51:28.699807047Z
tags:
    - publishing
    - connectors
    - assets
    - metrics
    - dashboard
    - cli
---
# Publishing, media and metrics

What happens after the drafts pull request ([engine.md](engine.md)): the launch's media, publishing
on every channel once the owner merges, and reading the numbers back. Built on 2026-10-24 in
`packages/assets`, `packages/connectors`, `packages/engine` (`launch-assets.ts`, `publish.ts`,
`metrics.ts`) and `apps/cli` (`services.ts`, `dashboard.ts`). Every connector is Shipcast's own,
over `fetch`, with no SDK ([decisions/mvp-scope.md](decisions/mvp-scope.md) says why Postiz was
dropped).

## The launch's media

`buildAssets` (`launch-assets.ts`) adds the media to the drafts pull request, under
`public/launches/<project>/<ref>/` in the launches repo, so the blog serves them once merged:

- **`og.png` and `og.jpg`**, the 1200×630 launch image, rendered by `renderOgImage`
  (`packages/assets/src/og.ts`) with Satori, resvg and jpeg-js: no browser, no native build. The PNG
  is the article's `image:` and dev.to's cover; the JPEG is for Bluesky's card thumbnail, Mastodon and
  Instagram, which want JPEG. Its theme (`DEFAULT_THEME`) is a **placeholder** until the blog's new
  design system lands; the owner validates the final look.
- **`demo.mp4`**, when `launch.yml` names `assets.demo`: the GIF or video in the launched repo turned
  into an Instagram Reel by `demoToReel` (`video.ts`) through **ffmpeg** — 1080×1920, H.264 yuv420p,
  30 fps, a silent AAC track, at least 3 s (Meta rejects Reels without audio or shorter). A demo that
  is missing or points outside the repo fails the launch rather than publishing without it. ffmpeg
  must be on `PATH` (a static build in `~/.local/bin` on the owner's machine).

Binary files go into the pull request as base64 blobs through the Git data API.

## Publishing after the merge

`publishLaunch(launch, brand, deps)` (`publish.ts`) runs for each `drafted` launch:

1. Pull request **open** → wait; **closed without merging** → the launch is `skipped`.
2. **Merged** → wait until the article answers a `HEAD` on the site (the merge starts the deploy,
   and the media live there), then record the blog post.
3. Every text is read **from the launches repo as merged**, so the owner's edits in the pull request
   are what goes out: each channel's draft after its mode line, the article's front matter, dev.to's
   tags.
4. Each channel whose mode is `auto` or `approval` and that has a connector is published once (the
   registry refuses a second post on the same channel):
   - **dev.to** (`devto.ts`): the article with `canonical_url` to the blog, `og.png` as the cover.
   - **Bluesky** (`bluesky.ts`): app password session, link facets counted in UTF-8 bytes, an external
     card with `og.jpg` as its thumbnail.
   - **Mastodon** (`mastodon.ts`): `og.jpg` uploaded through `/api/v2/media`, and an
     `Idempotency-Key` of `shipcast-<launch>-mastodon`, so a retry after a timeout does not post twice.
   - **Instagram** (`instagram.ts`, Graph API v25.0): a container, polled until its `status_code` is
     `FINISHED`, then `media_publish`; a Reel from `demo.mp4` when it is live, otherwise `og.jpg`.
   - **Reddit** is never published: its drafts are for the owner to post by hand.
5. A temporary failure (`ConnectorError.retryable`: 429, 5xx, no answer) is retried on the next
   round; a permanent one is recorded in the cursor `publish-failed:<launch>:<channel>` and not
   retried. The launch is `published` when nothing is pending, otherwise it stays `drafted`
   (reported as `partial`) and the next round picks it up.

## Metrics

`collectMetrics(registry, brand, sources)` (`metrics.ts`) reads every source for every published
launch and records each reading in the registry's `metrics` table (migration 2), so every metric has
a history and the dashboard shows the latest. One source failing never stops the others.

| Source | What | From |
| --- | --- | --- |
| `devto`, `bluesky`, `mastodon`, `instagram` | views, reactions, comments, likes, reposts, reach… per post | each connector's `metrics(externalId)`; Bluesky through the public AppView, Instagram through insights |
| `blog` | the article's visits in both languages, and by referrer (`views_bluesky`, `views_devto`, …) | Cloudflare Web Analytics' GraphQL API (`cloudflare.ts`) |
| `search` | clicks and impressions of both articles | Search Console, with a service account's JWT signed by `node:crypto` (`search-console.ts`) |
| `github` | stars, forks, watchers; views and unique visitors of the last 14 days | GitHub REST (`repoStats`) |

Two limits found while building it:

- **Cloudflare Web Analytics does not keep the query string**, so the `?ref=<channel>` on every link
  cannot be read back; visits are attributed by the referrer's host instead. Mastodon instances are
  many hosts, so their visits count as `other`.
- **GitHub traffic needs push access**: a fine-grained token needs "Administration: read" on the
  repo; without it only the public numbers are recorded.

## The shipcast command

`apps/cli/src/services.ts` builds the connectors from `.env` and `brand.yml`: the public parts (the
Bluesky handle, the Mastodon instance) come from the brand's profile URLs unless `.env` overrides
them; a network without its secret is left out, never half-configured, and `shipcast status` lists
what is on. The Instagram token lasts 60 days: `watch` refreshes it every 30 (never on the first run,
since Meta refuses to refresh a token younger than 24 hours) and keeps the fresh one in the registry,
where it wins over `.env`.

| Command | Does |
| --- | --- |
| `watch` | Each round: detect and draft, publish what is ready, refresh the Instagram token when due, and read the metrics every 6 hours |
| `publish` | Publishes every drafted launch that is ready, once |
| `metrics` | Reads every source now |
| `dashboard [--port]` | Serves the launches, their posts and latest numbers on `127.0.0.1` (default port 4321), and the same as JSON at `/api/launches`; reach it from elsewhere through Tailscale Serve |

The dashboard is plain server-rendered HTML with a neutral dark style until Shipcast's design system
is settled and validated by the owner.

## Related

[[engine.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[status.md]] · [[plans/design-system.md]]
