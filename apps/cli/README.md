# @yeyo11/shipcast

Launch your GitHub projects. On each release, Shipcast reads the code at that tag, has the AI you
choose (Anthropic or OpenAI) write the article and the posts for every channel you turn on, and opens
a **drafts pull request** in your launches repo (your blog). Merging it publishes the article and
every channel, once: a release is never launched twice.

It runs in **GitHub Actions** on your own repos, with your own keys: no server, no database.

```bash
npx @yeyo11/shipcast init
```

Run it in your project's repo. It detects the repo, asks for your launches repo, your blog's
address and the channels, writes:

- `.github/launch.yml` and `.github/workflows/shipcast.yml` (the launch, on each release) in the project,
- `brand.yml` and `.github/workflows/shipcast-publish.yml` (publishing, on merge) in the launches repo,

and prints every secret to set, with the link to get it and the `gh secret set` line.

## Commands

| Command | What it does |
| --- | --- |
| `shipcast init` | The setup above (`--help` for its flags; `--yes` asks nothing) |
| `shipcast ci launch \| publish \| round` | What the Action runs, configured by the environment (`shipcast ci --help`) |
| `shipcast --version` | This version |

## Channels

The blog (the merge), GitHub Discussions, dev.to, Bluesky, Mastodon, Hashnode, Telegram and Discord,
each `auto`, `approval` or `off` in `.github/launch.yml`. A channel publishes once its secrets are set
in the launches repo.

## Links

- The guide: [docs/getting-started.md](https://github.com/yeyo11/shipcast/blob/main/docs/getting-started.md)
- The Action: [yeyo11/shipcast-action](https://github.com/yeyo11/shipcast-action)
- The source: [yeyo11/shipcast](https://github.com/yeyo11/shipcast) (MIT)

Node 24 or later.
