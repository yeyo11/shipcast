---
created_at: 2026-10-29T22:52:52.911566745Z
updated_at: 2026-11-02T07:25:54.09442851Z
tags:
    - decision
    - launches
    - architecture
    - github
    - blog
    - media
    - backups
---
# Launches owned by Shipcast, not GitHub

Decided on 2026-10-29 by the owner, after a prior investigation of the implications (kept outside the
repo). Built from 2026-10-30, each phase behind a flag; on 2026-11-01 every flag was retired and the
eighth phase, the cleanup, was done in the code (below, [Where it stands](#where-it-stands)).

## Why

A launch today is a repo and a tag. Its channels come from the repo's `.github/launch.yml` at that
tag, its drafts are a pull request in the launches repo, review means editing files in that pull
request, approval is the merge, and publishing reads the merged files back. Shipcast has outgrown
that: a launch can only be about a repo, a channel cannot be chosen per launch (v0.2.0's YouTube
videos could not be published alone), and GitHub holds everything between "drafted" and
"published". From now on **Shipcast is the source of truth of a launch**, and GitHub is one source
and one destination among others.

## Decisions

| Topic | Decision |
| --- | --- |
| What a launch is about | Anything: a repo release, several repos, a product with no repo, a website, a talk, a video, an opinion article. A launch has typed **sources** |
| Several repos | A release of the **primary** repo triggers the launch; stars and repo numbers are shown **per repo** |
| The blog | Stays the Astro site in the launches repo. Shipcast commits the final article (and its media) **only when publishing**; GitHub becomes a destination like dev.to |
| Review and approval | In the app, with an article preview in the app every day and a preview on the real site (a `*.workers.dev` deploy, public but unguessable) on demand |
| `auto` channels | Publish without approval as soon as their draft is ready, as `auto` means today |
| Triggers | Configurable (for example, a GitHub release creating a launch); `launch.yml` becomes optional input |
| Deleting a launch | Possible. A published launch is soft-deleted in Shipcast and its network posts are **kept by default**; the owner can tick, channel by channel, which posts to delete on the network too |
| Removing the article while posts link it | Allowed, with a warning that says how many posts would point to a broken link |
| Media | In **Cloudflare R2** from the start (it also covers future video sources), not on a server volume |
| Backups | Postgres is already in the server's nightly restic backup to the Hetzner Storage Box (infra decision 0007). R2 media are outside the server: adding them to that nightly backup is part of the media phase |
| Action mode | **Frozen** on today's pull-request flow for whoever uses it; the new model is for the app only |
| Existing launches | Imported, except launches 2 and 4 (skipped tests, nothing published) and launch 7 (the failed v0.2.0), which are **deleted** |
| The launches repo's old draft folders | `launches/*/` and `articles/*/` drafts and `pack.json` are **deleted** from the repo once the import is verified (they stay in git history) |

## How it is built

In phases, each behind a flag and deployed like the refactor (a `pg_dump` before each migration,
additive migrations only, the current flow working until the last phase; the one exception is the
drop of `draft_snapshots` below):

1. **Schema and storage**: new tables for sources, per-launch channel config, packs, versioned drafts,
   media and approvals, plus a dedupe key so "a launch happens once" holds without a repo and a tag;
   the R2 media port. Nothing reads them yet.
2. **Shadow write**: the current pipeline also writes all of that whenever it opens a pull request,
   and an automatic check compares the database copy with the pull request.
3. **Import** of the existing launches (with the deletions above), first on a restored copy of
   production.
4. **Read from the database**: the launch page, the API, MCP, comments and scheduling stop reading
   GitHub.
5. **Review and approve in the app**: no pull request for new launches; the blog becomes one commit at
   publish time, followed by the "wait until live" check.
6. **Sources**: text, URLs (with a fetcher guarded against server-side request forgery), several
   repos, uploaded media.
7. **Triggers and deletion**.
8. **Cleanup**: the pull-request path, draft snapshots and the `pull_request` webhook go; the old draft
   folders are deleted from the launches repo.

## Where it stands

Phases 1 to 7 are built ([media-store.md](../media-store.md), [launch-store.md](../launch-store.md),
[launch-import.md](../launch-import.md), [launch-store-read.md](../launch-store-read.md),
[app-review.md](../app-review.md), [sources.md](../sources.md),
[launch-triggers.md](../launch-triggers.md), [launch-delete.md](../launch-delete.md)), and on
2026-11-01 their flags were retired ([server.md](../server.md#the-flags)). **Phase 8 is done in the
code**:

- **No pull request for a new launch in the app**: the runtime always holds a launch's drafts in
  Shipcast. The engine keeps its delivery to a pull request and its publishing from the merged files
  only for Action mode, which this decision froze on that flow (`shipcast ci` builds no launch model).
- **The drafts snapshot is gone**: its service, repository and queue, "Refresh from GitHub" and the
  hourly re-read of open pull requests; its table is dropped too (below).
- **The `pull_request` webhook is ignored by the app**: a merge publishes nothing; Action mode still
  publishes on its workflow's merge.
- **Launches already in pull requests stay readable** from the rows the import wrote: the launch page,
  the API and MCP read them with no GitHub call, and a retry or a scheduled piece publishes from the
  rows too, never from the launches repo's draft folders. A launch the rows do not hold is not read
  from GitHub: its review is a clear error (`LaunchNotHeld`, 409) that names the import, rather than a
  read-only fallback that would keep the whole pull-request read path alive. Such a launch is not
  edited or approved in the app.
- The shadow write and its check are gone. On 2026-11-02 the import's script went too, with its
  service, repository and tests ([launch-import.md](../launch-import.md#why-the-script-went)); its rows,
  the `import_batch` columns and `launch_imports` stay.

What remains, each a separate step the owner must agree to:

1. **The import in production** ([launch-import.md](../launch-import.md#in-production)) was the
   precondition of deploying phase 8: a launch drafted in a pull request that the rows do not hold
   shows the `LaunchNotHeld` error. Its script is removed now; the rows it wrote are what the app
   reads.
2. **The old draft folders of the launches repo are deleted** in a commit prepared on 2026-11-02 that
   the owner pushes (they stay in git history): every `launches/<project>/<ref>/` folder's channel
   drafts `*.md`, `release-notes.md` and `pack.json`, and every `articles/<slug>/` folder's drafts and
   `pack.json`. Not `public/launches/…` (the media the published posts link), `public/articles/…`
   (an article's images), `public/covers/`, `projects.yml`, `brand.yml` or the articles under
   `src/content/posts/`; `launches/README.md` stays, and so does each `articles/<slug>/launch.yml`
   while the AI settings' prompt preview of an article launch reads it (`previewPrompt`, which falls
   back to the brand's default channels without it). Publishing reads none of the folders since phase
   8; Action mode reads them only for its own launches, and the owner's launches repo does not run it.
   With the folders gone, the import script had nothing left to read and was removed (above).
3. **Drop what nothing uses any more**: the `draft_snapshots` table, which nothing writes or reads
   since phase 8, is dropped by migration `0022_drop_draft_snapshots` (2026-11-02), with its last
   mentions (the deletion of a launch's rows, the SQLite converter, the preview seed). It is **the
   one agreed exception to additive-only migrations**: the owner decided it, with no `pg_dump` step
   because he keeps his own backups; every other migration stays additive. The `launches.model`
   column keeps telling launches decided in a pull request (`legacy`) from the others, and the
   `import_batch` columns and `launch_imports` keep the record of the import.

## Related

[[launches-repo.md]] · [[publishing.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[decisions/action-mode.md]] · [[decisions/automatic-channels-only.md]] · [[plans/handoff-2026-10-29.md]]
