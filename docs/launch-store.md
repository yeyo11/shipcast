---
created_at: 2026-10-30T02:00:22.986242054Z
updated_at: 2026-11-01T16:03:01.756362323Z
tags:
    - launches
    - launch-model
    - drafts
    - media
    - flags
    - architecture
---
# The launch store: the launch model's write

The second phase of [decisions/launch-model.md](decisions/launch-model.md), built on 2026-10-30
behind the `launch-store` flag as a **shadow write**: while the drafts pull request in the launches
repo still decided everything, every launch it carried was also written to the launch model's tables
([engine.md](engine.md), migration `0018`) and compared with the pull request. It was the bridge to
the phases after it: the import ([launch-import.md](launch-import.md)), the reads
([launch-store-read.md](launch-store-read.md)) and the launches Shipcast holds
([app-review.md](app-review.md)).

**Since 2026-11-01 the flag is retired and the shadow write is gone** with the pull-request path
(phase 8 of the decision, [server.md](server.md#the-flags)): no launch of the app has a pull request
any more, so there is nothing to write beside or compare with. What stays is the write itself, which
every launch Shipcast holds goes through.

## What is written, and when

One implementation, `LaunchStoreService` (`packages/engine/src/services/launch-store.ts`), over the
`LaunchStoreRepository` (`packages/engine/src/repositories/launch-store.ts`) and the media store
([media-store.md](media-store.md)). The mapping from a file of the drafts to a row is a pure
function, `storedFile` (`packages/engine/src/launch-store.ts`), which the import reuses for the old
pull requests.

| Moment | Hook | Written |
| --- | --- | --- |
| The drafts are delivered | `AppReviewService.hold` through `LaunchStoreService.held` ([app-review.md](app-review.md)) | a `packs` row (the next version, accepted); the `launch_channels` rows from `launch.yml` and the text itself in `launches.channels_source`; one `drafts` row per piece with a `draft_versions` row (origin `ai`); every file under `public/` put in the media store with a `media` row. A file that cannot be stored fails the draft: these rows are all there is of the launch |
| The owner edits a published article (Edit on the launch page, a commit to main) | `editPost` through `EditDeps.launchStore` (`articleEdited`) | a version of the article as committed (origin `post-publish-edit`), and the article's post's `draft_version_id` set to it. An edit that cannot be stored is kept under the cursor `launch-store:<launch id>`, which the attention bell shows |

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

A version is only added when its text differs from the current one, so writing the same text twice
adds nothing.

## What went with the pull-request path

The writes at the pull request's delivery and edits, the read of the pull request (the drafts
snapshot's refresh) and of the merge, and the check that compared the rows with the pull request
(`storeDifferences`) were removed on 2026-11-01. A launch decided in a pull request is read from the
rows the import or the shadow write left ([launch-store-read.md](launch-store-read.md)), and a merged
one publishes from them too ([publishing.md](publishing.md)). Action mode keeps its own pull-request
flow and writes no rows ([decisions/action-mode.md](decisions/action-mode.md)).

## Related

[[decisions/launch-model.md]] · [[engine.md]] · [[media-store.md]] · [[launches-repo.md]] · [[publishing.md]] · [[server.md]] · [[launch-import.md]] · [[launch-store-read.md]]
