---
created_at: 2026-10-30T03:59:25.123165739Z
updated_at: 2026-10-30T03:59:25.123165739Z
tags:
    - launches
    - launch-model
    - import
    - migration
    - flags
    - operations
---
# The import of the existing launches

The third phase of [decisions/launch-model.md](decisions/launch-model.md), built on 2026-10-30
behind the `launch-import` flag (off by default, and in production). The launches drafted before
Shipcast held them (before the shadow write of [launch-store.md](launch-store.md)) live in the
launches repo: their pack, every draft, the media, the merge. The import copies each of them into
the launch model's tables, and deletes the launches the owner decided away (2 and 4, the skipped
test articles, and 7, the failed v0.2.0). **Nothing reads the imported rows yet**: the launch page,
publishing, the API and MCP still read GitHub; reading the database is the next phase.

## How it runs

One implementation, `LaunchImportService` (`packages/engine/src/services/launch-import.ts`), over
`LaunchImportRepository` (`repositories/launch-imports.ts`), the launch store's repository and the
media store; the pure mapping is `packages/engine/src/launch-import.ts`. The entry point is a thin
script:

```bash
node scripts/import-launches.ts [--delete 2,4,7] [--at <sha>] [--inputs jobs.jsonl]   # the plan, written nowhere
node scripts/import-launches.ts --apply [same options]                               # writes it, then verifies
node scripts/import-launches.ts --verify <batch>
node scripts/import-launches.ts --rollback <batch>
```

- It reads Postgres at `SHIPCAST_DATABASE_URL` and the launches repo through GitHub's API with
  `GITHUB_TOKEN`: **GETs only** (`commitSha`, `tree`, `blob`, `pullRequest`, `pullRequestFiles`,
  `fileAt` of `GitHubRest`), any token that may read the repos. The launches repo's `main` is
  pinned to one commit for the whole run (`--at`, or its head when the run starts).
- **Dry run by default**: it prints, per launch, what it would write. `--apply` needs
  `launch-import` in `SHIPCAST_FLAGS`, and the media store (`launch-media` with `SHIPCAST_MEDIA_*`,
  [media-store.md](media-store.md)) when a launch has files; without either it refuses before
  writing anything. `--rollback` needs the flag too.
- `--delete` defaults to the decision's 2, 4 and 7. A launch is never deleted while a piece of it is
  not `deleted` on its network, nor when it is published, nor when the launch model holds rows of it.
- `--inputs` adds the owner's article inputs captured outside the database (a BullMQ job per line,
  `{ data: { launchId, input } }`, or pg-boss's `{ launchId, input }`). pg-boss's own jobs are read
  from the database. pg-boss deletes a completed job a week after it ran and BullMQ drops it after a
  week too, so a capture taken in time is the only record of an article's input after that.

Each launch is written in one transaction; its files are put in the media store first (addressed
by content, so a retry stores nothing twice). After `--apply` the batch is verified at once.

## What a launch becomes

Every launch the launch model does not hold yet (no row in its tables) is imported:

| Row | From |
| --- | --- |
| `launches.title` | an article's title as on the blog, in the owner's language; a release's `<project name> <tag>` |
| `launches.dedupe_key` | `github-release:<repo>@<tag>`, `github-public:<repo>` or `article:<slug>` (`dedupeKeyOf`) |
| `launches.model` | left `legacy`: the pull request still decides, as for a launch the shadow write stores. Turning launches to `app` is the phase that gives `app` a meaning |
| `launch_sources` | a release: `repo_release` with the tag's commit; an article: `text`, the owner's input from its job, or the article as published when the job is gone |
| `packs` | the pull request's `pack.json`, then main's when it changed after the merge (the newest is current) |
| `drafts`, `draft_versions` | every draft file and article, mapped by the shadow write's `storedFile`: the pull request's text as version 1, main's as version 2 where it changed after the merge (origin `import`; `fields` keeps the path, the git blob sha and the commit) |
| `launch_channels` | the launch's `launch.yml` (a release's at the tag, an article's beside its drafts), with **every channel that never published turned off** (note `not published before the import`), so no old draft goes out on a re-run or a retry. A channel or mode today's schema does not know (v0.1.0's `hackerNews: manual`) is left out and named |
| `media` | every file under `public/<launch dir>/` on main, in the media store, with its `public_path`; a project's cover only where its pull request carried it |
| `approvals` | the merge: the merger's login at `merged_at`, naming the pull request's version of each draft (what was merged, not a later edit on main) |
| `posts.draft_version_id` | each published piece's current draft version (`draftOfPiece`) |

What the pull request had and main no longer has (v0.1.0's `show-hn.md` and `product-hunt.md`) is
not imported and is named in the batch's notes.

Every row carries the batch in `import_batch` (migration `0019`), and the batch log
`launch_imports` keeps one row per launch: for an import, the launch's columns as they were and
what it read (the commit, the counts of its posts, comments, metrics, metric days and attempts);
for a deletion, every row it removed, by table, with the jobs and assistant sessions that named it.

A second run finds every launch imported or deleted and writes nothing.

## The verification

`--verify <batch>` (and the end of `--apply`) checks, per launch:

- every draft's current version is the file at the commit it names, by git blob hash;
- every file is in the media store with the bytes its row says, and those bytes are main's;
- no channel is on without a published piece, and no drafted channel without one is on;
- a merged launch has its approval row;
- the posts, comments, metrics, metric days and publish attempts are as many as before;
- **today's publishing, run dry on the rows as imported**, sends nothing: `publishLaunch` in a
  transaction that is always undone, with the pack, drafts and channel rows from the database, the
  article live, every failure and cancellation cursor forgotten (so a later retry is covered), and
  the runtime's `dryPublishing()`, every channel's publisher over a connector that records and
  refuses any call. A pack written before a channel was retired is read without it, as today's
  publishing refuses such a pack whole;
- the deleted launches are gone.

## The rollback

`--rollback <batch>` removes every row the batch wrote, puts the launches' columns back, unlinks the
posts it linked, and restores each deleted launch with all its rows (ids included) and its jobs and
assistant sessions linked again. It is refused while a launch of the batch has a row in the launch
model's tables the batch did not write (an edit since): a rollback would lose it. The files stay in
the media store, addressed by content. The worst case is the `pg_dump` taken before.

## On a restored copy of production

Run on 2026-10-30 on the dump taken before the launch-model decision, restored into a throwaway
Postgres 17 with the migrations applied, against an S3-compatible store of its own (never R2), the
launches repo read at `6f7f550`:

| Launch | Result |
| --- | --- |
| 1, claudio v0.9.0 | imported: 12 drafts (Instagram's changed on main after the merge: 2 versions), 2 packs, 10 files, GitHub Discussions turned off, 10/10 posts linked |
| 2, 4 | deleted (skipped test articles; launch 2's three deleted posts and nine metrics kept in the batch log) |
| 3, shipcast v0.1.0 | imported: 8 drafts, 10 files with the shipcast cover, `hackerNews` and `productHunt` left out of the channels, GitHub Discussions turned off |
| 6, the REA article | imported: 13 drafts (LinkedIn's changed on main), 15 files, the owner's input from pg-boss (14,046 characters); its approval is by the GitHub App's bot, which merged it from the app |
| 7, shipcast v0.2.0 | deleted (failed, nothing drafted): the release is free to launch again |
| 8, the Sluice article | imported: 14 drafts, 12 files, the owner's input from a BullMQ capture (17,117 characters), its title as renamed after the merge |

Every check passed. Turning Reddit on for launch 1 by hand made the check fail as it should (four
subreddit posts would go out). The rollback left every table identical to a second copy of the
same dump with only the migrations applied (row fingerprints of launches, posts, comments,
metrics, metric days, attempts, snapshots, jobs, assistant sessions and cursors); applying again
passed again, and a further run wrote nothing.

## In production

Not run there yet; the lead runs it after the deploy. A `pg_dump` first; then the dry run, then
`--apply` with `launch-import` and `launch-media` on and the media store configured, then turn
`launch-import` off. Capture BullMQ's article jobs before (launch 8's input), and run it before
pg-boss drops launch 6's job, a week after it completed.

## Related

[[decisions/launch-model.md]] · [[launch-store.md]] · [[media-store.md]] · [[engine.md]] · [[launches-repo.md]] · [[publishing.md]] · [[server.md]]
