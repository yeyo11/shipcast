---
created_at: 2026-10-26T07:30:58.697365263Z
updated_at: 2026-10-26T07:30:58.697365263Z
tags:
    - install
    - cli
    - github-app
    - action-mode
    - phase-11
---
# Installing Shipcast

Built on 2026-10-26 for milestone 7 of the [goal after the MVP](plans/goal-after-mvp.md): the
one-command install and the GitHub Action mode, for developers other than the owner. Shipcast runs in
one of two ways:

- **A local install**: the engine, the web app and the registry's Postgres on a machine of yours
  (a laptop, or a server once it has an address). This is how the owner runs it.
- **Action mode**: no machine at all; the same engine runs in GitHub Actions
  ([decisions/action-mode.md](decisions/action-mode.md)).

## A local install, in one command

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/shipcast/main/scripts/install.sh | sh
```

`scripts/install.sh` checks for git, Node 24 (with corepack, for pnpm) and Docker, clones Shipcast
into `./shipcast` (`SHIPCAST_DIR` chooses another folder), installs it and runs `shipcast init`,
passing on its arguments. In a clone, `pnpm shipcast init` does the same.

### What `shipcast init` does

1. **Writes the bootstrap `.env`**: only what the app needs before anyone signs in
   ([decisions/github-app.md](decisions/github-app.md)): the registry's database URL and a random
   Postgres password, a random token for claudio (docker compose refuses to start any service
   without it), the GitHub login allowed to sign in, and the app's address. With an https address
   (`--public-url https://host`), the app serves it with a Let's Encrypt certificate through Cloudflare
   DNS (its token goes in `.env`). Without one, the app runs on this machine over plain HTTP
   (`SHIPCAST_APP_TLS=off`, `127.0.0.1:8744`) and the owner signs in with the one-time link it prints
   at start; GitHub sign-in needs an https address.
2. **Starts the registry's Postgres** (`docker compose up -d --wait postgres`); `--skip-docker` leaves
   it to the owner, who then points `SHIPCAST_DATABASE_URL` at their own.
3. **Creates the owner's GitHub App from a manifest**: a page on this machine posts Shipcast's
   manifest to GitHub (permissions: contents, pull requests and discussions write, metadata read;
   events: release, pull request, repository, push), the owner presses **Create** there, and GitHub
   sends them back with a code that `init` exchanges for the App's id, client id, client secret,
   webhook secret and private key. The key goes to `data/github-app.pem` (mode 600), the rest to
   `.env`, and the owner lands on installing the App on the repos Shipcast should see. Webhooks are
   only turned on when the address is public; otherwise Shipcast polls. `--skip-github-app` leaves it
   for later.

**An existing install is never touched**: when `.env` already holds an install's settings, `init`
says so and stops. Everything else (the launches repo and `brand.yml`, the AI provider, the channels,
measurement, automation) is set in the web app's onboarding, after `pnpm app`.

| Flag | Does |
| --- | --- |
| `--public-url <https://host>` | The app's address, where GitHub signs the owner in |
| `--login <login>` | The GitHub account allowed to sign in |
| `--skip-docker` | Postgres is the owner's own |
| `--skip-github-app` | Create the App later |
| `--yes` | Ask nothing; take the flags and the defaults |

## Action mode

`shipcast ci launch | publish | round` runs headless in a workflow, configured by the environment
only, with the registry kept as a JSON snapshot on the launches repo's `shipcast-state` branch and a
lease so a launch still happens once across repos
([decisions/action-mode.md](decisions/action-mode.md)). What a developer copies:

- **In each project repo**: `templates/shipcast-release.yml` as `.github/workflows/shipcast.yml`. On a
  published release (or a repo made public, or a run by hand) it drafts the launch as a pull request
  in the launches repo.
- **In the launches repo**: `templates/shipcast-publish.yml`, which publishes a launch when its drafts
  pull request is merged, and can run a scheduled round.
- **Secrets and variables**: `SHIPCAST_LAUNCHES_REPO` (a variable), the GitHub App's id and private
  key, the AI key (`ANTHROPIC_API_KEY`, or an OpenAI-compatible server's URL, key and model), and each
  network's credentials under the names `.env.example` lists. claudio does not run in Actions, so the
  content is written through the API with read-only tools over the release's checkout.

Both templates call the reusable workflow `.github/workflows/shipcast.yml` of this repo, which wraps
the composite action at its root (`action.yml`). `shipcast ci --dry-run` shows what a run would do
without writing anything: no state pushed, no AI call, no pull request, no post.

## Related

[[decisions/action-mode.md]] · [[decisions/github-app.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[accounts.md]] · [[launches-repo.md]]
