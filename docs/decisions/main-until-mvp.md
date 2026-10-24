---
created_at: 2026-10-24T12:54:20.293141151Z
updated_at: 2026-10-24T13:19:29.081054127Z
tags:
    - decision
    - workflow
    - git
---
# Work straight on main until the MVP

Decided on 2026-10-24 by the owner.

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

## Rules while it lasts

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

## When it ends

At the MVP, pull requests come back, squash-merged, and `main` gets branch protection on the CI check:
from then on other people use Shipcast and contribute to it. [CONTRIBUTING.md](../../CONTRIBUTING.md)
already tells outside contributors to open an issue first and send pull requests.

## Related

[[plans/shipcast.md]] · [[status.md]]
