---
created_at: 2026-10-26T07:37:46.160887007Z
updated_at: 2026-10-27T17:34:31.086344807Z
tags:
    - install
    - cli
    - github-app
    - action-mode
    - github-action
    - phase-11
---
# Installing Shipcast

Built on 2026-10-26 for milestone 7 of the [goal after the MVP](plans/goal-after-mvp.md): the
one-command install and the GitHub Action mode, for developers other than the owner. Shipcast runs in
one of two ways:

- **A local install**: the engine, the web app and the registry's Postgres on a machine of yours
  (a laptop, or a server once it has an address). This is how the owner runs it.
- **The GitHub Action**: no machine at all; the same engine runs in GitHub Actions on your own repos,
  set up by `npx @yeyo11/shipcast init` ([getting-started.md](getting-started.md),
  [decisions/github-action.md](decisions/github-action.md)).

## A local install, in one command

```bash
curl -fsSL https://raw.githubusercontent.com/yeyo11/shipcast/main/scripts/install.sh | sh
```

`scripts/install.sh` checks for git, Node 24 (with corepack, for pnpm) and Docker, clones Shipcast
into `./shipcast` (`SHIPCAST_DIR` chooses another folder), installs it and runs `shipcast init`,
passing on its arguments. In a clone, `pnpm shipcast init` does the same: inside Shipcast's own
checkout `init` is the local install, anywhere else it is the GitHub Action setup (`--local` and
`--action` choose explicitly).

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

## The GitHub Action

`shipcast ci launch | publish | round` runs headless in a workflow, configured by the environment
only, with the registry kept as a JSON snapshot on the launches repo's `shipcast-state` branch and a
lease so a launch still happens once across repos ([decisions/action-mode.md](decisions/action-mode.md)).
Since 2026-10-27 it is packaged for other developers ([decisions/github-action.md](decisions/github-action.md)):

- **The Action** is [yeyo11/shipcast-action](https://github.com/yeyo11/shipcast-action) (`v1`), a
  composite action with the bundled CLI and its lockfile committed. Its sources are `action/` here;
  `pnpm --filter @shipcast/cli build:action <dir>` builds the CLI and assembles the Action's repo in
  `<dir>`.
- **The CLI** is `@yeyo11/shipcast` on npm, built by `pnpm --filter @shipcast/cli build` into
  `apps/cli/dist-npm` (esbuild bundles the workspace packages; third-party ones stay dependencies).
- **The setup** is `npx @yeyo11/shipcast init` in a project repo: `.github/launch.yml` and the launch
  workflow there, `brand.yml` and the publish workflow in the launches repo, and the secrets to set.
  `templates/` holds the two workflows as `init` writes them.
- **The AI** is `SHIPCAST_AI_PROVIDER` (`anthropic` or `openai`, a repository variable) with its key as
  a secret; `fake` writes a placeholder pack for tests. The networks' credentials are secrets of the
  launches repo, under the names `.env.example` lists. claudio does not run in Actions.

`--dry-run` (the Action's `dry-run` input, or the variable `SHIPCAST_DRY_RUN=true` in the workflows
`init` writes) publishes nothing: no state pushed, no AI call, no pull request, no post, and publishing
lists what each channel would do.

## Related

[[getting-started.md]] · [[decisions/github-action.md]] · [[decisions/action-mode.md]] · [[decisions/github-app.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[accounts.md]] · [[launches-repo.md]]