---
created_at: 2026-10-24T19:52:52.086566015Z
updated_at: 2026-10-24T20:20:47.452908487Z
tags:
    - publishing
    - connectors
    - assets
    - metrics
    - dashboard
    - cli
    - newsletter
---
# Publishing, media and metrics

What happens after the drafts pull request ([engine.md](engine.md)): the launch's media, publishing
on every channel once the owner merges, and reading the numbers back. Built on 2026-10-24 in
`packages/assets`, `packages/connectors`, `packages/engine` (`launch-assets.ts`, `publish.ts`,
`newsletter.ts`, `metrics.ts`) and `apps/cli` (`services.ts`, `dashboard.ts`). Every connector is
Shipcast's own, over `fetch`, with no SDK ([decisions/mvp-scope.md](decisions/mvp-scope.md) says why
Postiz was dropped).

## The launch's media

`buildAssets` (`launch-assets.ts`) adds the media to the drafts pull request, under
`public/launches/<project>/<ref>/` in the launches repo, so the blog serves them once merged:

- **`og.png` and `og.jpg`**, the 1200×630 launch image, rendered by `renderOgImage`
  (`packages/assets/src/og.ts`) with Satori, resvg and jpeg-js: no browser, no native build. The PNG
  is the article's `image:` (the blog's `og:image`) and dev.to's cover; the JPEG is for Bluesky's card
  thumbnail, Mastodon and Instagram, which want JPEG. A theme (`OgTheme`) brings its fonts and its
  layout, so each brand draws its own. The personal brand's, `EDITORIAL_THEME` (merged on
  2026-10-24 after the owner saw it running), follows the site's editorial identity
  ([personal-identity.md](personal-identity.md)): the author's name, the article's headline on the
  project's flat colour in Fraunces with each word's first letter in its wonky italic, the pitch and
  the version on black, and beside them the house halftone illustration with the project's motif.
  Satori reads no variable fonts, so static TrueType instances of Fraunces and Instrument Sans, cut
  with `fonttools varLib.instancer`, live in `packages/assets/fonts/` (OFL). The colours and motifs
  per project are copied from the blog's `src/projects.ts`, hash included: a project added there has
  to be added in `og.ts` too, until both read them from one place.
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
   - **The newsletter** (`brevo.ts`): one Brevo campaign per language, described below.
   - **Reddit** is never published: its drafts are for the owner to post by hand.
5. A temporary failure (`ConnectorError.retryable`: 429, 5xx, no answer) is retried on the next
   round; a permanent one is recorded in the cursor `publish-failed:<launch>:<channel>` and not
   retried. A connector can mark a failure as not retryable whatever its status, when a retry would
   repeat what already happened. The launch is `published` when nothing is pending, otherwise it
   stays `drafted` (reported as `partial`) and the next round picks it up.

## The newsletter

Added on 2026-10-24 ([decisions/mvp-scope.md](decisions/mvp-scope.md#the-newsletter-brevo)).

- **Configuration:** `brand.yml` has a `newsletter` block with the sender (`name`, `email`), the Brevo
  list of each language (`lists: { en: <id>, es: <id> }`) and, optionally, the action URL of the
  Brevo subscription form the blog posts to. `BREVO_API_KEY` goes in `.env`. A project turns it on
  with `publishing.newsletter: approval` in its `launch.yml` (off by default).
- **The issue:** the content pack's `newsletter` piece carries one issue per language with a list:
  a subject (at most 90 characters), a preview text (at most 140) and a short Markdown note to
  subscribers linking the article with `?ref=newsletter`, not the article itself. `missingPieces`
  refuses a pack without an issue for each list. The drafts pull request has
  `launches/<project>/<ref>/newsletter-<lang>.md`, with `Subject:` and `Preview:` lines above the
  body; what is merged is what is sent.
- **The email** (`newsletter.ts`, `renderIssueHtml`): tables and inline styles, so every mail client
  renders it alike. The brand's name, the article's headline (in that language) on the project's flat
  colour as on the blog, the note in a serif face, a button to the article and the unsubscribe line
  (`{{ unsubscribe }}`, which Brevo fills in). The launch image is left out, since it carries the
  English headline the issue already sets on colour.
- **Sending:** for each language, the list's size is read first; an empty list is skipped. Otherwise a
  campaign is created and sent at once (`sendNow`); its id is kept in the cursor
  `newsletter-sent:<launch>:<lang>`, so a language is never sent twice even when another one fails and
  is retried. A refused `sendNow` leaves a draft in Brevo and is not retried, since a retry would
  create a second campaign. With nobody subscribed in any list, the channel is recorded as failed
  once ("no subscribers yet") and not retried. The post's external id joins the campaign ids
  (`12,13`), and the metrics add them up.
- **Still to do before the first issue:** verify `josegarrido.dev` in Brevo (DKIM and DMARC in
  Cloudflare), create the lists and the double opt-in form, add the form to the blog and update its
  privacy policy, and send a test (`Brevo.sendTest`) to check the unsubscribe placeholder renders.

## Metrics

`collectMetrics(registry, brand, sources)` (`metrics.ts`) reads every source for every published
launch and records each reading in the registry's `metrics` table (migration 2), so every metric has
a history and the dashboard shows the latest. One source failing never stops the others.

| Source | What | From |
| --- | --- | --- |
| `newsletter` | sent, delivered, opens, clicks, unsubscribes, bounces, complaints per issue (all languages added up); opens are inflated by Apple's privacy protection, clicks are the number to trust | Brevo's campaign statistics |
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
what is on. The newsletter needs both `BREVO_API_KEY` and the `newsletter` block in `brand.yml`. The
Instagram token lasts 60 days: `watch` refreshes it every 30 (never on the first run, since Meta
refuses to refresh a token younger than 24 hours) and keeps the fresh one in the registry, where it
wins over `.env`.

| Command | Does |
| --- | --- |
| `watch` | Each round: detect and draft, publish what is ready, refresh the Instagram token when due, and read the metrics every 6 hours |
| `publish` | Publishes every drafted launch that is ready, once |
| `metrics` | Reads every source now |
| `dashboard [--port]` | Serves the launches, their posts and latest numbers on `127.0.0.1` (default port 4321), and the same as JSON at `/api/launches`; reach it from elsewhere through Tailscale Serve |

The dashboard is plain server-rendered HTML with a neutral dark style until it is rebuilt in Cartel
from `design/specimen.html` ([plans/design-system.md](plans/design-system.md)).

## Related

[[engine.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[status.md]] · [[plans/design-system.md]] · [[personal-identity.md]]
