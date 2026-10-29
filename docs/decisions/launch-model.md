---
created_at: 2026-10-29T22:52:52.911566745Z
updated_at: 2026-10-29T22:52:52.911566745Z
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
repo). Nothing of it is built yet; this records what was decided and the order it is built in.

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
additive migrations only, the current flow working until the last phase):

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

## Related

[[launches-repo.md]] · [[publishing.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[decisions/action-mode.md]] · [[decisions/automatic-channels-only.md]] · [[plans/handoff-2026-10-29.md]]
