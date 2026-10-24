---
created_at: 2026-10-24T21:33:57.473488826Z
updated_at: 2026-10-24T23:48:46.173826043Z
tags:
    - publishing
    - connectors
    - assets
    - metrics
    - dashboard
    - cli
    - newsletter
    - instagram
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
  thumbnail and Mastodon, which want JPEG. A theme (`OgTheme`) brings its fonts and its layout, so
  each brand draws its own. The personal brand's, `EDITORIAL_THEME` (merged on 2026-10-24 after the
  owner saw it running), follows the site's editorial identity
  ([personal-identity.md](personal-identity.md)): the author's name, the article's headline on the
  project's flat colour in Fraunces with each word's first letter in its wonky italic, the pitch and
  the version on black, and beside them the house halftone illustration with the project's motif.
  Satori reads no variable fonts, so static TrueType instances of Fraunces and Instrument Sans, cut
  with `fonttools varLib.instancer`, live in `packages/assets/fonts/` (OFL). The colours and motifs
  per project are copied from the blog's `src/projects.ts`, hash included: a project added there has
  to be added in `og.ts` too, until both read them from one place.
- **The Instagram carousel and its story**, when the pack has an Instagram piece (decided on
  2026-10-25, after the single Reel did worst in the first launch; the owner approved the slides seen
  running). Every piece is 4:5 (1080×1350, the tallest feed format; Instagram crops a carousel to its
  first piece), drawn by `packages/assets/src/carousel.ts` in the blog's identity and named in order
  by `carouselPieces`:
  1. `instagram-01.jpg`, the cover: the project's drawn cover when the site has one
     (`<site>/covers/<project>.jpg`), otherwise the house illustration (`renderIllustration`), with
     the article's headline on the project's colour and the pack's one-line summary.
  2. `instagram-02.mp4`, the demo, when `launch.yml` names `assets.demo`: the GIF laid over a backdrop
     ("See it run" on the project's colour) by `demoOnBackdrop` through **ffmpeg** — H.264 yuv420p at
     30 fps with a silent AAC track, between 3 and 60 seconds. A demo that is named but missing, or
     that points outside the repo, fails the launch. ffmpeg must be on `PATH`.
  3. One slide per feature (2 or 3, written by Claude: a short title and one sentence).
  4. The closing slide, "The full write-up is in my bio", with the brand's `avatar` from `brand.yml`.

  `instagram-story.jpg` (1080×1920) is the cover with "Link in bio": the API cannot add a link
  sticker, so the owner chose a story without one over posting it by hand. The slides' texts are
  drawn into the images; only the caption and the comment are edited in the drafts pull request.

Binary files go into the pull request as base64 blobs through the Git data API.

## Publishing after the merge

`publishLaunch(launch, brand, deps)` (`publish.ts`) runs for each `drafted` launch:

1. Pull request **open** → wait; **closed without merging** → the launch is `skipped`.
2. **Merged** → wait until the article answers a `HEAD` on the site (the merge starts the deploy,
   and the media live there), then record the blog post, with both languages' slugs.
3. Every text is read **from the launches repo as merged**, so the owner's edits in the pull request
   are what goes out: each channel's draft after its mode line, the article's front matter, dev.to's
   tags.
4. Each channel whose mode is `auto` or `approval` and that has a connector is published once (the
   registry refuses a second post on the same channel):
   - **dev.to** (`devto.ts`): the English article with `canonical_url` to the blog, `og.png` as the
     cover.
   - **Bluesky** (`bluesky.ts`): app password session, link facets counted in UTF-8 bytes, an external
     card with `og.jpg` as its thumbnail.
   - **Mastodon** (`mastodon.ts`): `og.jpg` uploaded through `/api/v2/media`, and an
     `Idempotency-Key` of `shipcast-<launch>-mastodon`, so a retry after a timeout does not post twice.
   - **Instagram** (`instagram.ts`, Graph API v25.0): the carousel, one container per piece
     (`is_carousel_item`, videos as `media_type=VIDEO`) polled until `FINISHED`, then a `CAROUSEL`
     container with the children in order and the caption, then `media_publish` (a launch drafted
     before the carousel existed falls back to `og.jpg`). Then, each once and never reposting the
     carousel when it fails: the story (`media_type=STORIES`) and a comment under the post with the
     article's address and a question (`POST /{media}/comments`, which needs the app's
     `instagram_business_manage_comments` permission). The draft `instagram.md` lists the slides, the
     comment on its `Comment:` line, and the caption (a hook, two or three lines, at most five
     specific hashtags) after a `---` line.
   - **The newsletter** (`brevo.ts`): one Brevo campaign per language, described below.
   - **Reddit** is never published: its drafts are for the owner to post by hand.
5. A temporary failure (`ConnectorError.retryable`: 429, 5xx, no answer) is retried on the next
   round; a permanent one is recorded in the cursor `publish-failed:<launch>:<channel>` and not
   retried until `shipcast publish --retry <channel>`. A connector can mark a failure as not retryable
   whatever its status, when a retry would repeat what already happened. The launch is `published`
   when nothing is pending, otherwise it stays `drafted` (reported as `partial`) and the next round
   picks it up.

## The newsletter

Added on 2026-10-24 ([decisions/mvp-scope.md](decisions/mvp-scope.md#the-newsletter-brevo)).

- **Configuration:** `brand.yml` has a `newsletter` block with the sender (`name`, `email`), the Brevo
  list of each language (`lists: { en: <id>, es: <id> }`) and the action URL of each language's Brevo
  subscription form the blog posts to (`forms: { en: <url>, es: <url> }`). `BREVO_API_KEY` goes in
  `.env`. A project turns it on with `publishing.newsletter: approval` in its `launch.yml` (off by
  default); claudio does since its pull request #62.
- **The issue:** the content pack's `newsletter` piece carries one issue per language with a list:
  a subject (at most 90 characters), a preview text (at most 140) and a short Markdown note to
  subscribers linking the article in that language with `?ref=newsletter`, not the article itself.
  `missingPieces` refuses a pack without an issue for each list. The drafts pull request has
  `launches/<project>/<ref>/newsletter-<lang>.md`, with `Subject:` and `Preview:` lines above the
  body; what is merged is what is sent.
- **The email** (`newsletter.ts`, `renderIssueHtml`): tables and inline styles, so every mail client
  renders it alike. The brand's name, the article's headline (in that language) on the project's flat
  colour as on the blog, the note in a serif face, a button to the article and the unsubscribe line
  (`{{ unsubscribe }}`, which Brevo fills in). The launch image is left out, since it carries the
  English headline the issue already sets on colour.
- **Sending:** for each language, the list's size is read first; an empty list is skipped. Otherwise a
  campaign is created, untagged (Brevo's free plan refuses tags), and sent at once (`sendNow`); its id
  is kept in the cursor `newsletter-sent:<launch>:<lang>`, so a language is never sent twice even when
  another one fails and is retried. A refused `sendNow` leaves a draft in Brevo and is not retried,
  since a retry would create a second campaign. With nobody subscribed in any list, the channel is
  recorded as failed once ("no subscribers yet") and not retried. The post's external id joins the
  campaign ids (`12,13`), and the metrics add them up. Replies go to the sender's address.
- **Set up on 2026-10-24:** `josegarrido.dev` verified in Brevo (its code, DKIM and DMARC are in
  Cloudflare); the senders `me@` and `noreply@josegarrido.dev`; the lists `Newsletter (en)` (4) and
  `Newsletter (es)` (5) in the folder `josegarrido.dev`; one Brevo form per language with double
  opt-in and no captcha (a captcha would only work inside Brevo's own page), redirecting to
  `/en/subscribed/` and `/es/suscrito/`, and the confirmation templates in the blog's editorial style,
  created through the API (`tag: optin`, the link is `{{ doubleoptin }}`), signed "José Garrido". The
  blog posts its own form to Brevo's (Brevo answers CORS for the calling origin, and JSON with
  `?isAjax=1`), keeping Brevo's hidden trap field for bots ([launches-repo.md](launches-repo.md)). The
  first issue went out with claudio's launch on 2026-10-25.
- **Spam:** double opt-in keeps bots off the list; what is left is list bombing (bots typing other
  people's addresses, which costs sends and reputation). If it shows up, the answer is a Cloudflare
  Worker with Turnstile in front of Brevo's double opt-in API.

## Metrics

`collectMetrics(registry, brand, sources)` (`metrics.ts`) reads every source for every published
launch and records each reading in the registry's `metrics` table (migration 2), so every metric has
a history and the dashboard shows the latest. One source failing never stops the others.

| Source | What | From |
| --- | --- | --- |
| `newsletter` | sent, delivered, opens, clicks, unsubscribes, bounces, complaints per issue (all languages added up); opens are inflated by Apple's privacy protection, clicks are the number to trust | Brevo's campaign statistics |
| `devto`, `bluesky`, `mastodon`, `instagram` | views, reactions, comments, likes, reposts, reach… per post | each connector's `metrics(externalId)`; Bluesky through the public AppView, Mastodon needs `read:statuses`, Instagram through insights |
| `blog` | each language's article visits (by its own slug) and their sum, and by referrer (`views_bluesky`, `views_devto`, …) | Cloudflare Web Analytics' GraphQL API (`cloudflare.ts`) |
| `search` | clicks and impressions of both articles; Google takes two or three days to report a new page | Search Console, with a service account's JWT signed by `node:crypto` (`search-console.ts`) |
| `github` | stars, forks, watchers; views and unique visitors of the repo's last 14 days (not only since the launch) | GitHub REST (`repoStats`) |

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
| `watch` | Each round: detect and draft, publish what is ready, refresh the Instagram token when due, and read the metrics every 6 hours. Run by hand: the owner declined running it as a service |
| `publish [--retry <channel>]` | Publishes every drafted launch that is ready, once; `--retry` gives a channel that failed for good another chance |
| `metrics` | Reads every source now |
| `dashboard [--port] [--host]` | Serves the launches, their posts and latest numbers on `127.0.0.1` (default port 4321), and the same as JSON at `/api/launches`; `--host 0.0.0.0` opens it to the local network, which it trusts (no login) |

The dashboard is plain server-rendered HTML with a neutral dark style until it is rebuilt in Cartel
from `design/specimen.html` ([plans/design-system.md](plans/design-system.md)).

## Related

[[engine.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[status.md]] · [[plans/design-system.md]] · [[personal-identity.md]]
