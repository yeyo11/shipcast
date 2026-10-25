# Shipcast

**Ship** + broad**cast**: launch your GitHub projects without writing the same announcement ten times.

[![CI](https://github.com/yeyo11/shipcast/actions/workflows/ci.yml/badge.svg)](https://github.com/yeyo11/shipcast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)
[![Buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/yeyo11)

You publish a release. Shipcast reads the project's **code**, not just its README, writes a launch
piece for every channel, and publishes each one once you approve it: the article on your blog in
English and Spanish, canonical copies on dev.to and Hashnode, posts on Bluesky, Mastodon, Telegram
and Discord, an Instagram carousel with its story, a newsletter issue, and ready-to-paste Show HN and
Product Hunt drafts. Then it reads back how each channel did.

![Shipcast's app: launches, launching a repo, channels and writing an article](docs/media/tour.gif)

> [!NOTE]
> Shipcast is **alpha**, built for and used by its author: it launched
> [claudio](https://github.com/yeyo11/claudio) v0.9.0 on six channels. It runs on your own machine
> with your own accounts. Installing it for yourself takes some setup today (below); a GitHub Action
> mode and a one-command install are on [the roadmap](docs/plans/shipcast.md#roadmap).

## How it works

1. **Opt in per repo.** A `.github/launch.yml` turns launches on and sets a mode for each channel:
   `approval` (published when you approve), `manual` (a draft for you to post), `auto` or `off`.

   ```yaml
   # .github/launch.yml
   enabled: true
   brand: personal
   publishing:
     blog: approval
     devto: approval
     bluesky: approval
     instagram: approval
     hackerNews: manual   # the Show HN draft
   assets:
     demo: docs/demo.gif
   ```

2. **Trigger.** Publish a release (the engine polls your public GitHub events, no webhooks), or pick a
   repo and a release in the app. A pre-flight check first makes sure there is a release, a valid
   `launch.yml`, a license, a README and the demo.
3. **Analyse.** Claude reads the repository and separates what is implemented from what is only
   planned or claimed by the docs; only the implemented part is presented as working.
4. **Generate.** One structured content pack per launch: the article in each language, a piece written
   for each channel within its limits, the launch image, the Instagram carousel and story, and a cover
   in your blog's style when the project has none.
5. **Approve.** The drafts arrive as a pull request in your launches repo, which is also your blog's
   source. Read and edit every piece in the app or on GitHub; approving merges it and publishes. Or
   skip the review and publish straight away.
6. **Publish and measure.** Each channel is published once, never twice; a failure is retried or left
   for you to retry. Visits by channel, search, stars and traffic, and each post's numbers end up on
   the launch's page. With Telegram connected, you hear when drafts wait and when a launch is out.

You can also **write an article** in the app, in your own words: Shipcast translates it, writes each
channel's piece and publishes it the same way.

## The app

`pnpm app` serves Shipcast's web app on a domain of yours reachable only over your
[Tailscale](https://tailscale.com) network, with its own Let's Encrypt certificate:

- **Launches**: every launch, where it went, what is waiting for you, and its numbers.
- **Channels**: every network, the accounts connected to each (per brand, several per network), what
  Shipcast may do with them, a check of each credential, and OAuth for Mastodon and Instagram. Secrets
  live in your operating system's keychain.
- **Launch a repo** and **Write**, with the choice to review first or publish directly.

Sign-in is with GitHub, limited to the logins you allow. See [docs/web-app.md](docs/web-app.md).

## What you need

- Node 24 and pnpm; on Linux, `libsecret-tools` for the keychain; ffmpeg for the demo video.
- [claudio](https://github.com/yeyo11/claudio), which runs Claude Code as a service, as the AI provider,
  and PostgreSQL for the launch registry (`docker-compose.yml` here starts both; tests need neither).
- A launches repo with an Astro blog that accepts Shipcast's articles
  ([docs/launches-repo.md](docs/launches-repo.md) describes the contract), and its `brand.yml`.
- An account on each network you want, connected from the app or listed in `.env`
  ([.env.example](.env.example)).

```bash
pnpm install
cp .env.example .env             # fill in what you use
docker compose up -d postgres    # the registry; `docker compose up -d` starts claudio too
pnpm shipcast preflight owner/repo
pnpm shipcast launch owner/repo  # or: pnpm app
```

An install from before Postgres keeps its registry in `data/shipcast.db`: stop the app and the CLI,
start Postgres, then `pnpm sqlite-to-postgres` copies every row into the database at
`SHIPCAST_DATABASE_URL` ([docs/decisions/postgres.md](docs/decisions/postgres.md)).

## Channels

| Channel | What Shipcast does |
| --- | --- |
| Blog | Commits the article in each language; the merge publishes it |
| dev.to, Hashnode | Republish the English article with the blog as canonical URL |
| Bluesky, Mastodon | A post with a link card or image |
| Instagram | A carousel (cover, demo video, features, closing), a story and a comment |
| Newsletter (Brevo) | One issue per language, sent to your lists |
| Telegram, Discord | A post to your channel, an embed through a webhook |
| Show HN, Product Hunt | Drafts for you to post: neither has an API to post through |

X, LinkedIn and Reddit are not supported.

## Built with

TypeScript on Node 24 in a pnpm monorepo: `packages/schema` (Zod), `packages/engine` (the registry on
PostgreSQL through Drizzle, detection, generation, publishing), `packages/connectors` (one module per network over
`fetch`, no SDKs), `packages/assets` (Satori and resvg), `packages/runtime` (accounts and keychain),
`apps/cli` and `apps/web` (TanStack Start). The design, with every decision and the reasoning behind
it, is in [docs/plans/shipcast.md](docs/plans/shipcast.md); where it stands, in
[docs/status.md](docs/status.md).

## Contributing

Ideas and bug reports are welcome as [issues](https://github.com/yeyo11/shipcast/issues). Until the
MVP the code moves fast and straight on `main`, so please open an issue before a pull request; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Jose Antonio Garrido
