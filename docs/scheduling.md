---
created_at: 2026-10-25T19:33:10.17202672Z
updated_at: 2026-10-25T19:33:10.17202672Z
tags:
    - scheduling
    - publishing
    - recommendation
    - job-queue
    - api
    - instagram
    - phase-10
---
# Scheduling: a time per post, chosen or recommended

Built on 2026-10-25 (milestone 6 of the [goal](plans/goal-after-mvp.md), phase 10 of
[plans/after-mvp.md](plans/after-mvp.md)): the backend of scheduled publishing. A channel's piece of
a launch can wait for a time instead of going out the moment the launch is published, and Shipcast
recommends the times. The interface (a date and time picker, a calendar) comes with the Base UI work;
today scheduling is reached through the REST API ([api.md](api.md)).

## The model

The time lives on the piece's own row, as [decisions/post-model.md](decisions/post-model.md) planned:
a `posts` row of kind `post`, status `scheduled`, `scheduled_at` in UTC, no external id or URL, and no
account yet. No migration: the columns were there since `0001_post_model`.

- **`scheduleLaunch(registry, launchId, { channel: Date })`** (`packages/engine/src/schedule.ts`)
  writes one scheduled row per channel; a channel scheduled again has its row moved. It refuses, before
  writing anything, a channel the engine does not publish (the blog goes out with the merge, Reddit and
  Hacker News are always drafts), a channel `manual` or `off` in the launch's `launch.yml` (when it can
  be read), a channel with anything out already, a time more than 60 days ahead, and a launch that is
  `published`, `skipped` or `failed`. A time already past means "as soon as it can".
- **`registry.schedulePost`** runs under an advisory lock per launch and channel and refuses when any
  non-scheduled piece of that channel exists, so a launch still happens once.
- **Going out**: `recordPost` first looks for a scheduled row of the same launch, channel and kind
  and turns it into the published one (status `live`, the account it went out with, external id, URL,
  `published_at` now), keeping `scheduled_at`, so the row remembers the slot it was planned for and no
  second row appears whatever account publishes it.
- **Moving** (`reschedulePost`) changes `scheduled_at` while the row is still `scheduled`.
- **Cancelling** (`cancelScheduledPost`) deletes the scheduled row and sets the cursor
  `publish-cancelled:<launch>:<channel>`: that channel is then **not published at all** for that
  launch, as a permanent failure is not. Scheduling the channel again forgets the cancel. To send a
  scheduled piece now instead, move it to now.
- A scheduled piece is not on any network yet, so it cannot be edited or deleted there: `editPost`
  and `deletePost` refuse it (409 in the API), and the whole-launch edits and deletes skip it.

## Publishing what is due

`publishLaunch` ([publishing.md](publishing.md#publishing-after-the-merge)) takes a clock
(`deps.now`, the tests move it). For each channel whose mode lets it be published:

- a scheduled row whose time is **still to come** is reported in `scheduled` and left alone: neither
  done nor pending, so it never holds the other channels back;
- a scheduled row whose time **has come or passed** is published like any channel;
- a cancelled channel is skipped like a permanently failed one.

The launch stays `drafted` (reported as `partial`) while any channel waits for its time, and becomes
`published` once nothing is pending and nothing waits. When a channel finishes, or fails for good,
whatever is left scheduled of it goes (the newsletter's row, whose issues are rows of their own).
Approval still comes first: nothing goes out while the drafts pull request is open, scheduled or not;
a piece whose time passed before the merge goes out with the merge's publishing.

## The due job, and the missed slot

Two things wake the publishing, so a time is kept even if one of them is lost:

1. **A `scheduled` job per piece** (pg-boss, `packages/runtime/src/work.ts`), sent with `startAfter` at
   the piece's time and the key `post:<id>` on a `stately` queue: arming a piece again (`armScheduled`,
   called by the API after scheduling or moving) moves the queued job instead of adding one. pg-boss
   keeps a queued job until two weeks past its start, in Postgres, so it survives restarts; after a
   restart an overdue job simply runs. Its handler re-reads the row, which is the truth: a piece no
   longer scheduled (cancelled, already out) does nothing, one moved later re-arms itself, a launch
   not `drafted` or whose drafts pull request is still open waits; otherwise it queues the launch's
   regular `publish` job, whose per-launch key keeps two publishes of one launch from running at once.
   At every start the worker arms every scheduled piece again (idempotent), so one whose job went
   missing gets one.
2. **The round**: every automation round publishes every `drafted` launch, so an overdue piece goes out
   on the next round even with no job at all. A slot missed while the machine was off is therefore sent
   when it is back, not dropped.

Why a job per piece and not a sweep only: a round runs every few minutes to an hour, which is the
precision a sweep alone would give; the job keeps the time to the poll interval, the round is the
safety net. Neither publishes twice: the post row's uniqueness and the promotion of the scheduled row
make a second run find the channel done.

## Recommended times

`recommendTimes({ channel, tz, now, history?, audience? })` (`packages/engine/src/recommend.ts`) is a
pure function; `recommendFor(registry, channel)` gathers its inputs. It returns, for the next 7 days
(`days`), up to 5 slots (`count`), **one per local day**, best first, each with its UTC moment, the
local time (`Tue 2026-10-27 17:00`), a score and the reason.

### The owner's time zone

The setting `timezone` (an IANA name, `Europe/Madrid` until set; offsets like `+01:00` are refused,
since they have no summer time). The defaults are local hours in it, and every candidate is a whole
local hour, found by stepping through UTC by quarter hours and keeping those on a local hour: right
across summer time (a skipped hour has no candidate, a repeated one gives two instants on one day,
of which one is kept) and in zones a half or three quarters of an hour off UTC.

### Score

Every candidate is scored as the expected multiple of the channel's median post:

- **The default's guess** is `0.5 + w`, where `w` (0 to 1) is how good that hour of the week is by the
  channel's defaults (below), so 0.5 at the worst hours and 1.5 at the best. On Instagram, when the
  account's online-follower hours are known, `w` is the average of the default and the share of
  followers online at that moment (against the peak hour).
- **The owner's history**: every post of the channel that went out (live or edited) with its newest
  numbers, at least 48 hours old (younger numbers are still growing), and only once there are 3 or more.
  Each post's ratio to the channel's median is its engagement: interactions on Bluesky (likes, reposts,
  replies, quotes), Mastodon (favourites, boosts, replies) and Instagram (likes, comments, saves,
  shares); views on dev.to and Hashnode; the open rate on the newsletter (the list grows, so a count
  would favour the newest issues). Telegram and Discord read no numbers and keep their defaults. Each
  post counts toward a candidate by how near it is: fully at the same weekday and hour, half at an hour
  off, and 0.3 of that at the same hour on another day of the same kind (weekday or weekend).
- **Blend**: the default counts as 3 posts (`PRIOR_WEIGHT`), and the two are averaged in log space:
  `score = exp((3·ln(prior) + Σ kᵢ·ln(ratioᵢ)) / (3 + Σ kᵢ))`. A handful of posts barely moves a
  default; with as many posts near an hour as the prior's weight the two weigh the same; a history takes
  over. The log keeps one post at 5x from swamping the rest.

The **reason** says what decided the slot: `history` once the posts near it weigh at least as much as
the default ("your 8 posts at Sat 08:00 did 10.0x your median on Bluesky"), `blend` when a few posts
moved it, `audience` when Instagram's online followers lifted it above its default ("627% more of
your Instagram followers are online at 21:00 than on average"), otherwise `default` with the
default's own words. Within a default window every hour scores the same, and the sooner wins a tie.

### The defaults and their assumptions

Local hours, for an owner in Europe writing for developers in Europe and the Americas. They follow
the published studies of when posts do best where those exist (Sprout Social's and Hootsuite's yearly
"best times to post" from their customers' posts, Buffer's analysis of millions of posts; for email,
the send-time studies of Mailchimp, Brevo and GetResponse) and the audience's geography where they do
not: no study measures Bluesky, Mastodon, dev.to or Hashnode for a developer audience. They are
starting points, not measurements, which is why the history replaces them.

| Channel | Best (1.0) | Also good | Assumption |
| --- | --- | --- | --- |
| Bluesky | weekdays 15–19 | Tue–Thu 9–12 (0.7), weekday mornings (0.5), weekends 10–13 (0.3) | Its developers are mostly American: Europe's afternoon meets the US east coast's morning |
| Mastodon | Tue–Thu 9–12 | weekday mornings (0.8), 13–15 and 18–21 (0.6), weekends 10–13 (0.35) | Most of the fediverse's developers are in Europe |
| Instagram | weekdays 18–21 | weekday lunch 12–14 (0.8), weekends 10–13 and 19–21 (0.6) | The general studies' evening and lunchtime peaks |
| dev.to, Hashnode | Tue–Thu 8–11 | weekday mornings (0.7), Mon–Thu 15–17 (0.6), weekends (0.2) | Read with the first coffee in Europe, in the US feed by its morning |
| Newsletter | Tue and Thu 9–11 | Wed 9–11 (0.8), weekday mornings (0.6), Tue–Thu 17–19 (0.5) | Where the email send-time studies agree |
| Telegram, Discord | weekdays 17–20 | weekdays 10–13 (0.8), weekends 11–13 (0.4) | After work, and late mornings |

Every other hour is 0.15 on a weekday and 0.08 at a weekend from 07:00 to 23:00, and 0 at night.

### Instagram's audience hours

The connector's `audienceHours()` reads the account's `online_followers` insight
(`GET /{ig-user}/insights?metric=online_followers&period=lifetime`, under
`instagram_business_manage_insights`, which Shipcast already asks for) and sums the followers online
per hour over the days Meta returns (it keeps 30). The daily account sync reads it for each Instagram
account with at least 100 followers (Meta gives nothing below that) and keeps it in the cursor
`instagram-audience:<account>` with the time it was read; the recommendation uses the primary
account's first. Assumptions: the metric is listed in Meta's limitations for the Instagram API with
Instagram Login but not in its metrics table, and the hours are taken to be in Pacific time, as the
Graph API's insights days are; neither could be checked against the owner's account, which had under
100 followers on 2026-10-25. A read that fails or returns nothing never fails the sync, and the
recommendation falls back to the defaults.

## API

`POST /launches/{id}/schedule`, `PATCH` and `DELETE /posts/{id}/schedule` (`write`),
`GET /recommendations?channel=&days=&count=` and `GET /settings/timezone` (`read`),
`PATCH /settings/timezone` (`write`); described in [api.md](api.md). Times are ISO 8601 with their
offset; one without would be read in the server's zone.

## Checked

On PGlite with a clock the tests move (`packages/engine/test/publish.test.ts`,
`packages/engine/test/recommend.test.ts`, `packages/runtime/test/queue.test.ts`,
`apps/web/test/api.test.ts`): a scheduled channel waits and never holds the others back, goes out once
at its time in its own row, and never again; overdue pieces after three days off go out on the next
run; moving, cancelling and scheduling again; the refusals (out already, Reddit, manual, too far, a
done launch) and the uniqueness of the row; the newsletter's row; the due job runs after a restart,
does nothing for a cancelled piece, waits for approval while the pull request is open, and arming twice
leaves one job; the API's routes and scopes; the recommendation's defaults, the blend (a few posts
barely move it, a history takes over with its reason), young posts left out, Instagram's audience in
Pacific time, the end of summer time, a zone half an hour off UTC, and the time zone's validation.

On 2026-10-25 the recommendation ran against a copy of the live registry in a throwaway Postgres,
without the app and without publishing anything. Every channel had two or three posts, all from the
last two days, and the Instagram account had under 100 followers, so all four channels gave their
defaults: Bluesky weekdays at 15:00, Mastodon Tue–Thu at 09:00, Instagram weekdays at 18:00, dev.to
Tue–Thu at 08:00, Madrid time. Three days later Bluesky's three posts would count, but they went out
at night, far from any recommended hour, so the defaults still lead.

## Related

[[publishing.md]] · [[api.md]] · [[engine.md]] · [[decisions/post-model.md]] · [[decisions/job-queue.md]] · [[decisions/edit-delete.md]] · [[accounts.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]]
