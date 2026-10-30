---
created_at: 2026-10-30T06:19:22.606949087Z
updated_at: 2026-10-30T06:59:53.066780487Z
tags:
    - launches
    - launch-model
    - drafts
    - approval
    - publishing
    - blog
    - flags
---
# Reviewing and approving launches in the app

The fifth phase of [decisions/launch-model.md](decisions/launch-model.md) (card SHP-13), built on
2026-10-30 behind the `app-review` flag (off by default, and in production until it is verified).
With the flag on, **a new launch has no pull request**: Shipcast holds its drafts, the owner edits,
previews and approves them in the app, and the launches repo receives the article and its media as
one commit when the launch is published. Launches drafted before (`model = 'legacy'`) keep their
pull request flow to the end, and Action mode stays on it ([decisions/action-mode.md](decisions/action-mode.md)).

## Which launches

`launches.model` says who holds a launch's drafts: `legacy` (a pull request, approved by its merge)
or `app` (Shipcast). The pipeline's delivery (`deliverDrafts`, `pipeline.ts`) decides it: with the
flag, a launch's drafts are kept by `AppReviewService.hold` instead of opening a pull request, and the
launch becomes `app` and `drafted` with no `detail`. Nothing is written to GitHub. The rows are the
launch store's own write ([launch-store.md](launch-store.md), `LaunchStoreService.held`), but here
they are all there is of the launch: a draft or a file that cannot be stored **fails the draft**,
where the shadow write only reports it. The drafts' mode lines speak of the app ("published once
approved in Shipcast", "published as soon as it is ready, without waiting for approval").
"Publish directly" approves the drafts on delivery (by `shipcast`).

Without the flag a process treats an `app` launch as waiting ("the app-review flag is off"), and
refuses to edit or approve it: turning the flag off strands nothing, it only pauses those launches.

## One implementation

`AppReviewService` (`packages/engine/src/services/app-review.ts`) holds every use case; what is pure
of it is `packages/engine/src/app-review.ts` (the mode lines, `channelWaits`, the article preview,
the preview address). The entry points only dispatch on the model:

| Use case | Entry points | With an `app` launch |
| --- | --- | --- |
| Edit a draft | the launch page's save, the edit page, `LaunchService.editDraft` | a `draft_versions` row of the owner's (`origin = 'owner'`, `author` the signed-in login), checked for its network's length; refused for a path that is not a draft, a piece already out (edited on its channel), or a launch no longer drafted. No GitHub call |
| Approve | the page's Approve, `POST /launches/{id}/approve` (and MCP's `approve_drafts`), `LaunchService.approve` | an `approvals` row naming the current version of every draft, `by` the signed-in login (`api` from the REST API, `owner` when a caller says nothing); the approval in force before is revoked. Then publishing is queued, as after a merge |
| Read the review | the launch page, `GET /launches/{id}`, through `LaunchReadService.review` | from the rows only (below) |
| Whether anything can go out | the round, a draft's end, `approval()` | `AppReviewService.approval` |
| Publish | `publishLaunch` through every entry point | reads the approved versions; the site commit first |

## Approval, piece by piece

An approval is per launch and freezes versions (`approvals.versions`, `{draft id: version id}`).
`channelWaits` says, per channel, why it may not go out yet:

- an `auto` channel never waits: **it goes out without approval as soon as its drafts are ready**,
  as the owner decided;
- an `approval` channel waits until an approval is in force that names the current version of each
  of its drafts. An edit after approving therefore holds back **that channel alone** ("edited since
  it was approved: approve it again"); approving again records a new row.

Every channel links the article, so while the article waits nothing goes, `auto` channels included.
`approval()` answers "approved" (worth queueing a publish job) when the article does not wait and
either an approval is in force or some channel is `auto`; the draft job queues the publishing at
once in that case, so `auto` channels need no click.

## Publishing

`publishLaunch` (`publish.ts`) reads an `app` launch from the rows (`AppReviewService.publishing`):
the current pack, the channels (`storedChannelConfig`, shared with the reads of
[launch-store-read.md](launch-store-read.md)), and each draft's text by the path it was drafted at,
so every channel's run (and a strategy's `read`, YouTube's) is unchanged. Then:

1. **The article waits for its approval**, and with it every channel.
2. **One commit to the launches repo's `main`** (`AppReviewService.publishSite`): the articles (dated
   the day they go out; one already on the site keeps its first `pubDate` and gets `updatedDate`),
   every media file of the launch at the address its drafts use (`public/launches/<project>/<ref>/…`,
   so the URLs are the ones the pull request flow gave), and a new project's cover with its line in
   `projects.yml`. No `pack.json` and no channel drafts: those stay in Shipcast. With the blog off,
   the media alone are committed, for the networks that fetch them.
3. The commit is recorded under the cursor `app-blog:<launch id>` (its sha and time), so **a retry
   never commits twice**. A branch that moved meanwhile (409/422) is tried once more on its new head;
   any other failure answers "waiting", the publish job tries again 30 seconds later (up to 40 times,
   then the next round), and **nothing else goes out until the commit is made and the article is
   live** (today's `HEAD` on the article; with the blog off, on `og.jpg`).
4. Every channel not waiting goes out as before, under the same claims. A channel still waiting
   leaves the launch `drafted` (reported as partial) until it is approved.
5. Each published piece's `posts.draft_version_id` names the version it went out with.

The preview on the real site is closed once the commit is made.

## Previews

**In the app, every day.** Each article draft is shown as the blog would: its front matter's title,
description and launch image over the body rendered as GitHub-flavoured Markdown (`articlePreview`,
with `marked`, as Astro renders it), styled with the app's own tokens rather than the site's
(`.article-preview` in `app.css`). The text is the AI's or the owner's, so nothing in it runs: raw
HTML is shown as text, a link that is not http(s), mail or an anchor goes nowhere, a root-relative
image the launch holds is served by the app (`/media/<id>`), and any other root-relative link points
at the site.

**On the real site, on demand.** "Preview on the real site" (`AppReviewService.requestPreview`) puts
the files the publish commit would carry on a branch of the launches repo,
`preview/launch-<id>-<12 random hex>`, made again from `main` each time, and opens a **draft** pull
request from it (it cannot be merged by mistake). The launches repo's workflow already deploys every
pull request to a `*.workers.dev` alias and runs its Lighthouse gate, so no change was needed there.
The address is the workflow's own comment (`<!-- cloudflare-preview -->`): "Find its address"
(`findPreview`) reads the pull request's comments and keeps it, with the commit it shows, under the
cursor `app-preview:<launch id>`; the page shows the link once that commit is the last one pushed.
A page view reads only the cursor, never GitHub.

Rejected: a branch alone (the repo's workflow deploys pull requests, not branches; a `preview/**`
push trigger would need a change to the launches repo), and building the site inside Shipcast. The
preview is public, as everything on that repo is (the branch and the draft pull request can be read
on GitHub), but its address cannot be guessed, which is what the owner accepted.

## The page and the API

The review of an `app` launch has no `pullRequest` but an `app` part (`Review.app` in `review.ts`):
whether it is open, the approval in force, why each channel with a draft waits, the preview and the
publish commit; each text says whether its current version is the approved one (`approved`) and each
article carries its `preview`. The launch page shows "Waiting for you" while nothing is approved or
something changed since, with Approve and "Preview on the real site"; an article opens on its
preview, with a button to edit the text. `GET /launches/{id}` answers `approval` and `waiting` in
`drafts` instead of `pullRequest`, and `approved` on each file.

## Turning it on

`app-review` needs `launch-store-read` (and so `launch-store`) and `launch-media`: a process with it
and without them refuses to start (`ConfigError`). The order in production: the fourth phase on and
verified, then `app-review`. The phase is done when one article launch and one release launch are
published end to end this way, the launches repo receiving exactly one commit each, with Lighthouse
run on a preview.

## Known limits

- A REST approval is recorded as `api`, not the token's name, which the routes are not handed.
- A crash between the commit and its cursor would commit the same files again on the next try (an
  empty change on GitHub, a second deploy); the window is one database write.
- A draft pull request of a preview merged by hand on GitHub would put the article on the site
  outside Shipcast; a draft cannot be merged without being marked ready first.
- Scheduling the blog itself, and channels scheduled before the article's slot, are not handled
  specially yet ([scheduling.md](scheduling.md)): the article goes out at approval.
- The in-app preview approximates the site's look; the real site's preview is the exact one.

## Tests

`packages/engine/test/app-review.test.ts`: the flag off (the pull request as before), the delivery,
a failed media store failing the draft, the review and the article preview's escaping, edits, no
publishing before the article's approval, one commit with the article and media then every channel,
an edit after approving holding one channel, a failed commit tried again with nothing out before the
article is live, `auto` channels without approval (and a media-only commit with the blog off),
"publish directly", the real site's preview, a process without the flag, and who edited and approved.
`packages/runtime/test/runtime.test.ts`: the start refuses `app-review` without `launch-store-read`
or `launch-media`, and builds no service (the pipeline opens pull requests) unless it is named.

## Related

[[decisions/launch-model.md]] · [[launch-store.md]] · [[launch-store-read.md]] · [[media-store.md]] · [[launches-repo.md]] · [[publishing.md]] · [[engine.md]] · [[server.md]] · [[api.md]] · [[scheduling.md]] · [[decisions/action-mode.md]]
