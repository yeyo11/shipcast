---
created_at: 2026-10-28T17:09:24.256588256Z
updated_at: 2026-10-29T15:41:04.966664385Z
tags:
    - decision
    - youtube
    - channels
    - video
    - connectors
    - phase-3b
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
- **Quota**: 10,000 units a day; an upload costs 1,600, captions 400, a read 1. Every call reports its
  units, and the adapter's `YouTubeQuota` (a per-provider token bucket, in Redis when `redis-state` is
  on) refuses an upload the day cannot pay for in full.

## Privacy and Google's audit

Shipcast asks for `public` on every upload. Google's policy is that it **may** lock an unaudited API
project's uploads to `private`, and the plans of 2026-10-28 took that as certain. It was not what
happened: the first two uploads, the Sluice article's videos on 2026-10-29, came out **public** with
the project unaudited.

So `private` is a fallback, not the expected outcome. When Google answers an upload as `private`
anyway, the publishing strategy (`packages/engine/src/publishing/youtube.ts`) still records the video
as published, keeps a `youtube-privacy:<postId>` cursor saying "private until Google audits the
project", and notes it in the publishing run's log; it is not a failure. No page reads that cursor
yet. The audit form stays prepared in [plans/youtube-audit.md](../plans/youtube-audit.md) for the
owner to send if that happens, or for a quota extension.

## Connecting

The OAuth flow at `/auth/youtube` and `/auth/youtube/callback` with the client id and secret in
Settings, like Reddit and LinkedIn; scopes `youtube.upload`, `youtube.readonly`, `youtube.force-ssl`.
`shipcast youtube import <file>` brings a `client_id`/`client_secret`/`refresh_token` file into the
secret store through the same path the callback uses, printing no value. The owner's consent screen is
left in *Testing* (owner, 2026-10-28), so a refresh token lasts 7 days; an expired one asks to connect
YouTube again.

## Related

[[decisions/architecture.md]] · [[decisions/automatic-channels-only.md]] · [[plans/goal-v0.2.md]] · [[plans/goal-refactor.md]] · [[plans/youtube-audit.md]] · [[content-pack.md]] · [[publishing.md]] · [[status.md]]