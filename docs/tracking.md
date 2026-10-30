---
created_at: 2026-10-30T21:53:50.371749325Z
updated_at: 2026-10-30T21:54:09.429056116Z
tags:
    - tracking
    - utm
    - publishing
    - channels
    - metrics
    - youtube
    - edit-delete
---
# Link tracking: UTM tags on every published link

Built on 2026-10-29. Every link to the brand's site that Shipcast publishes carries UTM parameters
naming the network and the launch it came from, so the site's analytics can credit a visit to a
channel and a campaign instead of a bare referral (a network that strips the referrer, an app that
opens links in its own browser). Before it, Claude wrote `?ref=<channel>` into each piece and the
engine added it to LinkedIn's card, Reddit's body and the newsletter's button; Bluesky's link card
and Discord's embed went out untagged, and most analytics tools do not read `ref`.

## What a link gets

`https://josegarrido.dev/en/claudio/?ref=bluesky` goes out as
`https://josegarrido.dev/en/claudio/?utm_source=bluesky&utm_medium=social&utm_campaign=claudio-v1-0-0`.

| Channel | `utm_source` | `utm_medium` | `utm_content` |
| --- | --- | --- | --- |
| Bluesky, Mastodon, Threads, LinkedIn, Telegram, Discord | the network's name | `social` | — |
| Reddit | `reddit` | `social` | the subreddit |
| GitHub Discussions | `github` | `social` | — |
| Newsletter | `newsletter` | `email` | the issue's language (`en`, `es`) |
| YouTube | `youtube` | `social` | the video's format (`short`, `video`) |
| dev.to, Hashnode | not tagged: the canonical URL must stay clean, and the referrer names them already | | |
| Instagram | no clickable links | | |

With `social` as the medium, GA4 files a visit under Organic Social whatever its source.

**`utm_content` tells a channel's pieces apart** where one launch gets more than one piece with
links from it, so the visits of each can be compared: Reddit's post in each subreddit, the
newsletter's issue in each language, and YouTube's two videos, the Short (`short`) and the
horizontal one (`video`), added on 2026-10-30. Its values are lowercase, with dashes and no
spaces. Every other tagged channel publishes one piece with links per launch, so it has none. The
other channels with several pieces need none either: Instagram's post, story and comment have no
clickable links, and the blog's article per language (`article:<lang>`) is the page the links
point to.

**The campaign** is the launch's own (`campaignOf`): `<project>-<version>` for a release
(`shipcast-v0-2-0`), `<project>-launch` for a repo that went public, the slug for an article written
in the app. **Tracking is always on**: `launch.yml` has no `tracking` block. Choosing a launch's own
campaign, or turning the tags off, belongs to the launch itself once launches are Shipcast's own
rather than a repo and a tag (epic SHP-5, later).

## The rules

- **Only the site's links.** A link whose host is the brand's `site` (with or without `www.`) is
  tagged; a link anywhere else (GitHub, a docs site) goes out exactly as written.
- **`ref` goes, the tags come.** The link's path, its other parameters and its fragment stay.
- **Hand-written tags win.** A link that already has any `utm_*` parameter is left alone, `ref`
  included.
- **The prompt does not change.** Claude keeps writing `?ref=<channel>`: it is short, the drafts and
  the limits are counted with it, and it is what a link keeps where the tags do not fit.
- **Limits.**
  - Bluesky shows a link without its query string while the link facet keeps the whole URL
    (`richText`, `packages/connectors/src/bluesky.ts`), so the tags cost no graphemes and a reader sees
    the address, not the tags. The link card's URL is tagged too.
  - Mastodon counts every link as 23 characters, so the tags never cost the post its limit.
  - Threads, Telegram and Discord count a link's every character: a text the tags would push over its
    limit (`pieceLimitProblem`) goes out with its `?ref=` instead (`trackWithinLimit`). Discord's
    embed URL is tagged either way.
  - YouTube's description is built to fit its 5000 characters with the article's link as
    `?ref=youtube` (the link first, the text cut to the room left, the chapters last); a description
    the tags would push over 5000 goes out as built, with its `?ref=` (`trackWithinLimit` with
    `max`, since the description is not a piece the pack caps as one text).

## Where it lives

- `packages/schema/src/tracking.ts`, the one place the tags are decided: `UTM_CHANNELS` (the table
  above), `FORMAT_SOURCES` (the sources whose `utm_content` is a format) and `formatPiece` (the piece
  a format names), `campaignOf`, `utmFor`, `trackedUrl`, `tagLinks` (plain text and Markdown), `tagHtmlLinks`
  (the newsletter's `href`s, with their `&` kept escaped), and the calls the adapters make: `track`,
  `trackUrl`, `trackWithinLimit` (with the piece's `content`, and a `max` for a text that is not
  the channel's piece).
- `packages/engine/src/publish.ts` hands each tagged channel's publisher the launch's `tracking`
  (`{ site, campaign }`, and the issue's language for the newsletter) as a second argument. The engine
  still builds its links with `?ref=` as before; a publisher given no tracking sends them unchanged.
  A channel published by its own strategy (`PublishStrategy`, YouTube) finds the same tracking in
  its `PublishContext` and hands it to its publisher: `packages/engine/src/publishing/youtube.ts`
  passes it with each upload.
- Each channel's adapter in `packages/runtime/src/channels/*` tags where its text, card or embed goes
  out: Bluesky's text and card, Mastodon's text, Threads' and Telegram's text, Discord's message and
  embed, LinkedIn's text and shared article, each Reddit body with its subreddit, GitHub Discussions'
  body, every link of the newsletter's issue (its button, its image and its body) with its
  language, and each YouTube video's description with its format (`short` for the Short, `video`
  for the horizontal one, from the upload's `short`). The connectors never see the tracking.
- **Edits are tagged as the piece was published** (2026-10-30). `editPost` and `editPosts`
  (`packages/engine/src/edit.ts`) hand each editor an `EditTracking`: the launch's `{ site, campaign }`
  and the piece's kind, given the brand's `site` in `EditDeps` (the app's `editingDeps` sets it).
  Each adapter's editor tags its text as its publisher does: Mastodon's text and GitHub
  Discussions' body with `track`, Telegram's text and Discord's message with `trackWithinLimit`, and
  a YouTube video's description with its format from the piece's kind (`post:short` → `short`)
  within 5000 characters. A link the owner tagged by hand, or one already tagged, is left as it is.
  Without a `site` an edit goes out as written.
- Tests: `packages/schema/test/tracking.test.ts`, `packages/runtime/test/channel-links.test.ts` (what
  each adapter hands its network), the `richText` test in `packages/connectors/test/connectors.test.ts`,
  the newsletter's tracking in `packages/engine/test/publish.test.ts`, the YouTube strategy
  handing the tracking to its publisher in `packages/engine/test/youtube.test.ts`, and the edits'
  tracking in `packages/engine/test/edit.test.ts` and `channel-links.test.ts`.

## The other half: where a visit came from

The tags are read by whatever reads the landing page's query string. **Cloudflare Web Analytics,
the blog's analytics today, does not**: its beacon keeps no query string, and its FAQ says UTM
parameters are not supported (checked 2026-10-29), so neither `ref` nor the tags reach it. dev.to's
referrer list is the same: domains only. Those sources attribute a visit by its **referrer**, through
one table beside the tags (2026-10-29):

- `REFERRER_HOSTS` and `sourceOfReferrer(host, path)` in `packages/schema/src/tracking.ts` name the
  source of a referrer host: each channel (Bluesky, dev.to, Instagram, Reddit, mastodon.social,
  LinkedIn and `lnkd.in`, Threads, YouTube and `youtu.be`, Hashnode, Telegram, Discord), GitHub,
  `x` (`x.com`, `twitter.com`, `t.co`), `hackernews` and `facebook`; a search engine is `search`, no
  referrer `direct`, anything else `other`. A host matches itself and its subdomains. A GitHub
  referrer whose path is a repo's `/discussions/` is `githubDiscussions` (Cloudflare gives the
  referrer's path through GraphQL only).
- A source is named as its channel and as that channel's `utm_source`, so a visit has one name
  whichever way it is attributed: when a source that reads the tags arrives, its numbers line up with
  the referrer's.
- Used by the blog's numbers (`views_<source>`, [publishing.md](publishing.md#metrics)) and by
  dev.to's referrers.

Reading the tags themselves needs a source that sees the query string. **Umami** is that source
(2026-10-30, SHP-4, behind the `umami` flag until the owner's instance exists): it reads each
launch's campaign by `utm_source` and the launch page shows the visits per channel
([umami.md](umami.md)). Cloudflare's zone HTTP analytics or the blog's Worker logging `utm_source`
were the other options, not built.

## Not covered

- **Other `utm_content` in Umami.** Umami's read splits only the format sources (YouTube) by
  `utm_content`; Reddit's subreddits and the newsletter's languages stay one number per channel
  ([umami.md](umami.md)).
- **New text-post channels** published through `textPostStrategy` keep `?ref=<channel>` until their
  adapter tags them and they join `UTM_CHANNELS`.
- **The site side** (phase 2, SHP-4): the tool that reads the tags is Umami, and its read connector
  is built behind its flag ([umami.md](umami.md)); deploying Umami and the blog's conversion events
  come next.

## Related

[[publishing.md]] · [[stats.md]] · [[umami.md]] · [[decisions/mvp-scope.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[search-indexing.md]]
