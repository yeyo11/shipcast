---
created_at: 2026-10-26T19:54:54.663156746Z
updated_at: 2026-10-26T20:55:07.267021957Z
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
---
# Publishing, media and metrics

What happens after the drafts pull request ([engine.md](engine.md)): the launch's media, publishing
on every channel once the owner merges, editing and deleting what went out, answering the comments
under it, and reading the numbers back. Built on 2026-10-24 in `packages/assets`, `packages/capture`,
`packages/connectors`, `packages/engine` (`launch-assets.ts`, `publish.ts`, `edit.ts`, `comments.ts`,
`newsletter.ts`, `metrics.ts`), `packages/runtime` (`services.ts`, `edits.ts`, `comments.ts`,
`rounds.ts`, `work.ts`) and the [web app](web-app.md). Every connector is Shipcast's own, over
`fetch`, with no SDK ([decisions/mvp-scope.md](decisions/mvp-scope.md) says why Postiz was dropped).

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
  with `fonttools varLib.instancer`, live in `packages/assets/fonts/` (OFL). The colour and motif of
  each project come from the launches repo's `projects.yml`, which the blog reads too (one list since
  2026-10-25); a project without a cover gets one drawn by `renderCover`
  ([launches-repo.md](launches-repo.md)).
- **The Instagram carousel and its story**, when the pack has an Instagram piece (decided on
  2026-10-25, after the single Reel did worst in the first launch; the owner approved the slides seen
  running). Every piece is 4:5 (1080×1350, the tallest feed format; Instagram crops a carousel to its
  first piece), drawn by `packages/assets/src/carousel.ts` in the blog's identity and named in order
  by `carouselPieces`:
  1. `instagram-01.jpg`, the cover: the project's drawn cover when the site has one
     (`<site>/covers/<project>.jpg`), otherwise the house illustration (`renderIllustration`), with
     the article's headline on the project's colour and the pack's one-line summary.
  2. `instagram-02.mp4`, the demo, when the launch has one (a GIF in `assets.demo`, or one recorded
     from `assets.site`): the GIF laid over a backdrop ("See it run" on the project's colour) by
     `demoOnBackdrop` through **ffmpeg** — H.264 yuv420p at 30 fps with a silent AAC track, between 3
     and 60 seconds. A demo that is named but missing, or that points outside the repo, fails the
     launch. ffmpeg must be on `PATH`.
  3. One slide per feature (2 or 3, written by Claude: a short title and one sentence).
  4. The closing slide, "The full write-up is in my bio", with the brand's `avatar` from `brand.yml`.

  `instagram-story.jpg` (1080×1920) is the cover with "Link in bio": the API cannot add a link
  sticker, so the owner chose a story without one over posting it by hand. The slides' texts are
  drawn into the images; only the caption and the comment are edited in the drafts pull request.

- **The deployed project, through Playwright** (2026-10-25), when `launch.yml` names `assets.site`
  ([launch-yml.md](launch-yml.md#the-demo-and-the-deployed-project)): `@shipcast/capture` opens it in
  headless Chromium, takes screenshots (desktop 1440×900, mobile 390×844 at 2x, the first screen of
  each listed page) into `public/<media dir>/screenshots/<name>-<viewport>.png`, and, when the repo
  has no demo GIF, records the tour at 1280×800 and turns it into `demo.gif` with ffmpeg (800 wide,
  10 fps, one palette, at most 12 seconds: about 3 MB for the default tour of a real site), which
  feeds the carousel's video like a committed GIF. A failed capture fails the launch. Chromium comes
  from Playwright's own install (`npx playwright install chromium` on the machine that runs Shipcast);
  the test suite never launches a browser.

Binary files go into the pull request as base64 blobs through the Git data API.

## Publishing after the merge

`publishLaunch(launch, brand, deps)` (`publish.ts`) runs for each `drafted` launch:

1. Pull request **open** → wait; **closed without merging** → the launch is `skipped`. A launch
   published without a pull request (`direct:<sha>`) skips this step: its drafts are on main already.
2. **Merged** → wait until the article answers a `HEAD` on the site (the merge starts the deploy,
   and the media live there), then record the blog: one `article:<lang>` piece per language, each at
   its own URL with its slug as the external id.
3. Every text is read **from the launches repo as merged**, so the owner's edits in the pull request
   (or in the app, which commits them to its branch) are what goes out: each channel's draft after its
   mode line, the article's front matter, dev.to's and Hashnode's tags. An article written in the app
   reads its channels from `articles/<slug>/launch.yml` instead of a project's `launch.yml`.
4. Each channel whose mode is `auto` or `approval` and that has a connector is published once. Every
   piece is a row of its own, recorded as soon as it is out, with the connected account it went out
   with (none for credentials from `.env`), and the registry refuses a second piece of the same kind
   ([decisions/post-model.md](decisions/post-model.md)). A channel is done once it has its `post`,
   whichever account published it and whatever its status since (edited or deleted); the newsletter
   once every language with a list has its issue, and Reddit once every subreddit has its post. A
   channel whose piece is **scheduled** for a time still to come waits for it without holding the
   others back, and goes out on the first run at or after its time; a cancelled one is skipped
   ([scheduling.md](scheduling.md)):
   - **dev.to** (`devto.ts`): the English article with `canonical_url` to the blog, `og.png` as the
     cover.
   - **Bluesky** (`bluesky.ts`): app password session, link facets counted in UTF-8 bytes, an external
     card with `og.jpg` as its thumbnail.
   - **Mastodon** (`mastodon.ts`): `og.jpg` uploaded through `/api/v2/media`, and an
     `Idempotency-Key` of `shipcast-<launch>-mastodon`, so a retry after a timeout does not post twice.
   - **Instagram** (`instagram.ts`, Graph API v25.0): the carousel, one container per piece
     (`is_carousel_item`, videos as `media_type=VIDEO`) polled until `FINISHED`, then a `CAROUSEL`
     container with the children in order and the caption, then `media_publish` (a launch drafted
     before the carousel existed falls back to `og.jpg`). The post is recorded at once; then, each
     once and never reposting the carousel when it fails, a `story` piece (`media_type=STORIES`) and
     a `comment` piece under the post with the article's address and a question
     (`POST /{media}/comments`, which needs the app's `instagram_business_manage_comments`
     permission). The draft `instagram.md` lists the slides, the comment on its `Comment:` line, and
     the caption (a hook, two or three lines, at most five specific hashtags) after a `---` line.
   - **The newsletter** (`brevo.ts`): one Brevo campaign per language, described below.
   - **Hashnode** (`hashnode.ts`, 2026-10-25): the English article with `originalArticleURL` set to the
     blog, `og.png` as the cover, tags from the merged `hashnode.md`. Hashnode's API needs a paid Pro
     plan since 2026-05-13, so the owner left it out; the connector is built and tested with fakes only.
   - **Telegram** (`telegram.ts`): the edited `telegram.md` as the caption of `og.jpg`, to the channel;
     its link is `t.me/<channel>/<id>`, or `t.me/c/<id>/<id>` for a private one.
   - **Discord** (`discord.ts`): the edited `discord.md` through a webhook, with an embed of the article
     (title, link, description, `og.png`).
   - **Reddit** (`reddit.ts`, 2026-10-26): one text post per subreddit, described below. Off by
     default; a project turns it on with `publishing.reddit: approval` and its subreddits.

   Every channel is published by Shipcast: the Show HN draft, the Product Hunt kit and the `manual`
   mode were removed on 2026-10-26 ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).
5. A temporary failure (`ConnectorError.retryable`: 429, 5xx, no answer) is retried on the next
   round; a permanent one is recorded in the cursor `publish-failed:<launch>:<channel>` and not
   retried until `shipcast publish --retry <channel>` (every launch) or **Try again** in the app (that
   launch only). A connector can mark a failure as not retryable whatever its status, when a retry
   would repeat what already happened. The launch is `published` when nothing is pending and nothing
   waits for its time, otherwise it stays `drafted` (reported as `partial`, with the channels still
   `scheduled`) and the next round picks it up.

Started from the app (approving, **Try again**, a direct publish) or by a merge's webhook, publishing
is a `publish` job of the queue ([decisions/job-queue.md](decisions/job-queue.md)): one try per
attempt, and while the site has not deployed (or some channels will retry) the job is tried again 30
seconds later, up to 40 times, so the 20-minute wait survives a restart. A launch has one publish job
waiting at most, and the round leaves a launch with one alone.

### Reddit

Added on 2026-10-26, when Reddit stopped being a draft for the owner to post by hand
([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)). Postiz's provider was
read to learn how Reddit's API behaves; the connector is written from Reddit's own API.

- **The account**: the owner's Reddit app, a "web app" at reddit.com/prefs/apps whose API access
  Reddit has approved (it grants access by request since November 2025), its client id and secret in
  Settings (`REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` before that), and its redirect uri set to the
  app's `/auth/reddit/callback`. Connecting asks for `identity submit read` with
  `duration=permanent`, so the refresh token never expires; it is kept in the keychain with the app's
  client, since a refresh token is only good with the app that issued it. Each run trades it for an
  access token of an hour; every request carries the `User-Agent` Reddit asks for.
- **The drafts**: one `reddit-<subreddit>.md` per subreddit in `launch.yml`, a `Title:` line, `---`
  and the Markdown body, edited in the pull request like the others. The body links the article with
  `?ref=reddit`; when an edit took the link out, it is added back at the end.
- **Publishing**: `POST /api/submit` (`kind=self`) per subreddit, each recorded at once as its own
  piece, `post:<subreddit>`, so the channel is done when every subreddit has its post. Reddit refuses
  a submission with a 200 and a list of errors: a rule of the subreddit (a flair it requires, a title
  it forbids) is final and waits for **Try again**; a rate limit is tried on the next round. A refused
  subreddit never holds back the others.
- **Never twice**: before a submit the attempt is recorded (`reddit-attempt:<launch>:<subreddit>`);
  a retry first looks for a post with that title in that subreddit among the account's newest
  submissions since the attempt, and records it instead of submitting again.
- **After**: a post can be deleted (`POST /api/del`); a Reddit title can never change and editing the
  body is not built. The account's followers and karma are read with its snapshots; no per-post
  numbers and no comments yet. Reddit is not schedulable: a schedule is one row per channel.

### Scheduled pieces

A channel's piece can wait for a time (`POST /api/v1/launches/{id}/schedule`): a `scheduled` row of
its own, which becomes the published row when it goes out. A `scheduled` job per piece queues the
launch's publishing at that time, and the round publishes whatever is overdue, so a slot missed while
the machine was off goes out when it is back. The model, the due job and the recommended times are in
[scheduling.md](scheduling.md).

## After publishing: editing and deleting

Added on 2026-10-25 (phase 9; why each choice is in
[decisions/edit-delete.md](decisions/edit-delete.md)). A published piece is edited or deleted on its
network with the account it went out with, from the engine (`edit.ts`) and the REST API
([api.md](api.md)); the launch page's actions come next, on the same functions.

What each channel can do is one static map, `CAPABILITIES`, read by the app and served at
`GET /api/v1/capabilities`: `{ edit: 'yes' | 'no' | 'partial', delete: 'yes' | 'no' | 'unpublish',
note, fields }`.

| Channel | Edit | Delete | Fields |
| --- | --- | --- | --- |
| Mastodon | yes | yes | text, link, image |
| Telegram | yes (text or caption; a photo's photo) | yes, within 48 hours | text, link, image |
| Discord | yes, through the webhook | yes | text, link |
| dev.to | yes | unpublish (no delete in its API) | text (the body), title, tags, link (canonical), image (cover) |
| Hashnode | yes | yes | text (the body), title, tags, link (canonical), image (cover) |
| Bluesky | no | yes | — |
| Instagram | no | no | — |
| Newsletter (sent) | no | no | — |
| Blog | yes, by a commit | yes, by a commit | text (the body), title, tags |
| GitHub Discussions | yes | yes | text (the body), title |
| Threads | no | yes | — |
| LinkedIn | no | yes | — |
| Reddit | no | yes | — |

- **One piece:** `editPost(postId, changes, deps)` and `deletePost(postId, deps)` read the row, refuse
  what the network cannot do (with the capability's note) before any request, build the connector
  with the row's account (`postEditors` in `packages/runtime/src/edits.ts`; `.env` for a row with
  none), send it, and update the row: `edited` with the `content_hash` of what was sent, or
  `deleted`, and `updated_at`. Only a channel's `post`, a subreddit's post and the blog's articles are
  edited or deleted; a story, a comment or a newsletter issue is refused, and so is a piece still
  `scheduled`, which is on no network yet (its schedule is moved or cancelled instead). A network that
  answers 404 to a delete counts as deleted.
- **A whole launch:** `editPosts(launchId, changes, channels?)` sends the shared fields (text, link,
  image) to every live piece of the channels named, each network taking what it has (the text is the
  post on Mastodon and Telegram with the link after it, the message on Discord, the body on dev.to,
  Hashnode and the blog); `deleteLaunchPosts(launchId, channels?)` deletes them. Both answer one
  outcome per piece, leave scheduled pieces out, and never let one failure stop the rest.
- **The blog:** an edit rewrites `src/content/posts/<lang>/<slug>.md` on the launches repo's `main`
  (the front matter kept as written, `updatedDate` set), a delete removes it, and the launch's media
  folder only once no other language of the launch is left; each is one commit, which deploys the site.
- **A launch happens once:** a deleted row stays, so the channel stays done and the piece is never
  published again, even with the launch drafted again.

## Comments: the assistant

Added on 2026-10-25 (phase 10; the decisions are in
[decisions/comment-assistant.md](decisions/comment-assistant.md)). The comments under Shipcast's own
posts are read, each new one gets a reply drafted by the AI, and a reply goes out with the account
the post went out with when the owner approves it, or at once on a channel set to auto.

| Channel | Read | Reply |
| --- | --- | --- |
| Mastodon | the status's public and unlisted replies (`/context`) | a public reply mentioning the author, with an idempotency key |
| Bluesky | the post's thread, from the public AppView | a reply record threaded under the post and the comment |
| Instagram | the post's comments and their replies | `POST /{comment-id}/replies`; both need `instagram_business_manage_comments` |
| dev.to | the article's comments | no: Forem's API cannot write one; the page links to the comment to answer there |
| Telegram, Discord | no | no |

- **Reading:** a `comments` job every 30 minutes and on demand ("Check comments now") reads every
  live post of the last 30 days, records each comment once (`comments` table, unique per channel and
  network id), keeps the owner's own replies for the thread's context, and marks a comment the owner
  answered on the network as answered. A post the network says no longer exists (Bluesky's
  `NotFound`, Mastodon's own `Record not found`) is marked `deleted` and never read again, instead of
  failing the read every half hour; any other refusal stays a problem in the job's log.
- **Drafting:** the `replies` AI task and the editable `reply` prompt, closed by locked rules: the
  code and the launch's analysis are the truth, never a promise they do not back, the comment's
  language, short, and no reply to spam or abuse (suggested for dismissal instead).
- **Modes:** each channel is `off`, `approval` (the default) or `auto`; a reply is sent once, claimed
  before it goes out. With drafts ready, the owner's Telegram chat with the bot hears of them.
- **Where:** the plain `/comments` page and the `/api/v1/comments` routes ([api.md](api.md)).

## The newsletter

Added on 2026-10-24 ([decisions/mvp-scope.md](decisions/mvp-scope.md#the-newsletter-brevo)).

- **Configuration:** `brand.yml` has a `newsletter` block with the sender (`name`, `email`), the Brevo
  list of each language (`lists: { en: <id>, es: <id> }`) and the action URL of each language's Brevo
  subscription form the blog posts to (`forms: { en: <url>, es: <url> }`). The Brevo key is a
  connected account (or `BREVO_API_KEY` in `.env`). A project turns it on with
  `publishing.newsletter: approval` in its `launch.yml` (off by default); claudio does since its pull
  request #62.
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
  campaign is created, untagged (Brevo's free plan refuses tags), and sent at once (`sendNow`); it is
  recorded at once as that language's `issue:<lang>` piece, with the campaign id and its report URL,
  so a language is never sent twice even when another one fails and is retried. A refused `sendNow`
  leaves a draft in Brevo and is not retried, since a retry would create a second campaign. With
  nobody subscribed in any list, the channel is recorded as failed once ("no subscribers yet") and
  not retried. Each issue's statistics are read on their own and the launch's newsletter numbers add
  them up. Replies go to the sender's address.
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
launch and records each reading in the registry's `metrics` table, so every metric has a history and
the web app shows the latest. A reading of a post or a newsletter issue points at that piece; the
blog's, search's and GitHub's are the launch's, read for the URLs of its `article:<lang>` pieces. One
source failing never stops the others. A deleted piece is no longer read (it would only answer not
found) and keeps the numbers it last had.

| Source | What | From |
| --- | --- | --- |
| `newsletter` | sent, delivered, opens, clicks, unsubscribes, bounces, complaints per issue (all languages added up); opens are inflated by Apple's privacy protection, clicks are the number to trust | Brevo's campaign statistics |
| `devto`, `hashnode`, `bluesky`, `mastodon`, `instagram` | views, reactions, comments, likes, reposts, reach… per post | each connector's `metrics(externalId)`; Bluesky through the public AppView, Mastodon needs `read:statuses`, Instagram through insights |
| `blog` | each language's article visits (by its own slug) and their sum, and by referrer (`views_bluesky`, `views_devto`, `views_reddit`, …) | Cloudflare Web Analytics' GraphQL API (`cloudflare.ts`) |
| `search` | clicks and impressions of both articles; Google takes two or three days to report a new page | Search Console, with a service account's JWT signed by `node:crypto` (`search-console.ts`) |
| `github` | stars, forks, watchers; views and unique visitors of the repo's last 14 days (not only since the launch); not read for articles | GitHub REST (`repoStats`) |

Telegram and Discord give no numbers back: bots and webhooks cannot read views or reactions. Reddit's
per-post numbers are not read yet. The per-post numbers, scored by the stats ranking's popularity per
network ([stats.md](stats.md)), are also what the recommended publishing times learn from
([scheduling.md](scheduling.md#recommended-times)).

Two limits found while building it:

- **Cloudflare Web Analytics does not keep the query string**, so the `?ref=<channel>` on every link
  cannot be read back; visits are attributed by the referrer's host instead. Mastodon instances are
  many hosts, so their visits count as `other`.
- **GitHub traffic needs push access**: a fine-grained token needs "Administration: read" on the
  repo; without it only the public numbers are recorded.

## The rounds and the shipcast command

`buildServices` (`packages/runtime/src/services.ts`) builds the connectors from the brand's connected
accounts, with `.env` as the fallback for the brand it speaks for ([accounts.md](accounts.md)); a
network without its credential is left out, never half-configured, and `shipcast status` lists what
is on. It also says which connected account each channel publishes with, which its pieces record.
The newsletter also needs the `newsletter` block in `brand.yml`. With Telegram connected, the
owner's own chat with the bot hears when drafts wait, when a launch is published and when it fails,
and when replies to comments are drafted.

The round (`runRound` in `packages/runtime/src/rounds.ts`, 2026-10-25) is shared: claim new releases
(when polling; each claimed launch is queued as a `draft` job) and publish every drafted launch that
is ready, scheduled pieces whose time has passed included. Since phase 6 it is a job of the queue
([decisions/job-queue.md](decisions/job-queue.md)): one round at most queued and one running,
whichever process sent it, each sending the next an interval later. Reading the metrics (every 6
hours, cron `0 */6 * * *`), reading the comments (every 30 minutes, `*/30 * * * *`) and refreshing
every connected Instagram account's token that is 30 days old (daily; they last 60, and Meta refuses
to refresh one younger than a day, so a first sight only records the date) are jobs of their own.
With automation off, none of them runs unless sent by hand. The web app works every queue, or takes
GitHub webhooks instead of polling ([web-app.md](web-app.md#automation)); `watch` works the same
queues from a terminal.

| Command | Does |
| --- | --- |
| `watch [--interval <s>]` | A worker of the job queue beside (or instead of) the app, in the Automation settings' mode; `--interval` sets the seconds between rounds (never under 60) |
| `publish [--retry <channel>]` | Publishes every drafted launch that is ready, once, and lists the channels still waiting for their time; `--retry` gives a channel that failed for good another chance |
| `metrics` | Reads every source now, as a job of the queue the app lists |

The launches, their posts and numbers, approving and retrying are also in the [web app](web-app.md),
which replaced the CLI's plain dashboard on 2026-10-25.

## Related

[[engine.md]] · [[plans/mvp-close.md]] · [[web-app.md]] · [[scheduling.md]] · [[stats.md]] · [[accounts.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[decisions/automatic-channels-only.md]] · [[status.md]] · [[plans/design-system.md]] · [[personal-identity.md]] · [[decisions/post-model.md]] · [[decisions/job-queue.md]] · [[decisions/edit-delete.md]] · [[decisions/comment-assistant.md]] · [[api.md]]
