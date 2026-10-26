---
created_at: 2026-10-25T20:26:09.906777237Z
updated_at: 2026-10-25T20:26:09.906777237Z
tags:
    - decision
    - github-action
    - ci
    - registry
    - phase-11
---
# Decision: the GitHub Action mode

Taken on 2026-10-25, building milestone 7 of the [goal](../plans/goal-after-mvp.md) (phase 11 of
[plans/after-mvp.md](../plans/after-mvp.md): "the GitHub Action mode and a one-command install").
The founding design ([plans/shipcast.md](../plans/shipcast.md)) wanted a reusable workflow that runs
on a release, with the registry kept in the central repo; the MVP went local first instead
([decisions/mvp-scope.md](mvp-scope.md)). Action mode is the same engine with **no machine of the
owner's**: everything runs in GitHub Actions, and the drafts still arrive as a pull request in the
launches repo.

## The command: `shipcast ci`

`shipcast ci launch | publish | round` runs headless. Its configuration comes only from the
environment (no `.env`, no keychain, no web app), its secrets from Actions secrets, and `--dry-run`
prints what it would do without writing anything (no state pushed, no AI call, no pull request, no
post). A composite action (`action.yml` at the repo's root) installs Node and Shipcast and runs it;
ready-to-copy workflows live in `templates/`, and a reusable workflow (`workflow_call`) wraps the
action for a project repo's five-line call.

## Where the registry lives: a JSON snapshot on a `shipcast-state` branch

There is no server, so the registry needs a home between runs. The run opens an in-process
**PGlite** (the registry's real schema and SQL, as in the tests), loads it from a **JSON snapshot**
kept on an orphan branch, `shipcast-state`, of the **launches repo**, and saves it back there.

- **One file, readable and small.** `registry.json` holds the migration it was taken at and the
  rows of each table, one row per line, so every run's change is a readable diff in the branch's
  history, which is also the audit log. A restore migrates a fresh PGlite up to that migration,
  inserts the rows, moves the id sequences past them and applies the newer migrations, which convert
  the rows as they convert any install (what `pnpm sqlite-to-postgres` does). A snapshot taken by a
  newer Shipcast than the one running is refused.
- **In the repo that already holds the launches.** The launches repo is the one every Action-mode
  workflow can already write to (it receives the drafts), so the state needs no new place, account
  or token. The branch is orphan, so it never touches the blog's history or its deploy.
- **No secret in it.** Keys and tokens come from Actions secrets on every run and are never written
  to the registry. The one secret the registry can hold, an Instagram token refreshed while it came
  from `.env` (the `instagram-token` cursor), is left out of the snapshot, and so are the API-token
  hashes and the job rows, which Action mode does not use. The rest (launches, pieces and their URLs,
  cursors, settings) is readable by whoever can read the launches repo: for a public blog, that is
  everyone. An owner who minds uses a private launches repo or their own Postgres (below).

### Rejected

- **PGlite's data directory on the branch** (or its `dumpDataDir()` tarball): tens of megabytes of
  binary per run, so the branch grows with every run and nothing in it can be reviewed, and it ties
  the state to PGlite's on-disk format.
- **Actions cache or artifacts**: a cache is scoped to one repo (a project repo's run cannot read the
  launches repo's), is evicted after a week unused and cannot be overwritten under the same key;
  artifacts belong to one run and expire. Neither can refuse a concurrent write, which is what "a
  launch happens once" needs.
- **The owner's Postgres as the default**: it needs a database reachable from GitHub's runners, which
  is the server Action mode exists to avoid. It is kept as an **option**: with `SHIPCAST_DATABASE_URL`
  set, `shipcast ci` uses that Postgres as the local install does, and no state branch at all.

## A launch happens once, with runs in several repos at once

A workflow's `concurrency` group only serialises runs of **one repo**, and Action mode has a run per
project repo plus the launches repo's. So the guarantee is in the state branch itself:

- **A lease, taken by a fast-forward push.** Before touching the registry a run commits `lock.json`
  (who holds it, until when) on top of the branch's tip and pushes it **without force**. GitHub
  refuses a push that is not a fast-forward, so when two runs race, one push lands and the other is
  rejected; the loser fetches again, sees the lease and waits, polling, until it is released or has
  expired. Every later save is a child of the run's own last commit, so a run whose lease expired and
  was taken over cannot overwrite the newer state: its push is refused and it stops. The first run
  creates the branch, and two first runs race the same way.
- **The claim is saved before any AI runs.** `ci launch` claims the release (the same
  `claim` on `(repo, ref)` as everywhere), saves the snapshot and releases the lease, then drafts;
  it takes the lease again only to record the outcome (drafted with its pull request, or failed with
  why). So a re-run, a second workflow, the round's polling or a manual launch of the same release all
  see it claimed and stop with "already launched", and the lease is held for seconds, not for the
  minutes the analysis takes.
- **The workflows add a concurrency group** per repo and ref (`cancel-in-progress: false`), which only
  saves a run from waiting on a lease another run of the same release holds.

Publishing holds the lease while it posts and saves right after, so each piece recorded once is
never posted twice. A job killed by the runner between a network accepting a post and the save
(seconds) would lose that record; the local install, writing to Postgres at once, does not have this
window.

## The AI provider in CI: the API through the AI SDK

claudio runs Claude Code under the owner's subscription on the owner's machine; it does not run in
Actions. Action mode uses the **SDK providers** ([decisions/ai-providers.md](ai-providers.md)):
`ANTHROPIC_API_KEY` selects `anthropicProvider` (model `SHIPCAST_AI_MODEL`, Claude Opus by default), or
`SHIPCAST_AI_BASE_URL` (with `SHIPCAST_AI_API_KEY`, `SHIPCAST_AI_MODEL`) an OpenAI-compatible server. The
pack is written with the read-only **repo tools** over the release's checkout on the runner
(`list_files`, `read_file`, `search`, `git_log`), the path the SDK providers already take, so the
article is still written from the code. Every task uses that provider, whatever the AI settings in
the registry say (they may name claudio); the edited prompts and the tone override in the registry's
settings still apply.

## The networks' credentials: Actions secrets on the existing names

Each network reads the variables `.env` already had for it, through `credentialsFromEnv`
(`packages/runtime/src/catalog.ts`): `DEVTO_API_KEY`, `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`,
`MASTODON_INSTANCE` and `MASTODON_ACCESS_TOKEN`, `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN`,
`BREVO_API_KEY`, `HASHNODE_TOKEN` and `HASHNODE_PUBLICATION_HOST`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID` and `TELEGRAM_NOTIFY_CHAT_ID`, `DISCORD_WEBHOOK_URL`, the Cloudflare analytics trio,
`BING_WEBMASTER_API_KEY`, and the Search Console key as `GOOGLE_SERVICE_ACCOUNT_JSON` (written to a
temporary file for `GOOGLE_SERVICE_ACCOUNT_FILE`, since a secret is text, not a file). They count for
the launches repo's brand: in CI there is one brand, so `SHIPCAST_ENV_BRAND` is set to it. A network
without its secrets is not published to, as locally. There are no connected accounts in CI.

## The GitHub token

The run needs to read the project repo, write the launches repo (the drafts' branch and pull request,
and the state branch) and, on approval, read it again.

- **The GitHub App** is the recommended identity, as locally ([decisions/github-app.md](github-app.md)):
  either `SHIPCAST_GITHUB_APP_ID` and `SHIPCAST_GITHUB_APP_PRIVATE_KEY` as secrets, from which the
  run mints the installation token for the launches repo's owner itself, or a token minted before the
  step by `actions/create-github-app-token` and given as `SHIPCAST_GITHUB_TOKEN`. Drafts are then by
  the App's bot, and its pull requests start the launches repo's own checks.
- **`GITHUB_TOKEN`** only reaches the repo its workflow runs in, so it cannot open the drafts pull
  request from a project repo. It is accepted as the last fallback, which works for the launches
  repo's own publish workflow.

## The approval flow does not change

- **A project repo** (`templates/shipcast-release.yml`) runs `ci launch` on `release: published`, on
  `public` (the repo made public) and on `workflow_dispatch` with a tag (a manual launch, which
  `launch.yml`'s `triggers.manual` must allow, and which retries a failed launch). `launch.yml` is read
  at the tag and decides as always: a pre-release, `enabled: false` or a trigger turned off is
  ignored.
- **The launches repo** (`templates/shipcast-publish.yml`) runs `ci publish` when a drafts pull request
  (`launch/*`) is merged: it publishes that launch, polling for the deploy every 30 seconds for up to
  20 minutes, as the queue's retries do locally. A closed pull request skips the launch. The same
  workflow runs `ci round` every hour and by hand: whatever is ready (a scheduled piece now due, a
  channel to retry, a launch whose deploy took longer), and with `--detect` it also polls the brand's
  public events like `shipcast watch`, which claims a release whose own workflow did not run.

## Related

[[plans/goal-after-mvp.md]] · [[plans/after-mvp.md]] · [[plans/shipcast.md]] · [[engine.md]] · [[decisions/postgres.md]] · [[decisions/job-queue.md]] · [[decisions/github-app.md]] · [[decisions/ai-providers.md]] · [[launch-yml.md]] · [[launches-repo.md]] · [[publishing.md]]