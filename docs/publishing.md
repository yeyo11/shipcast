---
created_at: 2026-10-26T21:05:26.208773459Z
updated_at: 2026-10-29T19:46:46.870869312Z
tags:
    - publishing
    - connectors
    - assets
    - metrics
    - dashboard
    - cli
    - newsletter
    - instagram
    - post-model
    - job-queue
    - edit-delete
    - scheduling
    - comments
    - reddit
    - youtube
    - channels
    - correctness
    - tracking
---
# Publishing, media and metrics

What happens after the drafts pull request ([engine.md](engine.md)): the launch's media, publishing
on every channel once the owner merges, editing and deleting what went out, answering the comments
under it, and reading the numbers back. Built from 2026-10-24 in `packages/assets`,
`packages/capture`, `packages/connectors`, `packages/engine` (`launch-assets.ts`, `publish.ts`,
`publishing/`, `edit.ts`, `comments.ts`, `newsletter.ts`, `metrics.ts`), `packages/runtime`
(`channels/`, `services.ts`, `edits.ts`, `comments.ts`, `rounds.ts`, `work.ts`) and the
[web app](web-app.md). Every connector is Shipcast's own, over `fetch`, with no SDK
([decisions/mvp-scope.md](decisions/mvp-scope.md) says why Postiz was dropped).

## Channels as modules

Since 2026-10-28 each channel is one definition and one adapter with the same id
([decisions/architecture.md](decisions/architecture.md)):

- **`packages/schema/src/channels/<id>.ts`** (pure): names, icon, default mode, the pack's piece and
  prompt brief, draft files, limits and how text is counted, edit and delete capabilities, comments,
  profile, posting windows, metric families and cadence, whether it is `schedulable` and whether a
  second send is safe (`idempotent`). `CHANNEL_DEFINITIONS` in `registry.ts` lists the blog, dev.to,
  Bluesky, Mastodon, Instagram, Reddit, Hashnode, LinkedIn, the newsletter, Telegram, Discord, GitHub
  Discussions, Threads and YouTube; every per-channel table (limits, capabilities, comment channels,
  names) is derived from it.
- **`packages/runtime/src/channels/<id>.ts`**: how the channel is reached (the account's form or
  OAuth, `.env` variables, token refresh), the connector factory, and what it is wired as: publisher,
  editor, metric reader, comment reader and replier, notifier, and a publish strategy for a channel
  the engine has no run built in for (YouTube). `CHANNEL_ADAPTERS` lists them.

`buildServices` (`packages/runtime/src/services.ts`) builds the connectors of a brand from its
connected accounts through the adapters, with `.env` as the fallback ([accounts.md](accounts.md)); a
network without its credential is left out, never half-configured.

## The launch's media

`buildAssets` (`launch-assets.ts`) adds the media to the drafts pull request, under
`public/launches/<project>/<ref>/` in the launches repo, so the blog serves them once merged:

- **`og.png` and `og.jpg`**, the 1200×630 launch image, rendered by `renderOgImage`
  (`packages/assets/src/og.ts`) with Satori, resvg and jpeg-js: no browser, no native build. The PNG
  is the article's `image:` and dev.to's cover; the JPEG is for Bluesky's card thumbnail and Mastodon.
  A theme (`OgTheme`) brings its fonts and its layout, so each brand draws its own. The personal
  brand's, `EDITORIAL_THEME`, follows the site's editorial identity
  ([personal-identity.md](personal-identity.md)). Satori reads no variable fonts, so static TrueType
  instances of Fraunces and Instrument Sans live in `packages/assets/fonts/` (OFL). The colour and
  motif of each project come from the launches repo's `projects.yml`
  ([launches-repo.md](launches-repo.md)).
- **The Instagram carousel and its story**, when the pack has an Instagram piece. Every piece is 4:5
  (1080×1350), drawn by `packages/assets/src/carousel.ts` and named in order by `carouselPieces`:
  1. `instagram-01.jpg`, the cover (the project's drawn cover, or the house illustration) with the
     article's headline and the pack's one-line summary.
  2. `instagram-02.mp4`, the demo, when the launch has one: the GIF over a backdrop by
     `demoOnBackdrop` through **ffmpeg** (H.264 yuv420p, 30 fps, a silent AAC track, 3 to 60 s). A demo
     that is named but missing, or points outside the repo, fails the launch.
  3. One slide per feature (2 or 3).
  4. The closing slide, "The full write-up is in my bio", with the brand's `avatar`.

  `instagram-story.jpg` (1080×1920) is the cover with "Link in bio": the API cannot add a link
  sticker. The slides' texts are drawn into the images; only the caption and the comment are edited
  in the drafts pull request.
- **The deployed project, through Playwright**, when `launch.yml` names `assets.site`
  ([launch-yml.md](launch-yml.md#the-demo-and-the-deployed-project)): `@shipcast/capture` takes
  screenshots (desktop 1440×900, mobile 390×844 at 2x) and, when the repo has no demo GIF, records the
  tour and turns it into `demo.gif` with ffmpeg. A failed capture fails the launch.
- **YouTube's two videos are not drafted media**: they are rendered when they are published, from the
  pack's scene scripts (below).

Binary files go into the pull request as base64 blobs through the Git data API.

## Publishing after the merge

`publishLaunch(launch, brand, deps)` (`publish.ts`) runs for each `drafted` launch. With the flag
`publishing-service` every entry point (the publish job, a scheduled piece's wake-up, the round, the
CLI) calls it through `PublishingService` (`packages/engine/src/publishing/service.ts`), which adds
the per-piece claims below.

1. Pull request **open** → wait; **closed without merging** → the launch is `skipped`. A launch
   published without a pull request (`direct:<sha>`) skips this step.
2. **Merged** → wait until the article answers a `HEAD` on the site, then record the blog: one
   `article:<lang>` piece per language.
3. Every text is read **from the launches repo as merged**, so the owner's edits are what goes out:
   each channel's draft (the files its definition names), the article's front matter, dev.to's and
   Hashnode's tags. An article written in the app reads its channels from
   `articles/<slug>/launch.yml`.
4. Each channel whose mode is `auto` or `approval` and that has a connector is published once. Every
   piece is a row of its own, recorded as soon as it is out, with the connected account it went out
   with, and the registry refuses a second piece of the same kind
   ([decisions/post-model.md](decisions/post-model.md)). A channel whose piece is **scheduled** for a
   time still to come waits for it without holding the others back
   ([scheduling.md](scheduling.md)); a channel with a scheduled piece and no publisher keeps the launch
   drafted rather than leaving the piece scheduled for ever:
   - **dev.to**: the English article with `canonical_url` to the blog, `og.png` as the cover.
   - **Bluesky**: app password session, link facets counted in UTF-8 bytes (each link shown without
     its query string, its facet keeping the whole URL), an external card with `og.jpg`.
   - **Mastodon**: `og.jpg` uploaded, and an `Idempotency-Key` of `shipcast-<launch>-mastodon`, so a
     retry after a timeout does not post twice.
   - **Instagram** (Graph API v25.0): the carousel (one container per piece, polled until `FINISHED`,
     then a `CAROUSEL` container and `media_publish`); then, each once and never reposting the
     carousel, a `story` piece and a `comment` piece with the article's address. The draft
     `instagram.md` lists the slides, the comment on its `Comment:` line, and the caption after `---`.
   - **The newsletter**: one Brevo campaign per language, described below.
   - **Hashnode**: the English article with `originalArticleURL` set to the blog. Hashnode's API needs
     a paid Pro plan since 2026-05-13, so the owner left it out; built and tested with fakes only.
   - **Telegram**: `telegram.md` as the caption of `og.jpg`, to the channel.
   - **Discord**: `discord.md` through a webhook, with an embed of the article.
   - **LinkedIn**, **Threads**, **GitHub Discussions**: their draft as a post (a discussion in the
     repo's category for GitHub).
   - **Reddit**: one text post per subreddit, described below. Off by default.
   - **YouTube**: two videos, described below. Off by default.

   Every channel is published by Shipcast: there are no drafts for the owner to post by hand
   ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).

   **Links.** The drafts link the article with `?ref=<channel>`, as Claude writes them. Since
   2026-10-29 every link to the site in a post's text, link card or embed goes out with UTM tags
   instead, naming the network and the launch's campaign (`utm_source`, `utm_medium`,
   `utm_campaign`, and the subreddit or the issue's language as `utm_content`): the channel's adapter
   tags them as the piece goes out, from the one table in `packages/schema/src/tracking.ts`. dev.to
   and Hashnode keep a clean canonical URL, and a text the tags would push over its limit on Threads,
   Telegram or Discord keeps its `?ref=`. See [tracking.md](tracking.md).
5. A temporary failure (`ConnectorError.retryable`: 429, 5xx, no answer) is retried on the next run;
   a permanent one is recorded as the channel's failure cursor (its key built and read only in
   `@shipcast/schema/failures`) and not retried until the owner's **Try again** in the app or the API
   (that launch's channel) or `shipcast publish --retry <channel>` (every launch). Results are typed:
   `failures` (each with `retryable`) and, with the service, `heldElsewhere`. The launch is
   `published` when nothing is pending and nothing waits for its time; otherwise it stays `drafted`
   (reported as `partial`) and the next run picks it up.

Started from the app (approving, **Try again**, a direct publish) or by a merge's webhook, publishing
is a `publish` job ([decisions/job-queue.md](decisions/job-queue.md)): while the site has not deployed
(or some channels will retry) the job is tried again 30 seconds later, up to 40 times. A launch has
one publish job waiting at most. The owner hears of the result once, through `NotificationService`,
quiet while only retryable failures wait.

### Publishing each piece once

Built on 2026-10-28 behind `publishing-service`
([decisions/publishing-state.md](decisions/publishing-state.md)). Before it, the round's publish step
and a `publish` job could publish the same launch at once, and most channels were protected only by
the `posts` row written after the network call.

- **`publish_attempts`** holds one row per piece (launch, channel, kind), claimed **before** the
  network is called: `attempting` (with a 20-minute lease), `live`, `retryable`, `failed`, or
  `unknown` when a worker died mid-call on a network that cannot recognise a second send.
- **`PieceGuard`** (`publishing/guard.ts`) runs each send: claim (one `INSERT … ON CONFLICT DO UPDATE …
  WHERE <takeable>`, so exactly one worker wins), then `stillNeeded` re-reads the launch's pieces so a
  worker that read them before another's piece went out sends nothing, then the call, then closing
  the claim with the network id and URL, or the failure and whether it is retryable. Only the holder
  closes its claim.
- A lapsed lease is taken over only on an **idempotent** channel (Mastodon's key; Reddit, which looks
  for its submission first). Anywhere else the piece becomes `unknown` and waits for the owner to
  check the channel and **Try again**.
- **The round only queues**: each approved launch gets its publish job, whose key runs one at a time.
- **One Try again** (`retryChannel`, `publishing/retry.ts`) for the web, the API, the job and the
  CLI: it clears the channel's failure cursor and its attempts.

### Reddit

Added on 2026-10-26 ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).

- **The account**: the owner's Reddit "web app" (API access granted by request since November 2025),
  its client id and secret in Settings, and its redirect uri set to the app's `/auth/reddit/callback`.
  Connecting asks for `identity submit read history edit` with `duration=permanent`; the refresh
  token is kept in the secret store with the app's client. Every request carries the `User-Agent`
  Reddit asks for. `history` (listing the account's own submissions) and `edit` (deleting them)
  joined on 2026-10-29: Reddit's token answer says the scopes granted, and a token from before is
  refused what it lacks before any request, with "connect the account again".
- **The drafts**: one `reddit-<subreddit>.md` per subreddit in `launch.yml`, a `Title:` line, `---` and
  the Markdown body. The body links the article with `?ref=reddit`; when an edit took the link out, it
  is added back. The link goes out with UTM tags naming the subreddit ([tracking.md](tracking.md)).
- **Publishing**: `POST /api/submit` (`kind=self`) per subreddit, each its own piece,
  `post:<subreddit>`. A rule of the subreddit is final and waits for **Try again**; a rate limit is
  tried again. A refused subreddit never holds back the others.
- **Never twice**: before a submit the attempt is recorded; a retry first looks for a post with that
  title among the account's newest submissions since the attempt (`/user/<name>/submitted`, which
  needs `history`), and records it instead of submitting again. That is why Reddit's definition is
  `idempotent`. Without `history` the lookup is refused and the retry stops there, never posting a
  second time: Reddit waits for the account to be connected again.
- **After**: a post can be deleted (`/api/del`, which needs `edit`); a title can never change and
  editing the body is not built. Reddit is not schedulable.
- **Numbers**: each subreddit's post is read through `/api/info` (`read`), up to 100 a call, hourly:
  `score`, `comments`, `crossposts` and `upvoteRatio`, the share of votes that are upvotes, from 0
  to 1. The ratio is averaged across a launch's posts, never added up (`metrics.averaged` on the
  definition). Views and shares are not in Reddit's API. No comments yet.

### YouTube

Added on 2026-10-28 as the first network built on the channel modules
([decisions/youtube.md](decisions/youtube.md)). Two videos per launch, a **Short** (1080×1920, under
60 s) and a **horizontal video** (1920×1080, 1 to 3 minutes, with chapters), rendered when published
(`youtubeStrategy`, `packages/engine/src/publishing/youtube.ts`, with `renderVideo` from
`packages/assets/src/youtube.ts`) from the pack's `youtube` piece: scenes (`card`, `demo`,
`screenshot`, `cover`) with subtitles burned in and uploaded as an SRT caption track; no voice. Each
video is its own piece (`post:short`, `post:video`). The upload is resumable and its session's POST is
never repeated; captions and the thumbnail are extras that never undo a video. The quota (10,000
units a day; an upload costs 1,600) is checked before an upload starts. Each upload asks for
`public`; the first two (the Sluice article's, 2026-10-29) came out public although the API project
is not audited. Should Google keep one `private`, the video is still recorded as published and a
`youtube-privacy:<postId>` cursor notes "private until Google audits the project": a fallback, not a
failure ([decisions/youtube.md](decisions/youtube.md#privacy-and-googles-audit)). Not schedulable.

### Scheduled pieces

A channel's piece can wait for a time: a `scheduled` row of its own, which becomes the published row
when it goes out. A `scheduled` job per piece queues the launch's publishing at that time (on BullMQ,
a delayed job `post:<id>`, rebuilt from the rows every ten minutes), and the round publishes whatever
is overdue. See [scheduling.md](scheduling.md).

## After publishing: editing and deleting

Added on 2026-10-25 ([decisions/edit-delete.md](decisions/edit-delete.md)). A published piece is edited
or deleted on its network with the account it went out with, through `PostService`, from the launch
page and the REST API ([api.md](api.md)).

What each channel can do is its definition's `edit` block, gathered as `CAPABILITIES` and served at
`GET /api/v1/capabilities`: `{ edit: 'yes' | 'no' | 'partial', delete: 'yes' | 'no' | 'unpublish',
note, fields }`.

| Channel | Edit | Delete | Fields |
| --- | --- | --- | --- |
| Mastodon | yes | yes | text, link, image |
| Telegram | yes (text or caption; a photo's photo) | yes, within 48 hours | text, link, image |
| Discord | yes, through the webhook | yes | text, link |
| dev.to | yes | unpublish (no delete in its API) | text, title, tags, link (canonical), image (cover) |
| Hashnode | yes | yes | text, title, tags, link (canonical), image (cover) |
| GitHub Discussions | yes | yes | text, title |
| YouTube | yes (the snippet's given fields) | yes | text (description), title, tags |
| Blog | yes, by a commit | yes, by a commit | text, title, tags |
| Bluesky, Threads, LinkedIn, Reddit | no | yes | — |
| Instagram, Newsletter (sent) | no | no | — |

- **One piece:** `editPost` and `deletePost` read the row, refuse what the network cannot do before any
  request, build the connector with the row's account (`postEditors` in
  `packages/runtime/src/edits.ts`), send it, and update the row: `edited` with the `content_hash`, or
  `deleted`. A story, a comment, a newsletter issue or a piece still `scheduled` is refused. A network
  that answers 404 to a delete counts as deleted.
- **A whole launch:** `editPosts(launchId, changes, channels?)` sends the shared fields to every live
  piece of the channels named, each network taking what it has; `deleteLaunchPosts` deletes them. One
  outcome per piece, and one failure never stops the rest. The launch page's multi-edit and the API
  call the same implementation.
- **The blog:** an edit rewrites the article on the launches repo's `main` (`updatedDate` set), a
  delete removes it; each is one commit, which deploys the site.
- **A launch happens once:** a deleted row stays, so the channel stays done.

## Comments: the assistant

Added on 2026-10-25 ([decisions/comment-assistant.md](decisions/comment-assistant.md)), through
`CommentService`. The comments under Shipcast's own posts are read, each new one gets a reply drafted
by the AI, and a reply goes out with the post's account when the owner approves it, or at once on a
channel set to auto.

| Channel | Read | Reply |
| --- | --- | --- |
| Mastodon | the status's replies (`/context`) | a public reply mentioning the author, with an idempotency key |
| Bluesky | the post's thread, from the public AppView | a reply record threaded under the post and the comment |
| Instagram | the post's comments and their replies | `POST /{comment-id}/replies` |
| Threads, GitHub Discussions, YouTube | the post's replies, the discussion's comments, the video's comment threads | yes |
| dev.to | the article's comments | no: Forem's API cannot write one; the page links to it |
| Telegram, Discord, LinkedIn | no | no |

- **Reading:** a `comments` job every 30 minutes and on demand reads every live post of the last 30
  days and records each comment once. A post the network says no longer exists is marked `deleted`
  and never read again. With `batched-metrics`, each account's notification feed is asked once
  (`fetchCommentsByFeed`, `packages/runtime/src/channels/feeds.ts`) and only the posts it names are
  read, with a full sweep once a day for what feeds miss (the owner's own replies); a network with no
  feed is read post by post. A feed that fails is reported and its posts wait, but the daily sweep
  still runs when it is due: a Mastodon token granted before `read:notifications` (2026-10-29) fails
  its feed every run, and its comments are read once a day until it is connected again.
- **Drafting:** the `replies` AI task and the editable `reply` prompt, closed by locked rules: the code
  and the launch's analysis are the truth, the comment's language, short, and no reply to spam.
- **Modes:** each channel is `off`, `approval` (the default) or `auto`; a reply is sent once, claimed
  (compare-and-set) before it goes out.
- **Where:** the `/comments` page and the `/api/v1/comments` routes ([api.md](api.md)). In a split
  deployment the `comments` job is a heavy one, since it drafts with the AI.

## The newsletter

Added on 2026-10-24 ([decisions/mvp-scope.md](decisions/mvp-scope.md#the-newsletter-brevo)).

- **Configuration:** `brand.yml` has a `newsletter` block with the sender, the Brevo list of each
  language and each language's subscription form URL. The Brevo key is a connected account (or
  `BREVO_API_KEY` in `.env`). A project turns it on with `publishing.newsletter: approval`.
- **The issue:** the pack's `newsletter` piece carries one issue per language with a list: a subject
  (at most 90 characters), a preview text (at most 140) and a short Markdown note linking the article
  with `?ref=newsletter`. The drafts have `newsletter-<lang>.md`, with `Subject:` and `Preview:` lines
  above the body.
- **The email** (`newsletter.ts`, `renderIssueHtml`): tables and inline styles, the brand's name, the
  headline on the project's colour, the note, a button to the article and Brevo's unsubscribe line.
  Every link to the site in it (the button, the image, the note's) goes out with UTM tags naming the
  issue's language ([tracking.md](tracking.md)).
- **Sending:** for each language the list's size is read first; an empty list is skipped. Otherwise a
  campaign is created, untagged (Brevo's free plan refuses tags), and sent at once; it is recorded at
  once as that language's `issue:<lang>` piece, so a language is never sent twice. A refused `sendNow`
  leaves a draft in Brevo and is not retried. With nobody subscribed in any list, the channel fails
  once ("no subscribers yet").
- **Set up on 2026-10-24:** the domain verified in Brevo (DKIM and DMARC in Cloudflare), one list and
  one double opt-in form per language, the confirmation templates in the blog's style; the blog posts
  its own form to Brevo's ([launches-repo.md](launches-repo.md)).
- **Spam:** double opt-in keeps bots off the list; against list bombing the answer would be a
  Cloudflare Worker with Turnstile in front of Brevo.

## Metrics

`MetricsService` reads the numbers and records each reading in the `metrics` table, so every metric
has a history. A reading of a post or a newsletter issue points at that piece; the blog's, search's
and GitHub's are the launch's. One source failing never stops the others. A deleted piece is no
longer read.

| Source | What | From |
| --- | --- | --- |
| `newsletter` | sent, delivered, opens, clicks, unsubscribes, bounces, complaints per issue, added up | Brevo's campaign statistics |
| `devto`, `hashnode`, `bluesky`, `mastodon`, `instagram`, `threads`, `reddit`, `githubDiscussions`, `youtube` | views, reactions, comments, likes, reposts, quotes, saves, score, reach… per post | each adapter's metric reader; batch-first (Bluesky 25 posts a call, YouTube 50, Reddit 100) |
| `blog` | each language's article visits and their sum, and by referrer | Cloudflare Web Analytics' GraphQL API, the paths in one query |
| `search` | clicks and impressions; Google's URL inspection | Search Console (service account JWT) |
| `bing` | clicks, impressions, crawl state | Bing Webmaster |
| `github` | stars, forks, watchers; views and unique visitors of the last 14 days | GitHub REST (`repoStats`), once per repo |

Which pieces have numbers of their own is one rule, `readsMetrics(channel, kind)` in
`packages/schema/src/channels/registry.ts`: a post, each newsletter issue, and a channel's own pieces
where its definition has metrics (each of YouTube's videos, each subreddit's Reddit post); never
Instagram's story or comment, and the blog per article URL rather than per piece. The metrics rounds
and the freshness check ([measurement.md](measurement.md#the-checks)) both use it.

**Two schedules**, by the `batched-metrics` flag:

- **Off** (production until 2026-10-29): `collectMetrics` reads every source for every published
  launch every 6 hours (`0 */6 * * *`), one call per post.
- **On** (production since 2026-10-29): `collectHourly` runs every hour (`3 * * * *`) and reads a
  source only when its last check is older than its cadence: each channel's from its definition
  (hourly, batched), the site's from `SITE_CADENCES` (GitHub counts hourly and conditional; traffic,
  Search Console analytics and Bing daily; URL inspection daily until indexed, then weekly, and never
  past 90 days). A value read again unchanged moves its reading's `checked_at` instead of adding a
  row. Accounts' sessions and identities are kept between runs (in Redis with `redis-state`).

Telegram, Discord and LinkedIn give no numbers back. The per-post numbers, scored per network
([stats.md](stats.md)), are also what the recommended publishing times learn from
([scheduling.md](scheduling.md#recommended-times)).

Two limits: **Cloudflare Web Analytics does not keep the query string**, so visits are attributed by
the referrer's host (Mastodon's many hosts count as `other`) and the UTM tags the links carry
([tracking.md](tracking.md)) wait for an analytics tool that reads them; **GitHub traffic needs push
access**, so without a connected GitHub account only the public numbers are recorded.

## The rounds and the shipcast command

The round (`runRound`, `packages/runtime/src/rounds.ts`) claims new releases (when polling; each
claimed launch is queued as a `draft` job) and publishes every drafted launch that is ready, scheduled
pieces whose time has passed included; with `publishing-service` it only queues each launch's publish
job. It is a job of the queue: one queued and one running, each sending the next an interval later,
with a watchdog cron every ten minutes in case the chain breaks. The metrics, the comments (every 30
minutes), Instagram's token refresh (daily) and the account snapshots (daily) are jobs of their own.
The queue is pg-boss, or BullMQ with the `bullmq` flag ([decisions/redis.md](decisions/redis.md)); in a
split deployment the `worker` role runs the clock and the network-bound jobs, the `heavy` role the AI
ones ([server.md](server.md)). With automation off, none of them runs unless sent by hand. With
Telegram connected, the owner's own chat with the bot hears when drafts wait, when a launch is
published or fails, and when replies are drafted.

| Command | Does |
| --- | --- |
| `watch [--interval <s>]` | A worker of the job queue beside (or instead of) the app, in the Automation settings' mode |
| `publish [--retry <channel>]` | Publishes every drafted launch that is ready, once, and lists the channels still waiting for their time; `--retry` gives a channel that failed for good another chance |
| `metrics` | Reads every source now, as a job of the queue |

## Related

[[engine.md]] · [[web-app.md]] · [[scheduling.md]] · [[stats.md]] · [[accounts.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[launches-repo.md]] · [[server.md]] · [[api.md]] · [[personal-identity.md]] · [[decisions/architecture.md]] · [[decisions/publishing-state.md]] · [[decisions/youtube.md]] · [[decisions/redis.md]] · [[decisions/mvp-scope.md]] · [[decisions/automatic-channels-only.md]] · [[decisions/post-model.md]] · [[decisions/job-queue.md]] · [[decisions/edit-delete.md]] · [[decisions/comment-assistant.md]] · [[plans/mvp-close.md]] · [[status.md]] · [[measurement.md]] · [[tracking.md]]
