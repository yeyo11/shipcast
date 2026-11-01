---
created_at: 2026-10-30T04:52:08.327618725Z
updated_at: 2026-11-01T16:03:58.355257717Z
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
behind the `launch-store-read` flag. Every launch Shipcast holds ([app-review.md](app-review.md)) is
in Postgres, and the import ([launch-import.md](launch-import.md)) brings the ones drafted in pull
requests in. The places that read a launch read those rows: **a view of a launch makes no GitHub
call**. Since 2026-11-01 the flag is retired and this is the only read: the GitHub reads it replaced
(the drafts pull request, its snapshot, launch.yml at the tag, `pack.json` on main) went with the
pull-request path, phase 8 of the decision ([server.md](server.md#the-flags)).

## What reads the rows

One implementation, `LaunchReadService` (`packages/engine/src/services/launch-read.ts`), over the
`LaunchStoreRepository` and the media store ([media-store.md](media-store.md)).

| Reader | Before | Now |
| --- | --- | --- |
| The launch page (`getLaunch` → `launchPage`) | the drafts pull request from GitHub, or its snapshot | `review`: each piece's current version, the launch's files served by the app |
| REST `GET /launches/{id}`, and MCP's `get_launch` through it | `readReview` against GitHub on every request (three calls or more) | the same `review` |
| Scheduling: the page's schedulable channels and `ScheduleService` (the page's actions and `POST /launches/{id}/schedule`) | `launchConfigOf`: launch.yml at the release's tag, or an article's beside its drafts | `channelConfig`: the launch.yml copied when it was drafted, each channel's mode from its row |
| The comment assistant's grounding (`launchReplyContext`) | `pack.json` on the launches repo's main | `pack`: the current pack row |
| The writing assistant's grounding (`launchGrounding`, in the page and in the heavy check job) | the same `pack.json` | the same `pack` |
| Publishing a launch merged from a pull request (a retry, a scheduled piece) | the merged files on the launches repo's main | the pack, the channel rows and each text by its path (`publish.ts`), so the old draft folders can go |

A launch Shipcast holds (`model = 'app'`, the fifth phase) has no pull request to fall back on:
`review` answers it from the rows alone with its own shape (`Review.app` instead of `pullRequest`:
the approval, what waits, each article's preview, [app-review.md](app-review.md)). The channels as
the rows say them are one function, `storedChannelConfig` (`launch-import.ts`), which publishing such
a launch reads too.

The drafts branch name of a launch decided in a pull request is `draftsBranch` (`drafts.ts`), which
the review from the rows names.

## A launch the tables hold

A launch is held when it has a pack in the rows. After the import every launch that was drafted is.
One that is not is never read from GitHub: when nothing was drafted it has no review, as before; when
its drafts went to a pull request (drafted before the shadow write and not imported) its review is
refused with `LaunchNotHeld` (409, `not_held`), whose message names the import to run, and the page
and `GET /launches/{id}` show that error in place of the drafts; its channels and its pack read as
none, so it cannot be scheduled and grounds no reply. A clear error was chosen over a read-only
fallback to GitHub because the fallback would keep the whole pull-request read path alive for
launches that the import is there to bring in.

The review keeps the shape the pull request's read answered (`reviewFromStore`, `review.ts`), so the
page, the REST answer and MCP needed no change:

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
(the bytes are addressed by their sha256). A row it does not have answers 404; a store that fails
answers 502.

## Where it reads differently, on purpose

Compared with the pull request's read it replaced (checked by parity tests until that read was
removed on 2026-11-01), the texts (an edit on main after the merge included), the launch's files and
data, the pull request, the channels and the pack agreed. What differs:

- **the project's cover and `projects.yml`** are not listed: they are the site's (the shadow write
  stores the cover with no launch), while the pull request that first carried them lists them;
- **channels the import turned off** (on, never published) read as off, so they cannot be scheduled;
- **a release's launch.yml changed after the launch was drafted** is not followed: the launch keeps
  the copy it was drafted with;
- **a pack or launch.yml written before a channel was retired** (v0.1.0's `hackerNews` and
  `productHunt`) is read without it: today's strict parse refuses the whole file, so that launch had
  no grounding and no channels to schedule by;
- **the pack grounds replies before the merge** too: `pack.json` was only on main after it.

## Known limits

- An edit made on GitHub to an old launch's files (a commit by hand on the launches repo's main) is
  not read: the rows are what Shipcast shows and publishes.
- A launch decided in a pull request is read-only in the app: neither edited nor approved there.

## Tests

`packages/engine/test/launch-store-read.test.ts` (imported launches read with no GitHub call, the
channels the import turned off, the grounding, a launch the tables do not hold, an article edited
after publishing), `packages/engine/test/publish.test.ts` (an imported launch publishes from its rows
with no draft folder on the launches repo) and `apps/web/test/no-external-calls.test.ts` (the launch
page makes no outbound call; scheduling refuses a channel its row turns off).

## Related

[[decisions/launch-model.md]] · [[launch-store.md]] · [[launch-import.md]] · [[media-store.md]] · [[engine.md]] · [[server.md]] · [[api.md]] · [[mcp.md]] · [[scheduling.md]] · [[decisions/comment-assistant.md]] · [[app-review.md]]
