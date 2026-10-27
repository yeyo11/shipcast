# Shipcast Launch

Launch a GitHub project on each release. Shipcast reads the code at the release's tag, has the AI you
choose (**Anthropic** or **OpenAI**) write the article and the posts, and opens a **drafts pull
request** in your launches repo (your blog). Merging it publishes the article and every channel you
turned on: dev.to, Bluesky, Mastodon, Hashnode, Telegram, Discord and GitHub Discussions. A release
is launched **once**, whatever re-runs.

No server and no database: the launch record lives on a `shipcast-state` branch of your launches repo,
your keys are repository secrets. Built from [yeyo11/shipcast](https://github.com/yeyo11/shipcast)
(MIT); the design is in its
[decisions/github-action.md](https://github.com/yeyo11/shipcast/blob/main/docs/decisions/github-action.md).

## Set it up in one command

In your project's repo:

```bash
npx @yeyo11/shipcast init
```

It writes `.github/launch.yml` and the launch workflow in the project, `brand.yml` and the publish
workflow for the launches repo, and prints every secret to set with the link to get it. The two
workflows it writes are in [`templates/`](templates).

## By hand

Two workflows, two repos.

**The project repo** (`.github/workflows/shipcast.yml`): on a release, draft the launch.

```yaml
on:
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      tag: { type: string, required: false }
jobs:
  launch:
    runs-on: ubuntu-latest
    steps:
      - uses: yeyo11/shipcast-action@v1
        with:
          command: launch
          launches-repo: you/launches
          github-token: ${{ secrets.SHIPCAST_GITHUB_TOKEN }}
          ai-provider: anthropic            # or openai
          ai-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

**The launches repo** (`.github/workflows/shipcast-publish.yml`): when a drafts pull request is merged,
publish it.

```yaml
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
jobs:
  publish:
    if: github.event.pull_request.merged == true && startsWith(github.event.pull_request.head.ref, 'launch/')
    runs-on: ubuntu-latest
    steps:
      - uses: yeyo11/shipcast-action@v1
        with:
          command: publish
          launches-repo: ${{ github.repository }}
          github-token: ${{ secrets.SHIPCAST_GITHUB_TOKEN || github.token }}
        env:
          DEVTO_API_KEY: ${{ secrets.DEVTO_API_KEY }}
          BLUESKY_HANDLE: ${{ secrets.BLUESKY_HANDLE }}
          BLUESKY_APP_PASSWORD: ${{ secrets.BLUESKY_APP_PASSWORD }}
```

The project's `.github/launch.yml` says what is launched and each channel's mode (`auto`,
`approval` or `off`), and the launches repo's `brand.yml` who speaks
([launch.yml](https://github.com/yeyo11/shipcast/blob/main/docs/launch-yml.md),
[brand.yml](https://github.com/yeyo11/shipcast/blob/main/docs/brands.md)).

## Inputs

| Input | Default | What it is |
| --- | --- | --- |
| `command` | (required) | `launch` (claim a release, open its drafts pull request), `publish` (a merged drafts pull request) or `round` (scheduled pieces and retries) |
| `launches-repo` | (required) | Your launches repo, `owner/name` |
| `github-token` | the workflow's token | A fine-grained token: the project and the launches repo, Contents, Pull requests and Discussions read and write. The workflow's own token only reaches its own repo, so `launch` needs this one |
| `github-app-id`, `github-app-private-key` | | Instead of a token, a GitHub App of yours |
| `ai-provider` | `anthropic` | `anthropic` or `openai`; `openai-compatible` with `ai-base-url`; `fake` writes a placeholder pack, for tests |
| `ai-api-key` | | The AI's key, from a secret; only `launch` needs it |
| `ai-model` | `claude-opus-5-5` / `gpt-5.5` | The model |
| `ai-base-url` | | `openai-compatible` only: the server |
| `repo`, `ref` | the event's | `launch` by hand: the repo and the tag |
| `pull-request` | the event's | `publish`: the merged pull request's URL |
| `detect` | `false` | `round`: also poll your public events for releases no workflow claimed |
| `wait-minutes` | `20` | `publish`: how long to wait for the blog to deploy the article |
| `dry-run` | `false` | **Publishes nothing**: `launch` claims nothing, asks no AI and opens no pull request; `publish` and `round` list what each channel would post and whether its secrets are set. The launch record is not written |

The networks' credentials are `env:` on the step, never inputs: `DEVTO_API_KEY`, `BLUESKY_HANDLE` and
`BLUESKY_APP_PASSWORD`, `MASTODON_INSTANCE` and `MASTODON_ACCESS_TOKEN`, `HASHNODE_TOKEN` and
`HASHNODE_PUBLICATION_HOST`, `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`. A
channel without its secrets is not published to.

## Outputs

| Output | What it is |
| --- | --- |
| `status` | `launch`: `drafted`, `already-launched`, `ignored`, `failed` or `dry-run`; `publish`: `published`, `partial`, `waiting`, `nothing`, `ignored` or `dry-run`; `round`: `done` |
| `launch-id` | The launch's id in the record |
| `pull-request` | `launch`: the drafts pull request's URL |
| `claimed` | `round`: how many releases it claimed |

## What it runs

A composite action: Node 24, then `npm ci` of the bundled Shipcast CLI committed in this repo (the same
build as [`@yeyo11/shipcast`](https://www.npmjs.com/package/@yeyo11/shipcast), every dependency pinned
by `package-lock.json`, no install scripts), then `shipcast ci <command>`. Tags: `v1` follows the
latest `v1.x.y`.

## License

MIT
