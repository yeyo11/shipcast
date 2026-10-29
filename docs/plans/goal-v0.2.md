---
created_at: 2026-10-27T12:09:30.457091857Z
updated_at: 2026-10-29T15:44:42.036604826Z
tags:
    - plan
    - goal
    - roadmap
    - youtube
    - github-action
    - release
    - phase-11
    - handoff
---
# Goal: close the after-MVP phase, add the GitHub Action and YouTube, launch v0.2.0

The brief of an autonomous run, agreed with the owner on 2026-10-27. It finishes what
[goal-after-mvp.md](goal-after-mvp.md) left open (milestone 9 and its Outcome), clears every pending
fix the agent can solve alone, brings two items the roadmap held for later
([after-mvp.md](after-mvp.md), phase 11: the GitHub Action mode with a one-command install, and
YouTube), and launches Shipcast v0.2.0 with Shipcast on the owner's real accounts. **YouTube is the
last milestone**, after the launch. Where this brief and a guess disagree, this brief wins; where it is
silent, [../../CLAUDE.md](../../CLAUDE.md), [handoff-2026-10-26.md](handoff-2026-10-26.md) ("How work
is done here") and the decisions in `docs/decisions/` decide.

**Everything that needs the owner is at the end** ("What the owner does after the run"). The run never
waits for the owner.

## Decisions the owner took for this run

| Question | Decision |
| --- | --- |
| Order | The fixes, the review of milestones 1 to 8, the GitHub Action, the v0.2.0 launch, the docs, and **YouTube last** |
| YouTube video | Two per launch: a **Short** (9:16, under 60 s) and a **horizontal video** (16:9, 1 to 3 min). Slides, demo and subtitles, **no voice** |
| YouTube's audit | Expected then: Google keeps API uploads of an unaudited project **private**. Build everything, upload private, prepare the audit form; the owner requests the audit at the end. (On 2026-10-29 the first uploads, the Sluice article's two videos, came out public with the project unaudited: [decisions/youtube.md](../decisions/youtube.md#privacy-and-googles-audit)) |
| Connecting YouTube | The owner prepares Google Cloud and leaves a refresh token in `data/youtube-oauth.json` (steps below). If the file is there when the run reaches YouTube, it is imported into the keychain and deleted; if not, connecting is an owner step at the end |
| GitHub Action and install | **Both**: a published Action and a one-command install, for other developers |
| AI in CI | Any of the SDK providers Shipcast already supports (**Anthropic or OpenAI**), chosen by a variable, the key as a repository secret |
| Distribution | The CLI on **npm as `@yeyo11/shipcast`** (`shipcast` is taken on npm), with the `shipcast` command; the Action on the **GitHub Marketplace**. The owner publishes both at the end |
| The final test | **The agent approves and publishes v0.2.0 itself** on the real accounts |
| Autonomy | The agent may **deploy to production** after each verified batch, **close the launches repo's pull request #8** (the "TEST" article) and mark launch 4 skipped, **create repositories, tags and releases** (including `yeyo11/shipcast-action`, public), and **enable the YouTube API in the existing Google Cloud project** (the one of the Search Console service account) if the owner has not already |

## Rules for the run

- **How work is done** is in the handoff: verify only through Sluice's `verify`; documents only
  through pando's `kb_add_document` (it writes into the main checkout's `docs/`: copy the file into the
  worktree, then remove or restore it in the main checkout, which stays on `main`, clean); stage files
  by name; Conventional Commits with the `Co-Authored-By` line; work in your own worktree from
  `origin/main` and push straight to `origin main` (no pull requests until the owner asks again).
- **Deploy** after each verified batch, exactly as the handoff says: `pg_dump` into `data/backups/`,
  fast-forward the main checkout, `pnpm install` when the lockfile changed, `systemctl --user restart
  shipcast-app`, `curl https://shipcast.josegarrido.dev/api/health`, and compare the table counts.
  Migrations are additive only. **The owner's data is never lost.**
- **Previews never touch TLS** (a preview's `SHIPCAST_APP_TLS=off`, its own keychain service, its own
  throwaway Postgres restored from a backup with automation off). Design changes are shown on a
  preview and listed for the owner's review at the end; nothing is blocked on that review.
- **Real accounts**: publish, edit and delete only what this run publishes. Never touch earlier
  posts. Instagram's second account ("Trendify Media") is never used: it is the owner's question
  at the end.
- **Disk**: about 10 GB were free on 2026-10-27. Check `df -h /` before builds, video rendering and
  Docker; stop and report under 5 GB. Never delete Docker volumes, tagged images or the owner's files.
- **Secrets** never go in a repository, a log, a commit message or a screenshot.
- Commit after every point, so a session limit loses nothing; sub-agents each in a worktree and branch,
  merged by the lead (the handoff's rules).

## Milestone 1: the pending fixes

From the 2026-10-26 handoff, checked again on 2026-10-27:

1. **The work list's paging**: `registry.jobs()` caps at 200 with no offset, so the list cuts the
   day's earlier jobs. Page it properly (offset or keyset), in the API and the page.
2. **Comments' text search** is `ILIKE` on three columns with no index: an additive migration with
   `pg_trgm` GIN indexes (or a better plan you justify), measured before and after on a copy.
3. **A launch's own page has no banner illustration**: draw one in the postal style of the other seven
   (`components/illustrations`), shown on a preview; listed for the owner's review.
4. **"The queue no longer has this job"**, seen once in an Automation round: find the cause, fix it or
   document why it is harmless.
5. **Previews and GitHub**: `SHIPCAST_PREVIEW_FAKE_NETWORKS` exists; check whether a preview can still
   write to GitHub for real (the onboarding's *Commit brand.yml*, drafts pull requests). If it can,
   make those writes dry runs on a preview.
6. **Seen only on previews**: check in production, at 320, 390 and 1280 px, the assistant's history and
   phone bubble, the tour, the date and time pickers, Channels, Comments' filters and the launch cards
   (`apps/web/scripts/reflow-check.ts` against production, read-only).
7. **The launches repo**: close pull request #8 (the "TEST" article) with a comment, and mark launch 4
   (`article:test`) skipped in the registry through the app's own path, not by hand in SQL if a path
   exists.
8. **The blog has no style for tables**: the REA article had to turn its table into a list. Add a
   table style in `yeyo11/launches` that scrolls sideways inside the column on a phone, as code blocks
   do (a pull request on the launches repo, merged by the agent: the owner authorised repo work, and the
   blog's design rules still apply).

## Milestone 2: milestones 1 to 8 of the after-MVP goal, point by point

Go through every item of milestones 1 to 8 in [goal-after-mvp.md](goal-after-mvp.md) against the code
and production, and write the result as a table (item, state, evidence) in the Outcome. In particular
the four not checked again on 2026-10-26: the AI review of accounts and profile edits (milestone 5),
the Lighthouse gate (milestone 3), the content written for search (milestone 4), and each README
linking the blog (milestone 8). Fix what is missing and fits the run; list what does not, with why.

## Milestone 3: the GitHub Action mode and the one-command install

Write the design as `decisions/github-action.md` before building. What it must satisfy:

- **For another developer, on their own repo**, with no Postgres, no keychain and no claudio:
  - the AI through an SDK provider, **Anthropic or OpenAI**, chosen by a variable, the key a secret;
  - the networks' credentials as repository secrets (environment variables), never the keychain;
  - **a launch happens once**: the record lives where CI can read it without a database (the launches
    repo's files, for instance a record per launch), so a re-run or a second workflow never repeats a
    campaign;
  - the drafts pull request in their launches repo, and publishing when it is merged (a workflow in
    that repo on merge), modes per channel from `launch.yml` as today.
- **The Action**: `yeyo11/shipcast-action`, public, `action.yml` at the root with branding for the
  Marketplace, on `release: published` (and `workflow_dispatch`), documented inputs and outputs,
  versioned with a `v1` tag and a first release. Test it end to end on a throwaway public test repo
  created for it, in a **dry-run mode that publishes nothing** (the drafts pull request is fine);
  delete the test repo at the end or list it for the owner.
- **The CLI on npm**: `@yeyo11/shipcast` with the `shipcast` bin, built so `npx @yeyo11/shipcast` works
  without the monorepo; `npm pack` and a clean install in an empty directory prove it. **Do not
  publish**: the owner does.
- **The one-command install**: `npx @yeyo11/shipcast init` (or an equivalent you justify) that asks for
  or detects the repo, writes `.github/launch.yml`, `brand.yml` and the two workflows (the Action on
  release, publishing on merge in the launches repo), and prints the secrets to set, each with the link
  to get it. Test it in an empty repo.
- **Docs**: a getting-started guide in the README and in `docs/`, the Action's README, and the
  decision. The owner's own install (local, Postgres, keychain, claudio) stays as it is.

## Milestone 4: release v0.2.0 and the final test (milestone 9 of the after-MVP goal)

On the owner's real accounts, with milestones 1 to 3 deployed. YouTube is not part of this launch yet
(milestone 6 adds its videos to it afterwards, if it can be connected):

1. **The release**: changelog since v0.1.0 (the after-MVP phases, Reddit, the GitHub App's traffic,
   the redesign, articles with images, the GitHub Action and the install), version bumps, the tag and
   the GitHub release `v0.2.0` on `yeyo11/shipcast`.
2. **Noticed through the GitHub App** (webhook or round), not launched by hand; if it is not noticed,
   that is a bug to fix before going on.
3. **The drafts improved with the writing assistant**, each change kept in the pull request.
4. **Scheduled at the recommended times** for the channels that can wait; the others at once.
5. **Approved and published by the agent**, every connected channel the launch's `launch.yml` turns on.
   Reddit only if `launch.yml` says so and its subreddits accept it; when in doubt, off.
6. **One comment answered** through the assistant once one arrives (the agent approves the reply); if
   none arrives within the run, say so in the report rather than inventing one.
7. **The numbers** in Stats and on the launch's page after the first reading.
8. **Edit** one live post where the network allows it (Mastodon), and prove **delete** end to end on a
   preview with fake networks (`SHIPCAST_PREVIEW_FAKE_NETWORKS=1`), not on the real launch.
9. **Everything published is listed** in the report, with links.

## Milestone 5: close the phase in the docs

- Write the **Outcome** of [goal-after-mvp.md](goal-after-mvp.md) (milestones 1 to 9, with the table of
  milestone 2).
- Update [../status.md](../status.md) and the roadmap's ticks in [after-mvp.md](after-mvp.md) (the
  Action done; YouTube as milestone 6 leaves it).
- A new handoff, `plans/handoff-<date>.md`, in the format of the last one. Milestone 6 updates both
  when it ends.

## Milestone 6: YouTube (last)

A channel of its own, like the others: it publishes itself, never a draft for the owner to post
([../decisions/automatic-channels-only.md](../decisions/automatic-channels-only.md)). Write the decision
as `decisions/youtube.md` first.

- **The videos**, drawn by `packages/assets` from what each launch already has (the demo recorded with
  Playwright or the repo's GIF, the screenshots, the cover, the pack's texts), with ffmpeg as the
  Instagram demo video already is:
  - a **Short**: 1080x1920, under 60 s: a title card, the demo, two or three points as text cards,
    a closing card with the article's address;
  - a **horizontal video**: 1920x1080, 1 to 3 min: the same story as slides (what it is, the demo,
    what it does today, how to try it), each with subtitles burned in **and** an SRT uploaded as
    captions, in the launch's languages;
  - no voice; music only if a clearly licensed track is bundled (otherwise silence); the brand's look.
  - An article without a demo gets the Short and the horizontal video from its screenshots and texts.
- **The content pack** gains `youtube`: for each video a title (≤ 100), a description (≤ 5,000, the
  article linked first, chapters for the horizontal one), tags, and the language; schema, JSON Schema
  for the AI and the channel's brief, under the truth rule.
- **The connector** (`packages/connectors/src/youtube.ts`): resumable upload (`videos.insert`), captions
  (`captions.insert`), a custom thumbnail when the channel allows it (it needs a verified channel: if
  refused, record why and go on), edit (`videos.update`: title, description, tags), delete
  (`videos.delete`), numbers (`videos.list` statistics: views, likes, comments) and the channel's
  snapshot (subscribers, views, videos) for Stats, comments read and answered
  (`commentThreads.list`, `comments.insert`) in the comment assistant. Mind the quota (10,000 units a
  day; an upload costs far more than a read): reads batched, and the quota's state shown in the app
  when it runs out.
- **The privacy**: request `public` for the published video; when Google keeps it `private` (an
  unaudited project), record it on the post and show it in the app ("private until Google audits the
  project"), and do not count it as a failure.
- **Connecting**: the OAuth flow at `/auth/youtube/callback`, the client id and secret in Settings,
  like Reddit and LinkedIn; and a one-time import of `data/youtube-oauth.json` into the keychain as the
  connected account (then delete the file and say so).
- **Edit and delete** in the launch page and the API, capabilities, Channels' card with its own number
  (subscribers), docs (`accounts.md`, `publishing.md`, `content-pack.md`, `stats.md`, the API), tests
  with the network faked.
- **v0.2.0 on YouTube**: if `data/youtube-oauth.json` is there (or the owner connected YouTube in the
  app meanwhile), import it, turn `youtube` on in Shipcast's own `launch.yml` and publish v0.2.0's two
  videos through the launch's normal path (expected private until the audit), then edit one's
  description and delete nothing. If it is not there, stop short of any real upload: the connection
  and v0.2.0's videos join the owner's steps.
- **The audit form**: prepare, in `docs/plans/youtube-audit.md`, everything Google's YouTube API audit
  form asks (what the app does, the scopes and why, the screens, the data kept, the privacy policy's
  address; update the blog's privacy page for YouTube data). The owner sends it at the end.
- Update `status.md`, the roadmap and the handoff for YouTube.

### Preparing YouTube (the owner, any time before milestone 6)

1. A YouTube channel on the owner's Google account.
2. In the Google Cloud project of the Search Console service account: **YouTube Data API v3** enabled;
   the OAuth consent screen *External*, with the scopes `youtube.upload`, `youtube.readonly` and
   `youtube.force-ssl`, **published** ("In production"; a consent screen left in *Testing* makes refresh
   tokens expire after 7 days); an OAuth client of type *Web application* with the redirect URIs
   `https://shipcast.josegarrido.dev/auth/youtube/callback` and
   `https://developers.google.com/oauthplayground`.
3. A refresh token for those three scopes, made in the OAuth Playground with the owner's own client
   (offline access), saved with the client as `data/youtube-oauth.json`
   (`{ "client_id", "client_secret", "refresh_token" }`, mode 600). `data/` is gitignored.

## Done when

- [ ] milestone 1's eight fixes done, each verified and deployed
- [ ] milestones 1 to 8 checked point by point, gaps fixed or listed
- [ ] the Action released as `v1` and tested end to end in dry run; the npm package and the init
      command proven from a clean directory; both documented
- [ ] Shipcast v0.2.0 released and launched by Shipcast on the real accounts, everything published
      listed
- [ ] the Outcome, `status.md`, the roadmap and a new handoff written
- [ ] YouTube publishing, editing, deleting, numbers and comments, with both videos, tested and
      deployed; v0.2.0's videos uploaded if the token was there, or listed for the owner if not
- [ ] the report to the owner, in Spanish, ending with the list below

## What the owner does after the run

The run prepares each of these and ends its report with them, in this order:

1. **Connect YouTube**, if the run did not find the token (the steps above, or the app's Connect
   button now that it exists), and publish v0.2.0's two videos from the launch page.
2. **Request YouTube's audit** with the form prepared in `docs/plans/youtube-audit.md`; until Google
   answers, videos were expected to stay private (they did not: see the YouTube's audit row above).
3. **Publish the CLI on npm** (`npm publish --access public` from the prepared package, with the
   owner's npm account).
4. **List the Action on the GitHub Marketplace** (it needs the owner to accept the Marketplace
   agreement in the browser).
5. **Review the design changes**: the launch page's banner illustration, the YouTube videos' look, the
   blog's table style.
6. **Review the REA article** (launches pull request #10), staged on 2026-10-27, and approve it in the
   app.
7. **Connect Hashnode** if it should publish (it is not connected).
8. **Say whose "Trendify Media" is**, the second Instagram account under the personal brand; if it is
   not the owner's, disconnect it (brands never mix).
9. **The Threads use case's redirect URL** in Meta (pending since 2026-10-26).
10. **`main`'s branch protection** on GitHub still requires the `test` check; remove it or keep it.
11. **Disk space**: about 10 GB free on 2026-10-27.

## Related

[[goal-after-mvp.md]] · [[after-mvp.md]] · [[handoff-2026-10-26.md]] · [[status.md]] · [[accounts.md]] · [[publishing.md]] · [[content-pack.md]] · [[decisions/automatic-channels-only.md]] · [[goal-article-rea.md]]