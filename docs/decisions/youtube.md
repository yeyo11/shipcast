---
created_at: 2026-10-28T17:09:24.256588256Z
updated_at: 2026-10-29T19:48:57.240875303Z
tags:
    - decision
    - youtube
    - channels
    - video
    - connectors
    - phase-3b
    - metrics
    - profiles
---
# YouTube: two videos a launch, published by Shipcast itself

Decided in [plans/goal-v0.2.md](../plans/goal-v0.2.md) (milestone 6) and
[plans/goal-refactor.md](../plans/goal-refactor.md) (phase 3b), built on 2026-10-28 as the first new
network on the channel modules ([architecture.md](architecture.md)). Like every channel it is published
by Shipcast, never left as a draft for the owner to upload by hand
([automatic-channels-only.md](automatic-channels-only.md)).

## What goes up

Two videos per launch, rendered on the worker from what the launch has (its demo, screenshots and
cover) and the scene script the content pack writes for each:

| Video | Size | Length |
| --- | --- | --- |
| A **Short** | 1080 × 1920 | under 60 s |
| A **horizontal video** | 1920 × 1080 | 1 to 3 minutes, with chapters |

- **No voice**: each scene's subtitle is the narration, burned in on a band in the brand's look **and**
  uploaded as an SRT caption track in the launch's language. No music unless a clearly licensed track
  is bundled (none is today).
- **The pack's `youtube` piece** has, for each video, a title (≤ 100), a description (≤ 5,000, the
  article's link first, the chapter list for the horizontal one), tags and a language, under the truth
  rule of the prompt, and the scenes (`card`, `demo`, `screenshot`, `cover`, each with its subtitle and
  seconds). A script that cannot fit its format is refused before anything is rendered.
- **The renderer** is `packages/assets/src/youtube.ts` (`renderVideo`): each scene a clip of its own
  (satori frame, ffmpeg overlay), joined without re-encoding. The server's image carries `ffmpeg` and
  `ffprobe` for it since 2026-10-28.

## The connector and its quota

`packages/connectors/src/youtube.ts`, on `HttpClient`:
- **Resumable upload**: the session's POST is never repeated on a lost answer (a second one would make a
  second video); the byte upload to the session's address is safe to repeat. Captions and the thumbnail
  are extras: one failing is recorded and never undoes the video. A custom thumbnail needs a verified
  channel; when refused, why is recorded.
- **Edit** reads the snippet and changes only the given fields (title, description, tags); **delete**
  treats a gone video as done.
- **Numbers** are read 50 videos per call (`videos.list`), the channel's own numbers from
  `channels.list`, and **comments** are read and answered.
- **Quota**, as Google's quota calculator and the Data API's revision history have it on 2026-10-29:
  every call but an upload is charged to the project's **10,000 units a day** (a read 1, captions
  400, a thumbnail 50, an edit, a delete, a comment and a channel update 50 each). Since **2026-06-01
  `videos.insert` has a bucket of its own: 100 uploads a day**, one unit each; it cost about 1,600 of
  the shared units until 2025-12-04, then about 100, and the code charged 1,600 until 2026-10-29, so
  it refused uploads Google would have taken. Every call reports its units (`onUnits`) and
  `youtubeBucketOf` names its bucket; the adapter's `YouTubeQuota` keeps two per-provider token
  buckets (`youtube`, `youtube-uploads`; in Redis when `redis-state` is on) and refuses an upload when
  the day has no upload left or not the units of its captions and thumbnail.

## Privacy and Google's audit

Shipcast asks for `public` on every upload. The plans of 2026-10-28 took it as certain that Google
locks an unaudited API project's uploads to `private`. It was not what happened (the first two
uploads, the Sluice article's videos on 2026-10-29, came out **public**), and it is no longer Google's
policy: the `videos.insert` reference (2026-10-15) says videos uploaded from unverified API projects
are not restricted to private viewing.

So `private` is a fallback, not an expected outcome. When Google answers an upload as `private`
anyway, the publishing strategy (`packages/engine/src/publishing/youtube.ts`) still records the video
as published, keeps a `youtube-privacy:<postId>` cursor saying "private until Google audits the
project", and notes it in the publishing run's log; it is not a failure. No page reads that cursor
yet. The audit form stays prepared in [plans/youtube-audit.md](../plans/youtube-audit.md) for the
owner to send if that happens, or for a quota extension.

## Analytics

Built on 2026-10-29. The Data API's counters (views, likes, comments) are about a fifth of what
YouTube Studio shows. The **YouTube Analytics API** (`youtubeanalytics.googleapis.com/v2/reports`)
gives the rest per video, with the `yt-analytics.readonly` scope:

- `YouTube.analytics(videos, until)` asks one report per video (`ids=channel==MINE`,
  `filters=video==<id>`, no dimension, from the launch's day to today) for `engagedViews`,
  `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `shares` and
  `subscribersGained`, kept on the video's piece as `engagedViews`, `watchMinutes`,
  `avgViewSeconds`, `avgViewPercent`, `shares` and `subscribersGained`. `shares` joins the stats'
  shares family.
- **Daily.** Google's numbers lag 48 to 72 hours behind the public counters, so the definition's
  `metrics.analytics` cadence is 24 hours; `collectHourly` reads every live video at once on it
  ([publishing.md](../publishing.md#metrics)). The Analytics API has its own quota, not the Data API's
  units.
- **The averages are not counters**: kept per video as read. A launch's sum of them means nothing,
  which the stats model has to know.
- **A connection made before the scope was asked for** keeps working: the report answers 403
  (insufficient scopes) and the connector says so ("YouTube Analytics was not granted to this
  connection… connect YouTube again"), as one problem of the metrics run, once a day; the hourly
  counters are untouched. An Analytics API left off in the Google Cloud project is said the same way.
- **Not built: the Reporting API.** Thumbnail impressions and their CTR exist only in its bulk CSV
  reports (`channel_reach_basic_a1`), which need a reporting job created once, then a daily download
  and a CSV parse of the channel's every video. That is more than a small change; it is the next step
  once the owner wants Studio's impressions.

## The channel's profile

Built on 2026-10-29. The profile was "pasted, not read, not edited", which the API never required:
`channels.list?part=snippet,brandingSettings` reads it and `channels.update?part=brandingSettings`
changes it with the `youtube.force-ssl` scope already granted (50 units).

- **Read**: the name, the description as the bio, and the keywords, country and channel trailer as
  `Label: value` links (`Keywords: …`, `Country: ES`, `Trailer: <video>`), since the API reads no links
  section; whether there is a picture and a banner.
- **Edited**: the description (the review's bio) and the keywords, country and trailer (the review's
  links, by those labels; a setting left out of the links is cleared). YouTube deletes every
  `brandingSettings` property an update leaves out, so `editChannel` reads the whole object and writes
  it back with only the given fields changed (the banner's address included).
- **Not edited**: the name and the picture, which the API cannot change, and the banner, which it can
  (`channelBanners.insert`, then the banner's address in `brandingSettings`) but which needs an image
  to propose that the profile review does not have: next, with a banner in the review.

## Connecting

The OAuth flow at `/auth/youtube` and `/auth/youtube/callback` with the client id and secret in
Settings, like Reddit and LinkedIn; scopes `youtube.upload`, `youtube.readonly`, `youtube.force-ssl`
and, since 2026-10-29, `yt-analytics.readonly` (the YouTube Analytics API has to be on in the project).
An account connected before then is connected again once to read its analytics.
`shipcast youtube import <file>` brings a `client_id`/`client_secret`/`refresh_token` file into the
secret store through the same path the callback uses, printing no value. The owner's consent screen is
left in *Testing* (owner, 2026-10-28), so a refresh token lasts 7 days and an expired one asks to
connect YouTube again; the connection's instructions say to publish it (*In production*) to keep the
account connected.

## Related

[[decisions/architecture.md]] · [[decisions/automatic-channels-only.md]] · [[plans/goal-v0.2.md]] · [[plans/goal-refactor.md]] · [[plans/youtube-audit.md]] · [[content-pack.md]] · [[publishing.md]] · [[status.md]] · [[accounts.md]] · [[stats.md]] · [[decisions/account-analysis.md]]
