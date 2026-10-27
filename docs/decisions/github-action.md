---
created_at: 2026-10-27T17:35:17.741040395Z
updated_at: 2026-10-27T17:35:17.741040395Z
tags:
    - decision
    - github-action
    - ci
    - npm
    - install
    - registry
    - phase-11
---
# Decision: Shipcast for other developers, as a GitHub Action and an npm command

Taken on 2026-10-27, building milestone 3 of [plans/goal-v0.2.md](../plans/goal-v0.2.md) (phase 11
of [plans/after-mvp.md](../plans/after-mvp.md)). [decisions/action-mode.md](action-mode.md) built the
headless engine (`shipcast ci`, the registry on a state branch, secrets from the environment) inside
this monorepo; it ran only from a checkout of it. This decision makes it something **another
developer installs on their own repos**, with no Postgres, no keychain, no claudio and no copy of the
monorepo: a published Action, a CLI on npm, and one command that writes the setup. The guide for
those developers is [getting-started.md](../getting-started.md).

The owner's own install (local engine, Postgres, keychain, claudio, the web app) does not change: it
keeps running from the checkout with `pnpm shipcast` and `pnpm app`, and none of what follows is on
its path.

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| The CLI | npm, `@yeyo11/shipcast` (`shipcast` is taken), bin `shipcast` | The monorepo's CLI, bundled: `npx @yeyo11/shipcast init`, `shipcast ci …` |
| The Action | `yeyo11/shipcast-action`, public, `v1` | `action.yml` (composite) plus the same built package and its lockfile |
| The setup | `shipcast init` in the developer's project repo | `.github/launch.yml`, `brand.yml`, the two workflows, and the secrets to set |

The Action's sources live here, in `action/`; `pnpm --filter @shipcast/cli build:action <dir>` builds
the package and assembles the Action's repository from it, so the two are always the same code. The
composite `action.yml` that was at this repo's root and the reusable workflow
`.github/workflows/shipcast.yml` that wrapped it (never tagged, never called) are replaced by it, and
`templates/` holds the two workflows exactly as `shipcast init` writes them (a test keeps them equal).

## The AI: an SDK provider, chosen by a variable

claudio runs Claude Code under the owner's subscription on the owner's machine; it does not exist for
anyone else. CI uses the **SDK providers** ([decisions/ai-providers.md](ai-providers.md)), which
already read the release's checkout through the read-only repo tools, so the article is still
written from the code:

- `SHIPCAST_AI_PROVIDER` picks one: **`anthropic`** (the Anthropic API, `claude-opus-5-5` by default)
  or **`openai`** (the OpenAI API through `@ai-sdk/openai`, `gpt-5.5` by default), or
  `openai-compatible` (any server speaking that API, with `SHIPCAST_AI_BASE_URL`). The workflow reads
  it from a **repository variable** of the same name, so switching providers is a setting, not an edit.
- The key is a **repository secret**: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, passed to the Action
  as `ai-api-key` (it reaches the CLI as `SHIPCAST_AI_API_KEY`). `SHIPCAST_AI_MODEL` (the `ai-model`
  input) overrides the model.
- Without `SHIPCAST_AI_PROVIDER` the old rule still holds (`ANTHROPIC_API_KEY` set means Anthropic,
  `SHIPCAST_AI_BASE_URL` an OpenAI-compatible server, a lone `OPENAI_API_KEY` OpenAI), so nothing
  configured before breaks.
- **`fake`** is for tests only: a deterministic provider (`fakePackProvider`,
  `packages/engine/src/fake-ai.ts`) that writes a placeholder pack (every channel launch.yml turns on,
  every piece saying no model wrote it) from the launch, `launch.yml` and the brand, with no network.
  It is how the Action is tested end to end without an API key, and how a developer can see the drafts
  pull request's shape before paying for a call. It is never a default.

The OpenAI API gets its own SDK provider rather than the OpenAI-compatible one because OpenAI's
current models refuse the `max_tokens` parameter Chat Completions servers take; `@ai-sdk/openai`
speaks the Responses API and its parameters. Its strict JSON Schema mode is turned off, since the
pack's schema has optional fields, which strict mode refuses.

## Network credentials: repository secrets, never the keychain

Each network reads the variables `.env` already had for it (`credentialsFromEnv`, as in
[action-mode.md](action-mode.md)): `DEVTO_API_KEY`, `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD`,
`MASTODON_INSTANCE` and `MASTODON_ACCESS_TOKEN`, `HASHNODE_TOKEN`, `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `BREVO_API_KEY`, `INSTAGRAM_USER_ID` and
`INSTAGRAM_ACCESS_TOKEN`. They are **secrets of the launches repo**, mapped to `env:` by its publish
workflow; the project repos need none, since drafting publishes nothing. A network without its
secrets is not published to, and the run says so. The networks that need an OAuth sign-in in the
app (Reddit, LinkedIn, Threads) are not offered in Action mode: there is no app to sign in through.
GitHub Discussions needs nothing beyond the GitHub token.

## The GitHub token

Another developer has no Shipcast GitHub App, so the default identity is a **fine-grained personal
access token**, the secret `SHIPCAST_GITHUB_TOKEN`, scoped to the project repos and the launches repo:
Contents read and write, Pull requests read and write, Discussions read and write (for GitHub
Discussions). The project repo's workflow needs it, since its own `GITHUB_TOKEN` cannot write to
another repo; the launches repo's workflow uses it too, and falls back to its own `GITHUB_TOKEN`
(with `contents: write`) when it is not set. A GitHub App (`github-app-id` and
`github-app-private-key`) stays supported for whoever prefers one.

## A launch happens once, without a database

The record lives **in the launches repo's files**: the `shipcast-state` orphan branch, as
[action-mode.md](action-mode.md) built it. Its `registry.json` holds every launch (repo, ref, status,
pull request), every published piece and the cursors, restored into an in-process PGlite on each run;
nothing is a server, nothing needs to be reachable. A launch is claimed on `(repo, ref)` and the claim
is **pushed before any AI runs**, under a lease (`lock.json`) taken by a push without force, so a
re-run, a second workflow, the hourly round or a manual launch of the same release all find it
claimed and stop with `already-launched`, whichever repo they run in.

The brief suggested a record file per launch. One snapshot was kept instead because a launch is more
than its claim: publishing must also know which pieces went out and where (so a retried channel is
never posted twice), the scheduled pieces and the round's cursors, and the engine already reads all of
that through the registry. Files per launch would mean a second registry implementation for CI only;
the snapshot reuses the real schema and SQL, and every run's change is still a readable diff in the
branch's history.

## The drafts pull request and publishing on merge

Unchanged from the local engine, which is the point: the same `draftLaunch` and `publishOne` run
behind the registry and secrets abstraction (`CiState`, `SecretStore`, the environment's credentials):

1. The **project repo's workflow** (`release: published`, and `workflow_dispatch` with a tag) runs
   `ci launch`: reads `.github/launch.yml` at the tag, claims the release, writes the pack with the
   chosen AI and opens the **drafts pull request** in the launches repo.
2. The **launches repo's workflow** runs `ci publish` when a `launch/*` pull request is **merged**:
   the article is the merge itself, and every other channel publishes in the mode `launch.yml` gives
   it (`auto`, `approval`, `off`) once the article is live; a pull request closed without merging
   publishes nothing. The same workflow runs `ci round` hourly for scheduled pieces and retries.

### Dry run

The Action's `dry-run` input (or the repository variable `SHIPCAST_DRY_RUN=true`, which the workflows
`init` writes read) publishes **nothing**: `ci launch --dry-run` claims nothing, asks no AI and opens
no pull request; `ci publish --dry-run` and `ci round --dry-run` read the state into a scratch copy and
list, launch by launch and channel by channel (`channelPlan`), its mode and whether it would publish or
which secrets it lacks, then throw the copy away. Only variable names are looked at, never a value. A
dry run never writes the state branch.

## The CLI on npm: bundled, its dependencies installed

The workspace packages are TypeScript sources that Node runs by stripping types, which Node refuses
to do under `node_modules`, so they cannot be published as they are. The package is built with
**esbuild** (`apps/cli/scripts/build.ts`): one ESM file with every `@shipcast/*` package inside it,
and every third-party package left **external** and declared as a dependency (with the range the
workspace uses, read from its package.json files), installed by npm as usual.

- **Not one self-contained file**: the dependencies include a native module (`@resvg/resvg-js`, one
  prebuilt binary per platform), PGlite's WebAssembly and data files, and `playwright-core`; npm's
  own resolution of optional platform packages is what makes them work, and bundling them would break
  exactly that.
- **Not seven packages on npm**: they would version and publish together anyway, and none is meant to
  be used alone.
- The files the code finds next to itself are shipped beside the bundle at the same relative places:
  the fonts the images are drawn with (`dist/fonts/`) and the registry's migrations (`drizzle/`).
- The workspace's security overrides (`pnpm-workspace.yaml`) are copied as npm `overrides`, which npm
  honours where the package is the root project: the Action's install.
- Outside Shipcast's checkout the CLI offers `init`, `ci`, `mcp` and `--version`; the local install's
  commands say they need the checkout.
- `npm pack` of the built directory, installed into an empty directory, must run `shipcast --help`:
  that is the build's proof.

## The Action: the same build, pinned

`yeyo11/shipcast-action` is a **composite action**: `actions/setup-node` with Node 24, then
`npm ci --omit=dev --ignore-scripts` in the action's own directory (the built package and its
lockfile are committed there), then `shipcast ci`. Shipping the build in the Action rather than
running `npx @yeyo11/shipcast` means a `v1` tag pins the exact code and the lockfile pins every
dependency, the Action works whether or not the npm package is published yet, and no install script
of any dependency runs on the user's runner. Its inputs are documented in its README; secrets reach
it as inputs (`github-token`, `ai-api-key`) or as `env:` (the networks).

## `shipcast init` for another developer

`npx @yeyo11/shipcast init` **in a project repo** (`apps/cli/src/setup.ts`) detects the repo from its
`origin` remote (or asks), asks for the launches repo, the brand (id, name, site, languages), the AI
provider and the channels, and writes:

- `.github/launch.yml` and `.github/workflows/shipcast.yml` (the launch on release) in the project;
- `brand.yml` and `.github/workflows/shipcast-publish.yml` (publishing on merge) in the launches
  repo's checkout (`--launches-dir`, or a sibling folder whose `origin` is the launches repo, or
  `shipcast-launches/` to copy over);
- then prints each secret and variable to set, in which repo, with the link to obtain it and the
  `gh secret set` line.

It validates what it writes against the same schemas the engine reads (`parseLaunchConfig`,
`parseBrand`), never overwrites a file that exists (`--force` does) and never writes a secret. Run
**inside Shipcast's own checkout**, `shipcast init` is still the local install it was (`.env`,
Postgres, the GitHub App); `--local` and `--action` choose explicitly.

## Proven on 2026-10-27

- **npm**: `npm pack` of `apps/cli/dist-npm` (`@yeyo11/shipcast@0.2.0`, 254 kB, 30 files), installed
  into an empty directory with `npm install <tarball>`: `shipcast --help`, `--version`, `ci --help`
  run; `init` in an empty git repo with a GitHub `origin` writes the four files and the secrets list.
- **The Action**: `yeyo11/shipcast-action` created public, tagged `v1.0.0` and `v1`, with its first
  release. A throwaway project (`yeyo11/shipcast-action-test`) and launches repo
  (`yeyo11/shipcast-action-test-launches`), both set up by the packed `init`, ran it with the **fake
  provider**: a release opened a real drafts pull request (the article, four channel drafts,
  `pack.json`, the cover and the launch images, so the fonts, PGlite and the migrations work from the
  bundle); a re-run and a manual launch of the same tag stopped with "launched already"; a dry-run
  launch of another release claimed nothing; merging the drafts pull requests ran the publish workflow
  in dry run, which listed each channel and the secrets it lacked and posted nothing.
- **Not run end to end**: the real Anthropic and OpenAI paths, since no API key was available to the
  run. They are the SDK providers the app already uses, tested with the AI SDK's mock model; the
  first launch with a real key is the owner's or a developer's.

## Rejected

- **A JavaScript action (`runs.using: node24`) bundling everything**: GitHub runs such an action with
  no install step, so the native and WebAssembly dependencies would have to be inlined, which is the
  bundle rejected above.
- **A Docker action**: a minute of image pull on every run and Linux runners only, for nothing the
  composite action lacks.
- **The Action calling `npx @yeyo11/shipcast@1`**: unpinned dependencies on every run, and untestable
  before the owner publishes to npm.

## Related

[[decisions/action-mode.md]] · [[decisions/ai-providers.md]] · [[decisions/github-app.md]] · [[getting-started.md]] · [[install.md]] · [[plans/goal-v0.2.md]] · [[plans/after-mvp.md]] · [[launch-yml.md]] · [[launches-repo.md]] · [[publishing.md]] · [[engine.md]]