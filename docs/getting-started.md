---
created_at: 2026-10-27T17:33:42.976520284Z
updated_at: 2026-10-27T17:34:11.777935329Z
tags:
    - guide
    - getting-started
    - github-action
    - install
    - npm
    - phase-11
---
# Getting started: Shipcast on your own repos

For developers other than the owner, written on 2026-10-27 with milestone 3 of
[plans/goal-v0.2.md](plans/goal-v0.2.md). Shipcast runs as a **GitHub Action** on your repos, with
your own AI key and your own accounts: no server, no database, nothing to host. The design is
[decisions/github-action.md](decisions/github-action.md); the owner's local install (the web app,
Postgres, the keychain) is [install.md](install.md).

## What happens

1. You publish a release of a project.
2. The project's workflow runs [Shipcast Launch](https://github.com/yeyo11/shipcast-action): it reads
   the code at the release's tag, has the AI (Anthropic or OpenAI) write the article in your blog's
   languages and a post for each channel you turned on, and opens a **drafts pull request** in your
   **launches repo**. Every piece says what the code does, not what the README promises.
3. You read the drafts, edit them in the pull request if you like, and **merge** it. The merge
   publishes the article on your blog; the launches repo's workflow then publishes every other channel
   once the article is live.
4. The release is recorded on the launches repo's `shipcast-state` branch: a re-run, a second workflow
   or a manual launch of the same release does nothing. **A launch happens once.**

## What you need

- **A project repo** on GitHub, with releases.
- **A launches repo**: your blog, deployed at an `https://` address. Shipcast writes each article as
  Markdown at `src/content/posts/<en|es>/<slug>.md` with front matter (`title`, `description`,
  `pubDate`, `lang`, `translationKey`, `repo`, `tags`, `image`), the posts at
  `launches/<project>/<tag>/` and the images at `public/launches/<project>/<tag>/`; an Astro content
  collection reads it as it is ([launches-repo.md](launches-repo.md) is the full contract). It can be a
  new, empty repo while you try it.
- **An AI key**: [Anthropic](https://console.anthropic.com/settings/keys) or
  [OpenAI](https://platform.openai.com/api-keys).
- **A GitHub token**: a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
  for the project repos and the launches repo, with Contents, Pull requests and Discussions read and
  write. The workflow's own token cannot write to another repo.
- **Node 24** to run `npx` once.

## Set it up

In your project's checkout (with the launches repo cloned beside it, if you have it, so `init` writes
its files there):

```bash
npx @yeyo11/shipcast init
```

It detects the project from `origin`, asks for the launches repo (`<you>/launches` by default), your
blog's address, your name, the blog's languages (`en`, `es` or both), the AI and the channels, and
writes:

| File | Repo | What it does |
| --- | --- | --- |
| `.github/launch.yml` | project | Whether and how the project is launched: each channel `auto`, `approval` or `off` ([launch-yml.md](launch-yml.md)) |
| `.github/workflows/shipcast.yml` | project | On `release: published`, or run by hand with a tag: `launch` |
| `brand.yml` | launches | Who the launches speak for: name, site, languages, tone ([brands.md](brands.md)) |
| `.github/workflows/shipcast-publish.yml` | launches | When a `launch/*` pull request is merged: `publish`; hourly: `round` |

Without a checkout of the launches repo beside the project, its two files go to `shipcast-launches/`
for you to copy over (or pass `--launches-dir <path>`). `init` never overwrites a file (`--force`
does), never writes a secret, and asks nothing with `--yes` (flags and defaults: `init --help`).

Then commit the files in both repos and set what `init` printed, each with the link to get it:

| Name | Kind | Repo | What it is |
| --- | --- | --- | --- |
| `SHIPCAST_GITHUB_TOKEN` | secret | project (and launches) | The fine-grained token; the launches repo falls back to its own workflow token |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | secret | project | The AI's key; only drafting uses it |
| `SHIPCAST_AI_PROVIDER` | variable | project | `anthropic` or `openai`: switch it any time without editing the workflow |
| `SHIPCAST_AI_MODEL` | variable, optional | project | Another model than `claude-opus-5-5` or `gpt-5.5` |
| each channel's | secrets | launches | `DEVTO_API_KEY`; `BLUESKY_HANDLE`, `BLUESKY_APP_PASSWORD`; `MASTODON_INSTANCE`, `MASTODON_ACCESS_TOKEN`; `HASHNODE_TOKEN`, `HASHNODE_PUBLICATION_HOST`; `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; `DISCORD_WEBHOOK_URL` |
| `SHIPCAST_DRY_RUN` | variable, optional | either | `true` publishes nothing (below) |

`init` prints the `gh secret set NAME --repo owner/name` line for each, which reads the value from
the terminal so it never lands in your shell's history.

## Try it without publishing anything

Set the variable `SHIPCAST_DRY_RUN=true` in both repos (or tick **dry-run** when you run a workflow by
hand). A dry run publishes nothing and records nothing:

- **launch** says what it would claim, which AI it would draft with and where the pull request would
  go; it asks no AI and opens nothing.
- **publish** and **round** list, channel by channel, its mode and whether it would publish or is
  skipped for want of its secrets:

  ```text
  blog (approval): would publish; the merge of the drafts pull request publishes it
  devto (approval): skipped; not published: set the secret DEVTO_API_KEY
  githubDiscussions (approval): would publish; posted with the GitHub token
  ```

To see the drafts pull request itself without paying for an AI call, set `SHIPCAST_AI_PROVIDER=fake`
in the project and leave `SHIPCAST_DRY_RUN` on only in the launches repo: the launch opens a real
pull request with placeholder pieces (each says no model wrote it), and merging it publishes nothing.
Do it with a release you will not launch for real: that release counts as launched from then on.

## Launch

Publish a release, or run **Shipcast launch** by hand with a tag. In a few minutes the drafts pull
request is in your launches repo, with the article in each language, one draft per channel and the
launch's images. Merge it: the blog deploys the article, and **Shipcast publish** posts every channel
in `approval` or `auto` mode whose secrets are set, waiting up to 20 minutes for the article to be
live. Close it instead and nothing is published. A channel that failed is retried by the hourly
round.

## Channels in Action mode

| Channel | Needs |
| --- | --- |
| Blog | Nothing: the merge publishes it |
| GitHub Discussions | Nothing: the GitHub token posts it in the project's Discussions |
| dev.to, Hashnode | Their API key (Hashnode also the publication's host); they republish the English article with your blog as canonical |
| Bluesky, Mastodon | An app password, an access token |
| Telegram, Discord | A bot and a channel, a webhook |

Reddit, LinkedIn and Threads sign in through Shipcast's app, so they are not offered in Action mode.
Instagram and the newsletter (Brevo) read secrets too (`INSTAGRAM_USER_ID` and
`INSTAGRAM_ACCESS_TOKEN`, `BREVO_API_KEY`) but need more setup than `init` asks for: turn them on in
`launch.yml` and add their secrets to the publish workflow's `env:` by hand.

## Where things live

- **The launch record**: the `shipcast-state` branch of the launches repo, `registry.json` (launches,
  pieces and where they went) and `lock.json` (which run holds it). Never edit it by hand; it holds no
  secret, but in a public launches repo it is public.
- **Your keys**: repository secrets only. Nothing Shipcast writes contains one.
- **The Action**: [yeyo11/shipcast-action](https://github.com/yeyo11/shipcast-action) at `v1`; its
  README documents every input and output. The CLI behind it is
  [`@yeyo11/shipcast`](https://www.npmjs.com/package/@yeyo11/shipcast) on npm.

## Related

[[decisions/github-action.md]] · [[decisions/action-mode.md]] · [[install.md]] · [[launch-yml.md]] · [[brands.md]] · [[launches-repo.md]] · [[publishing.md]] · [[plans/goal-v0.2.md]]