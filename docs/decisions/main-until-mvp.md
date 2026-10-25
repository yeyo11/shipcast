---
created_at: 2026-10-24T14:26:58.648123954Z
updated_at: 2026-10-25T10:01:24.713699659Z
tags:
    - decision
    - workflow
    - git
---
# Work straight on main until the MVP

Decided on 2026-10-24 by the owner. **Ended on 2026-10-25**, when the owner closed the MVP
([plans/mvp-close.md](../plans/mvp-close.md)): every change now goes through a pull request,
squash-merged (see [After the MVP](#after-the-mvp)).

## Decision

Until the MVP — the test that closes phase 1 of the [roadmap](../plans/shipcast.md#roadmap): claudio
announced on the blog and on dev.to with no intervention beyond the merge — every change is committed
straight to `main`. No feature branches, no pull requests.

## Why

There is one developer, no users and no release. A pull request per change adds a round trip that
protects nobody, and slows the phase where the design still moves most.

What still guards `main` without pull requests:

- **Sluice** runs `typecheck` before every commit and `test` before every push, for people and agents
  alike ([.sluice.toml](../../.sluice.toml)).
- **CI** runs on every push to `main`, not only on pull requests
  ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)), so a break shows up on GitHub.

## Rules while it lasted

- **Small commits in Conventional Commits.** Without pull requests the history of `main` is the only
  record of what changed and why, and the changelog will be built from it.
- **Agents on `main` push without asking.** Once a commit passes the gates (Sluice runs `test` on
  pre-push), the agent pushes it, and checks the CI run when the change could break it. Changed on
  2026-10-24, the same day: the first version said agents push only when the owner asks, and the owner
  lifted it for this repository, since asking before every push was the round trip this decision
  exists to remove.
- **Parallel agents do not push to `main`.** An agent in its own worktree works on its own branch; the
  maintainer integrates it into `main` (or it goes through Sluice's merge queue), so two agents never
  race each other on the same branch.

## After the MVP

The MVP closed on 2026-10-25: phases 0 to 5 done, Shipcast v0.1.0 launched with Shipcast, and the app
running its own rounds. Other people can now use Shipcast and contribute to it, so:

- **Every change is a branch and a pull request**, squash-merged: the pull request's title, in
  Conventional Commits, becomes the commit on `main`. The repository only allows squash merges and
  deletes the branch once merged.
- **`main` is protected**: no direct pushes, for the owner too, and the CI `test` check must pass
  before a merge. No approving review is required, since the owner cannot approve their own pull
  requests.
- **Agents** branch from `main`, commit through the Sluice gates, push their branch and open the pull
  request without asking; **the owner merges it**, unless they ask the agent to.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) still asks outside contributors to open an issue first.

## Related

[[plans/shipcast.md]] · [[plans/mvp-close.md]] · [[status.md]]
