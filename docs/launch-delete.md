---
created_at: 2026-10-30T07:55:43.916970887Z
updated_at: 2026-10-30T10:47:08.035298122Z
tags:
    - launches
    - launch-model
    - deletion
    - posts
    - flags
---
# Deleting a launch

Part of the seventh phase of [decisions/launch-model.md](decisions/launch-model.md) (card SHP-15),
built on 2026-10-30 behind the `launch-delete` flag (off by default, and in production until it is
verified). Before it a launch could not be deleted at all: its row is the claim that makes "a launch
happens once" hold, and `posts`, `metrics`, `publish_attempts` and `draft_snapshots` hang on it with
no cascade. The owner decided (2026-10-29) that a launch can be deleted, a published one softly, its
network posts **kept by default** with a per-channel choice to delete them there too, and that the
article may be removed while posts link it, with a warning saying how many. The other half of the
phase is [launch-triggers.md](launch-triggers.md).

## Two kinds of deletion

`LaunchDeletionService.plan` says which before anything happens; `delete` does it.

| The launch | Mode | What happens |
| --- | --- | --- |
| Nothing of it ever reached an audience | `removed` | The launch's row goes with every row that hangs on it: its scheduled pieces, attempts, snapshot, metrics and comments (`removeLaunch`, the import's own), and by cascade the launch model's rows (packs, channels, drafts and versions, media, approvals). Jobs and assistant sessions stay, unlinked. Its drafts pull request is closed and its branch deleted (a legacy launch), or its preview on the real site (a launch Shipcast holds), so nothing left open can still publish it. Its media bytes are deleted from the media store when no other launch names them |
| It published | `hidden` | `launches.deleted_at` is set: the launch leaves the lists (the Launches page, `GET /launches`, the facets, `recent`, which the rounds, the metric reads and the stats' pickers use), nothing more of it goes out (`publishLaunch` skips it, its scheduled pieces are dropped), and its row stays, so its release is never claimed again. Its page still opens by id, saying when it was deleted |

"Published" is decided from what may be out, not from the status alone: a post of any status but
`scheduled` or `failed`, an attempt `live`, `unknown` or `attempting`, a `published` status, or the
article already on the site (a merged drafts pull request, a direct commit, or the site commit of a
launch Shipcast holds). For a launch Shipcast holds the service reads its `app-blog:<id>` cursor
itself, recorded or still pending, whatever the `app-review` flag of the process: before the review
fixes of 2026-10-30 it asked `AppReviewService`, which a process without `app-review` does not have,
and a launch whose article was on the site could have been removed as never published.

A launch whose drafts are being written (`detected`, `generating`) is refused until they are, so a
draft job never finds its launch gone; a hidden launch is refused a second time.

## Races with publishing

The plan is read outside any transaction, so a worker may send or claim a piece between the plan and
the deletion. The deletion therefore runs in one transaction that first locks the launch's row
(`launches.lock`, `SELECT … FOR UPDATE`, 2026-10-30):

- **Removed**: inside the lock the posts and the publish attempts are read again; a piece out, or an
  attempt `live`, `unknown` or `attempting`, refuses the removal ("published meanwhile": delete it
  again to hide it). A claim in flight is a `publish_attempts` insert, whose foreign key takes a
  `FOR KEY SHARE` lock on the launch's row, which conflicts with `FOR UPDATE`: it is either committed
  before the lock and seen, or waits for the deletion and then finds no launch.
- **Hidden**: the waiting pieces are unscheduled, the launch hidden and the deletion recorded in that
  same transaction, `deletedAt` re-checked under the lock, so a failure leaves none of it half done
  and a second deletion meanwhile is refused instead of recorded twice.
- **Publishing** re-reads the launch's `deletedAt` before each channel's send (and in the piece
  guard's `stillNeeded`), so a run that started before the deletion sends nothing more after it.

## The posts, channel by channel

A hidden launch's posts **stay on the networks** unless the owner ticks their channel. The plan lists
each channel with pieces out, how many, and what deleting there does (`CAPABILITIES[channel].delete`:
`yes`, `unpublish` for dev.to, `no` for Instagram and the newsletter, which stay whatever is chosen).
The ticked channels go through `PostService.deleteMany`, the one way a published piece is deleted
([decisions/edit-delete.md](decisions/edit-delete.md)); each piece's outcome is reported, and a
piece a network refuses does not stop the launch from being hidden.

**The article.** Ticking the blog removes the article from the site (`deleteArticle`, a commit to the
launches repo). It is allowed while other posts link it, as the owner decided, rejecting the
research's proposal to refuse it: the dialog warns before ("3 posts link to the article…"), and the
answer says how many posts are left pointing to a page that is gone, counted after the deletions
(`articleLinks`, also kept on the record).

## The record, and no relaunch

Every deletion is a row of `launch_deletions` (migration `0020_launch_deletions`, additive): the
launch's id, repo and ref, its dedupe key (the stored one, or the one its repo and ref imply,
`dedupeKeyOf`), the mode, who (the signed-in login, `api`, or `owner`), when, the channels deleted on
the networks and the article's links. No foreign key: a removed launch's row is gone.

A removed launch's key keeps an event from launching it again: the runtime always hands the claim
`removed` (`launchDeletions.removed`, one lookup on the `launch_deletions_by_key` index), and
`claimEvent` ignores an event whose key was removed ("its launch was deleted"), with or without the
trigger rules. Since 2026-10-30 the check does not depend on the `launch-delete` flag: a process
started without it (a rollback, another replica) must not relaunch what one with it removed. A
hidden launch needs no check: its row still holds the claim. Launching the same release by hand is
still possible.

## Entry points

| Where | What |
| --- | --- |
| The launch page | "Delete launch" in the toolbar (only with the flag), a dialog that reads the plan when it opens: what happens, the channels to tick, the article's warning |
| `GET /api/v1/launches/{id}/deletion` | the plan (`read`) |
| `DELETE /api/v1/launches/{id}?channels=a,b` | the deletion (`write`), the posts of the channels named deleted on their networks; answers `mode`, the `outcomes`, a `warning` and `problems` (what could not be tidied after) |

Without the flag both routes answer 404, are left out of the OpenAPI document (`ApiRoute.available`),
and the page shows no button. One implementation behind them: `LaunchDeletionService`
(`packages/engine/src/services/launch-delete.ts`), built once by `deletionService`
(`apps/web/src/server/deletion.server.ts`). On a preview with fake networks it closes nothing on
GitHub and drops no media bytes.

## Not done

- No restore of a hidden launch, and no purge of a hidden launch's rows (metrics, comments, posts):
  neither was asked for. A hidden launch's past numbers stay in the stats' totals; only the rounds
  stop reading new ones.
- No MCP tool of its own; an MCP client can call the REST routes.
- A deletion's own rows are not kept for undoing, unlike the import's batch log.

## Tests

`packages/engine/test/launch-delete.test.ts`: every launch listed today, a launch never published
removed with its rows and its pull request closed, its media bytes dropped unless shared, the
refusals, a published one hidden with its posts kept, the channels ticked deleted with the article's
warning, a hidden launch publishing nothing more, a merged pull request counting as published, a
launch Shipcast holds whose article was committed hidden even without `app-review`, a piece sent or
claimed between the plan and the removal stopping it, hiding as one transaction, a second deletion
meanwhile refused, and publishing stopping mid-run once the launch is deleted.
`packages/runtime/test/runtime.test.ts`: the removed releases read without the flag.
`apps/web/test/api.test.ts`: the routes off without the flag (and out of the OpenAPI document), the
plan, the scopes and a deletion.

## Related

[[decisions/launch-model.md]] · [[launch-triggers.md]] · [[decisions/edit-delete.md]] · [[app-review.md]] · [[launch-import.md]] · [[media-store.md]] · [[api.md]] · [[engine.md]] · [[server.md]]