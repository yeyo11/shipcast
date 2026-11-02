---
created_at: 2026-11-02T12:06:57.717193145Z
updated_at: 2026-11-02T12:06:57.717193145Z
tags:
    - github-action
    - ci
    - scheduling
    - phase-11
    - guide
---
# Action mode: timing, and how to get a round on time

GitHub's scheduler is not a clock. The decision behind this page is
[decisions/action-timing.md](decisions/action-timing.md); this is what to expect and what to set up.

## What runs when

| What | Starts from | Timing |
| --- | --- | --- |
| Drafting a release | `release: published` in the project repo (workflow `shipcast.yml`) | Seconds after the release. Does not depend on any cron |
| Publishing a merged drafts pull request | `pull_request: closed` in the launches repo | Seconds after the merge, then waits up to `wait-minutes` (25 in the template) for the blog to deploy; the real blog takes 3 to 6 minutes |
| The **round**: scheduled pieces, channels to retry, a deploy that took longer than the wait | The `shipcast-publish.yml` workflow when dispatched, or its `schedule` | On time only with an outside trigger (below) |
| `round --detect`: releases no workflow claimed | The same round | Public repos only, see below |

## Honest numbers

- **Only the cron (the default backstop):** GitHub documents that scheduled runs can be delayed under
  load and, in a repo with little activity, dropped. Measured on 2026-11-02 on a private launches repo:
  3 runs in 17 hours of an hourly cron, each over 40 minutes late. Expect a scheduled post to go out
  anywhere from on time to several hours late, and plan on that.
- **With an outside trigger every 15 minutes:** a scheduled piece goes out at most about 15 minutes
  after its time (plus the few seconds the run takes), and a retry or a slow deploy is picked up in the
  same window.
- **A late or missed round loses nothing.** Every drafted launch is tried on every round, a piece whose
  time has passed is due, and a launch happens once. The cost is only delay.
- **A time before the next round** is as precise as the round: schedule pieces for a time you can
  live with being up to 15 minutes later, or up to an hour or more without the outside trigger.

## An on-time round: call the workflow from outside GitHub

Anything that can make an HTTP call every 15 minutes works: a Cloudflare Worker with a Cron Trigger,
[cron-job.org](https://cron-job.org), your own server. `shipcast init` prints this with your launches
repo filled in:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $SHIPCAST_DISPATCH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/OWNER/launches/actions/workflows/shipcast-publish.yml/dispatches \
  -d '{"ref":"main"}'
```

The token is a **fine-grained personal access token** for the launches repo only, with *Actions:
read and write* and nothing else. Keep it in the trigger's own secrets (a Worker's secret, the cron
service's header field), not in the repo. A dispatch that arrives while a round runs waits its turn
(the workflow's `concurrency` group), so calling it often is safe. The three `schedule` lines in the
template (`7`, `27`, `47` past the hour) stay as a free backstop.

## Limits

- **`--detect` reads your public events.** It never sees a release of a *private* project repo, whatever
  the timing. For those, the way a launch starts is the repo's own `release: published` workflow.
- **A release created by another workflow with `GITHUB_TOKEN`** does not start `shipcast.yml`: GitHub
  does not chain workflows from that token. Add a last step to that release workflow. Dispatching a
  workflow is the one thing `GITHUB_TOKEN` is allowed to do, so no PAT or App is needed:

  ```yaml
  permissions:
    contents: write
    actions: write # to dispatch Shipcast's workflow
  # ...
  - name: Launch with Shipcast
    run: gh workflow run shipcast.yml -f tag="$TAG"
    env:
      GH_TOKEN: ${{ github.token }}
      TAG: ${{ github.ref_name }} # or the tag your workflow just released
  ```

  A release made by hand, or with a PAT or an App token, starts the workflow itself and needs nothing.
- **More than 100 public events between two rounds** (a very active account after a long gap) can push
  a release out of the page `--detect` reads. The release workflow is the dependable path.

## Related

[[decisions/action-timing.md]] · [[decisions/action-mode.md]] · [[decisions/github-action.md]] · [[getting-started.md]] · [[scheduling.md]]
