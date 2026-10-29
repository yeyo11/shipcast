---
created_at: 2026-10-29T16:44:03.12150434Z
updated_at: 2026-10-29T16:46:03.477217651Z
tags:
    - tracking
    - utm
    - publishing
    - channels
    - metrics
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
| dev.to, Hashnode | not tagged: the canonical URL must stay clean, and the referrer names them already | | |
| Instagram | no clickable links | | |
| YouTube | not in the table: its description keeps `?ref=youtube` | | |

With `social` as the medium, GA4 files a visit under Organic Social whatever its source.

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

## Where it lives

- `packages/schema/src/tracking.ts`, the one place the tags are decided: `UTM_CHANNELS` (the table
  above), `campaignOf`, `utmFor`, `trackedUrl`, `tagLinks` (plain text and Markdown), `tagHtmlLinks`
  (the newsletter's `href`s, with their `&` kept escaped), and the calls the adapters make: `track`,
  `trackUrl`, `trackWithinLimit`.
- `packages/engine/src/publish.ts` hands each tagged channel's publisher the launch's `tracking`
  (`{ site, campaign }`, and the issue's language for the newsletter) as a second argument. The engine
  still builds its links with `?ref=` as before; a publisher given no tracking sends them unchanged.
- Each channel's adapter in `packages/runtime/src/channels/*` tags where its text, card or embed goes
  out: Bluesky's text and card, Mastodon's text, Threads' and Telegram's text, Discord's message and
  embed, LinkedIn's text and shared article, each Reddit body with its subreddit, GitHub Discussions'
  body, and every link of the newsletter's issue (its button, its image and its body) with its
  language. The connectors never see the tracking.
- Tests: `packages/schema/test/tracking.test.ts`, `packages/runtime/test/channel-links.test.ts` (what
  each adapter hands its network), the `richText` test in `packages/connectors/test/connectors.test.ts`,
  and the newsletter's tracking in `packages/engine/test/publish.test.ts`.

## Not covered

- **Edits.** Editing a live post (Mastodon, Telegram, Discord, GitHub Discussions) sends the text as
  edited, untagged: an edit that touches a link brings its `?ref=` back.
- **New text-post channels** published through `textPostStrategy` keep `?ref=<channel>` until their
  adapter tags them and they join `UTM_CHANNELS`.
- **The site side** (phase 2, SHP-4): the blog's analytics today, Cloudflare Web Analytics, keep no
  query string, so they read neither `ref` nor the tags and attribute a visit by its referrer's host
  ([publishing.md](publishing.md#metrics)). Choosing the tool that reads the tags, the blog's
  conversion events, and a connector that reads visits by source and campaign into the app come next.

## Related

[[publishing.md]] · [[stats.md]] · [[decisions/mvp-scope.md]] · [[launch-yml.md]] · [[content-pack.md]]
