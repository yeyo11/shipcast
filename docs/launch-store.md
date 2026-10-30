---
created_at: 2026-10-30T02:00:22.986242054Z
updated_at: 2026-10-30T05:06:41.206689672Z
tags:
    - launches
    - launch-model
    - drafts
    - media
    - flags
    - architecture
---
# The launch store: the shadow write

The second phase of [decisions/launch-model.md](decisions/launch-model.md), built on 2026-10-30
behind the `launch-store` flag (off by default, and in production until it is verified). While the
drafts pull request in the launches repo still decides everything, every launch it carries is also
written to the launch model's tables ([engine.md](engine.md), migration `0018`) and compared with
the pull request. Until the fourth phase's `launch-store-read` flag is on
([launch-store-read.md](launch-store-read.md)), **nothing reads those rows**: the launch page,
publishing, the API and MCP read GitHub as before. With it, the launch page, the API, scheduling
and the assistants read them; publishing still reads the merged pull request. The phase is done
when, for a real launch, the copy in Postgres agrees with its pull request; the import of the
existing launches is the third phase ([launch-import.md](launch-import.md)).

## What is written, and when

One implementation, `LaunchStoreService` (`packages/engine/src/services/launch-store.ts`), over the
`LaunchStoreRepository` (`packages/engine/src/repositories/launch-store.ts`) and the media store
([media-store.md](media-store.md)). The mapping from a file of the pull request to a row is a pure
function, `storedFile` (`packages/engine/src/launch-store.ts`), which the import can reuse.

| Moment | Hook | Written |
| --- | --- | --- |
| The drafts are delivered (pull request opened, or committed straight onto main) | `deliverDrafts` (`pipeline.ts`) through `PipelineDeps.launchStore` | a `packs` row (the next version, accepted); the `launch_channels` rows from `launch.yml` and the text itself in `launches.channels_source`; one `drafts` row per piece with its first `draft_versions` row (origin `ai`); every file under `public/` put in the media store with a `media` row. Drafts committed straight onto main are also an `approvals` row (by `shipcast`) |
| The owner edits a draft in Shipcast | `LaunchService.editDraft`, which the launch page's save now calls | a version of the owner's (origin `owner`) |
| The pull request is read (the drafts snapshot's refresh: a delivery, the hourly poll, "Refresh from GitHub", an approval in the app) | `DraftSnapshotService.refresh` | each draft whose text changed on GitHub becomes a version of the owner's; a merged pull request becomes the `approvals` row, by the merger's login at `merged_at`, naming the version of each draft merged, and `launches.approved_at` |
| Publishing finds the drafts approved | `publishLaunch` through `PublishDeps.launchStore` | the same read of the merged pull request, once, when no approval is recorded: the approval is written whether `github-events` is on or not |
| The owner edits a published article (Edit on the launch page, a commit to main) | `editPost` through `EditDeps.launchStore` | a version of the article as committed (origin `post-publish-edit`) |

The mapping:

- `src/content/posts/<lang>/<slug>.md` is the draft `(blog, article:<lang>)`;
- a channel's draft file `<dir>/<file>.md` is `(<channel>, <part>)` by the channel's own draft names
  (`draftOf`), `post` when the channel has one draft; `release-notes.md` is `(releaseNotes, notes)`;
- a version's body is **the file as it is in the pull request** (front matter, heading and mode line
  included), and `fields.path` its path, so a later reader renders exactly what the pull request
  shows and `draftBody` and the channels' parsers read it as they read the file;
- `pack.json` is the pack, compared as a value (jsonb keeps no key order);
- an article's `launch.yml` is the channel rows; a release's comes from the project's repo at the tag;
- a file under `public/` is media: role `og`, `screenshot`, `carousel`, `story`, `demo`, `cover` or
  `other`, its `public_path` the address the pull request puts it at. A project's cover
  (`public/covers/…`) belongs to no launch (`launch_id` null);
- `projects.yml` is the site's, not the launch's: left to the pull request.

A version is only added when its text differs from the current one, so reading the same pull
request twice, or the snapshot catching up with an edit Shipcast made, adds nothing.

## The check

After a delivery and after every read of the pull request, `storeDifferences` compares the rows
with the pull request's files: a draft, the pack, the channels or a file the rows lack, a text whose
current version is not the file's, a draft in the rows the pull request no longer has, and a
release's `launch.yml` changed since it was copied. Files GitHub lists without their text (the
pack, media) are checked for presence; at delivery, where the bytes are at hand, media are also
checked by sha256.

What it finds is kept under the cursor `launch-store:<launch id>` (`{ at, differences }`), replaced
by each full check and removed when the copy agrees; an edit that could not be stored is added to
it. The attention bell shows it as one line per launch ("Shipcast's copy differs from the pull
request (…)"), dismissable like the others, and new again when something else differs.

## Never in the way

The shadow write cannot stop today's flow: no method of the service throws, and the hooks also catch.
A failure (the database refusing, the media store unavailable) is reported as a difference. With
`launch-store` on and `launch-media` off, the texts are written and every file is reported as "not
stored: the media store is not available", so **turn `launch-media` on with it** once the bucket is
in `.env`.

With the flag off nothing is built: nothing is written, the edit and the merge behave as before
(the characterisation tests in `packages/engine/test/launch-store.test.ts`), and the bell reads one
more cursor prefix, which is empty.

## Known limits

- A launch drafted before the flag was turned on has no pack in the rows and is left alone by the
  reads and the merge: bringing it in is the import's job (phase 3).
- A re-run whose pull request was open already (the pipeline finds it rather than opening another)
  stores the newly generated drafts; the pull request keeps what was pushed before, and the check
  reports the difference until the next read records the pull request's text as the owner's.
- A file GitHub leaves out of a pull request because it is identical on main (an article drafted
  again unchanged) is reported as "in the database, not in the pull request".
- Two files of one launch with the same bytes are one `media` row (the table is unique on launch and
  sha256): the second path is reported as missing.
- The author of an edit made in Shipcast is not recorded yet (`author` null, origin `owner`).

## Related

[[decisions/launch-model.md]] · [[engine.md]] · [[media-store.md]] · [[launches-repo.md]] · [[publishing.md]] · [[server.md]] · [[launch-import.md]] · [[launch-store-read.md]]
