---
created_at: 2026-10-30T04:52:08.327618725Z
updated_at: 2026-10-30T06:23:11.676791488Z
tags:
    - launches
    - launch-model
    - drafts
    - media
    - flags
    - architecture
---
# Reading launches from the launch model

The fourth phase of [decisions/launch-model.md](decisions/launch-model.md), built on 2026-10-30
behind the `launch-store-read` flag (off by default, and in production until it is verified). The
shadow write ([launch-store.md](launch-store.md)) keeps every new launch's pack, channels, drafts,
media and approval in Postgres, and the import ([launch-import.md](launch-import.md)) brings the
existing ones in. With the flag on, the places that read a launch from GitHub read those rows
instead: **a view of a launch the tables hold makes no GitHub call**. Writing still goes through
the drafts pull request (an edit is a commit on its branch, approving merges it, publishing reads
the merged files); the app taking over review, approval and publishing is the next phase,
[app-review.md](app-review.md), which reads its launches through the same service.

## What reads the rows

One implementation, `LaunchReadService` (`packages/engine/src/services/launch-read.ts`), over the
`LaunchStoreRepository` and the media store ([media-store.md](media-store.md)). Each of its reads is
handed the way the caller reads today, which it uses for a launch the tables do not hold.

| Reader | Today | With `launch-store-read` |
| --- | --- | --- |
| The launch page (`getLaunch` → `launchPage`) | the drafts pull request from GitHub, or its snapshot with `github-events` | `review`: each piece's current version, the launch's files served by the app |
| REST `GET /launches/{id}`, and MCP's `get_launch` through it | `readReview` against GitHub on every request (three calls or more) | the same `review` |
| Scheduling: the page's schedulable channels and `ScheduleService` (the page's actions and `POST /launches/{id}/schedule`) | `launchConfigOf`: launch.yml at the release's tag, or an article's beside its drafts | `channelConfig`: the launch.yml copied when it was drafted, each channel's mode from its row |
| The comment assistant's grounding (`launchReplyContext`) | `pack.json` on the launches repo's main | `pack`: the current pack row |
| The writing assistant's grounding (`launchGrounding`, in the page and in the heavy check job) | the same `pack.json` | the same `pack` |

A launch Shipcast holds (`model = 'app'`, the fifth phase) has no pull request to fall back on:
`review` answers it from the rows alone with its own shape (`Review.app` instead of `pullRequest`:
the approval, what waits, each article's preview, [app-review.md](app-review.md)). The channels as
the rows say them are one function, `storedChannelConfig` (`launch-import.ts`), which publishing such
a launch reads too.

The legacy reads of the pack were two copies of one parse; they are one function now,
`packOnLaunchesRepo` (`drafts.ts`). The drafts branch name, which the pipeline and the article flow
each built, is `draftsBranch` (`drafts.ts`), which the review from the rows names too.

## A launch the tables hold

A launch is held when it has a pack in the rows, as the shadow write decides. One that has none
(drafted before `launch-store` was on and not imported, or whose delivery the shadow write could not
store) is read exactly as before, from GitHub or the snapshot.

The review keeps the shape `readReview` answers (`reviewFromStore`, `review.ts`), so the page, the
REST answer and MCP need no change:

- every draft at its current version, under the path its version came from (`fields.path`): the
  file as the pull request had it, front matter and mode line included;
- the launch's own files (`media` rows of the launch), each with its address on the site, and
  `url` the app's `/media/<id>`; `pack.json`, and an article's `launch.yml`, listed as data as the
  pull request lists them;
- the pull request's number and address from `launches.detail`, its branch from `draftsBranch`,
  and its state from what Shipcast knows: **merged** once an approval row is in force or the launch
  is published, **closed** once publishing found it closed (`skipped`, "closed without merging"),
  **open** otherwise; a launch with no pull request (`direct:`) has no review, as on GitHub.

The channels are launch.yml as copied at the delivery (`launches.channels_source`) with the
`publishing` modes of the channel rows (`channelsAsLaunchYml`), read as the import reads a launch.yml
(`readLaunchYml`, which leaves out a retired channel). The pack is the newest accepted one, read
without the keys of retired channels (`readPack`).

An article edited after it was published (Edit on the launch page, a commit to the launches repo's
main) is also a `post-publish-edit` version with `launch-store` on (`EditDeps.launchStore`, the
shadow write's `articleEdited`), and its post's `draft_version_id` names that version, so the page
shows the article as the site does.

## The files, served by the app

`GET /media/<id>` (`apps/web/src/routes/media.$mediaId.ts`) answers a `media` row's bytes from the
media store, behind the session like every page, so a draft's image is never public before it is
published, and the launches repo may be private. It is served as stored, never run:
`x-content-type-options: nosniff`, a `sandbox` content security policy, and a long private cache
(the bytes are addressed by their sha256). Without the flag it answers 404; a store that fails
answers 502.

## Where it reads differently, on purpose

The parity tests (`packages/engine/test/launch-store-read.test.ts`) import a release and an article
from a fake launches repo and compare each read with today's on the same repo: the texts (an edit
on main after the merge included), the launch's files and data, the pull request, the channels and
the pack agree. What differs:

- **the project's cover and `projects.yml`** are not listed: they are the site's (the shadow write
  stores the cover with no launch), while the pull request that first carried them lists them;
- **channels the import turned off** (on, never published) read as off, so they cannot be scheduled;
- **a release's launch.yml changed after the launch was drafted** is not followed: the launch keeps
  the copy it was drafted with (the shadow write's check reports the change);
- **a pack or launch.yml written before a channel was retired** (v0.1.0's `hackerNews` and
  `productHunt`) is read without it: today's strict parse refuses the whole file, so that launch had
  no grounding and no channels to schedule by;
- **the pack grounds replies before the merge** too: today `pack.json` is only on main after it.

## Known limits

- **An edit made on GitHub reaches the rows only when the pull request is read**: with `github-events`
  the delivery of the push (or the hourly poll, or "Refresh from GitHub"); without it, at the merge,
  when publishing reads the merged pull request once. Until then the page shows the text before it.
  Run the flag with `github-events` on. A commit made by hand on the launches repo's main after the
  merge is not read at all.
- **A merge on GitHub shows as open** until it is recorded the same way (an approval in the app is
  recorded at once with `github-events`; publishing records it in any case).
- Writes are unchanged: saving a draft commits to the pull request (and adds a version through the
  shadow write), approving merges it, publishing reads the merged files.

## Turning it on

`launch-store-read` needs `launch-store`, which keeps the rows up to date: a process that has the
first without the second refuses to start (`ConfigError`). The files need `launch-media`; without it
the review lists none and `/media/<id>` cannot answer. The order in production: `launch-store` and
`launch-media` on, the import applied and verified, then `launch-store-read`. Turning it off returns
every reader to GitHub with no other change.

The tests: `packages/engine/test/launch-store-read.test.ts` (parity on imported launches, a launch
the shadow write stores, an article edited after publishing, the fallback) and
`apps/web/test/no-external-calls.test.ts` (the launch page with no snapshot makes no outbound call;
scheduling refuses a channel its row turns off).

## Related

[[decisions/launch-model.md]] · [[launch-store.md]] · [[launch-import.md]] · [[media-store.md]] · [[engine.md]] · [[server.md]] · [[api.md]] · [[mcp.md]] · [[scheduling.md]] · [[decisions/comment-assistant.md]] · [[app-review.md]]
