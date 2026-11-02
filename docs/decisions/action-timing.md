---
created_at: 2026-11-02T12:06:38.222607373Z
updated_at: 2026-11-02T12:06:38.222607373Z
tags:
    - decision
    - github-action
    - ci
    - scheduling
    - phase-11
---
# Decision: Action mode does not depend on GitHub's cron being on time

Taken on 2026-11-02 (SHP-25), with the owner's go-ahead. Builds on [action-mode.md](action-mode.md) and
[github-action.md](github-action.md); the honest numbers are in [../action-timing.md](../action-timing.md).

## The problem, measured

GitHub delays or drops `schedule` events, more on private repos. On 2026-11-02 the hourly cron
(`17 * * * *`) of the Action's test launches repo ran 3 times in 17 hours, each more than 40 minutes
late; another private repo's daily job did not run at all. The Action's hourly `shipcast ci round`
(scheduled pieces, retries, `--detect`) depended on that cron.

The event-driven paths are reliable: `release: published` starts `ci launch`, and a merged drafts pull
request starts `ci publish`.

## What a late or missed round costs (checked in the code)

- **Scheduled pieces and retries lose nothing.** `waitsUntil` treats a piece whose time has passed as
  due, and `ciRound` tries every `drafted` launch each time it runs, so a round that comes late only
  delays the post by its own lateness (engine test "a slot missed while the machine was off goes out on
  the next run"; `ci-commands.test.ts` covers the round itself).
- **A deploy slower than the wait.** `ci publish` waits inside the job (`wait-minutes`) for the blog to
  deploy, then leaves the piece to the next round. With the cron dropped, that is the worst case: hours.
- **`--detect` recovers, within limits.** It reads the brand's *public* events with a last-id cursor, so
  a late round claims every release that came meanwhile (tested), unless over 100 public events piled
  up between rounds. It never sees releases of **private** repos, whatever the cron does: for those the
  only path is the release workflow.
- **A release made by another workflow with `GITHUB_TOKEN`** (Sluice's `release.yml`) does not start
  the Shipcast launch workflow: GitHub does not chain workflows from that token.

## Decision

1. **An external trigger is the recommended way to get an on-time round.** Anything outside GitHub that
   calls `workflow_dispatch` on `shipcast-publish.yml` every 15 minutes works: a Cloudflare Worker with a
   Cron Trigger, cron-job.org, the owner's own server. The token is fine-grained, limited to the launches
   repo, with *Actions: read and write*, and lives in the trigger's own secrets. `shipcast init` prints
   the exact `curl` (never a token). For the owner's launches repos the trigger is a Worker, built with
   the infra agent; the owner creates the token.
2. **The workflow keeps three cron lines as a free backstop** (`7`, `27`, `47` past the hour, minutes
   GitHub's scheduler is least busy at). One dropped run is covered by the next; overlapping runs queue on
   the existing `concurrency` group.
3. **The deploy wait is 25 minutes** in the template (`wait-minutes: 25`), configurable, inside the
   job's `timeout-minutes: 45`. The real blog deploys in 3 to 6 minutes.
4. **`--detect` is not extended to private repos.** Documented as a limit.
5. **Releases created with `GITHUB_TOKEN`:** a last step in the release workflow,
   `gh workflow run shipcast.yml -f tag="$TAG"` with `permissions: actions: write`. Dispatching a
   workflow is the one thing `GITHUB_TOKEN` may do, so neither a PAT nor an App is needed. It is in
   `init`'s output, the docs and the Action's README; Sluice's own `release.yml` gets it as the real
   example.

## Rejected

- **Only more cron lines.** Free, but GitHub drops them in clusters: better odds, no guarantee.
- **Shipcast on the server dispatching the round.** Brings back the machine Action mode exists to avoid.
- **Waiting longer inside the round's job.** Fixes the deploy case only, and a runner that waits is
  billed time.
- **A PAT or App token on every release workflow.** More to create and rotate than a dispatch step.

## Related

[[decisions/action-mode.md]] · [[decisions/github-action.md]] · [[action-timing.md]] · [[scheduling.md]] · [[getting-started.md]]
