# Shipcast

**Ship** + broad**cast**: launch your GitHub projects without writing the same announcement ten times.

[![CI](https://github.com/yeyo11/shipcast/actions/workflows/ci.yml/badge.svg)](https://github.com/yeyo11/shipcast/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)
[![Buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/yeyo11)

You publish a release. Shipcast reads the project's **code**, not just its README, writes a launch
post tailored to every channel, and publishes each one after you approve it: the article on your
blog, a canonical copy on dev.to and Hashnode, an X thread, a LinkedIn post, ready-to-paste Show HN
and Reddit drafts, and a demo GIF and OG image to go with them.

> [!IMPORTANT]
> Shipcast is in **phase 0**: the design is done and the repository is set up, but nothing runs yet.
> Everything below describes what is being built. Follow [the roadmap](docs/plans/shipcast.md#roadmap)
> and [where it stands](docs/status.md), or watch the repo for the first release.

## Why

Launching a side project well takes longer than the last commit did: one article, a thread with the
link in the right place, a different tone for LinkedIn, a Show HN that does not read like an ad, a
GIF, and then remembering which channel actually brought anyone. Most projects get none of it, or
the same paragraph pasted everywhere.

Shipcast turns that into a pull request you review.

## How it will work

1. **Opt in per repo.** A `.github/launch.yml` turns launches on and picks the brand, the language,
   the content pack and a publishing mode for each channel:

   ```yaml
   # .github/launch.yml
   enabled: true
   brand: personal
   language: en

   publishing:
     blog: auto          # publish without asking
     x: approval         # publish once you approve
     linkedin: approval
     reddit: manual      # a draft for you to paste
     hackerNews: manual
   ```

2. **Trigger.** A published release or `shipcast launch <repo>`; optionally a repo going public or
   `enabled: true` landing on an old one. The local engine polls the GitHub API, so it needs no
   webhooks and exposes nothing.
3. **Analyse.** Claude reads the repository and separates what is implemented from what is only
   planned or documented, so the content never promises a feature that does not exist.
4. **Generate.** One structured JSON content pack per launch, with a piece written for each channel,
   in English and Spanish.
5. **Approve.** The drafts arrive as a pull request in your launches repo, which is also your blog's
   source. Edit them with commits or from GitHub's web editor; merging publishes.
6. **Publish and measure.** Each channel follows its mode, every launch is recorded so it never runs
   twice, and stars, traffic, views and clicks per channel end up in one dashboard.

## Roadmap

| Phase | Delivers |
| --- | --- |
| 0 · Foundations | Repository, `launch.yml` and content pack schemas, Astro blog |
| 1 · Local MVP | Release detection, analysis, drafts as a pull request, blog and dev.to with canonical URLs |
| 2 · Networks and brands | Hashnode, Bluesky, Mastodon, X, LinkedIn, per-brand tone, per-channel modes |
| 3 · Assets | Demo GIFs (VHS, Playwright), OG images, screenshots |
| 4 · Dashboard | Metrics from every channel, approval from the browser |
| 5 · Communities | Show HN, Reddit, Product Hunt, newsletter, Telegram, Discord |
| 6 · For everyone | Swappable AI providers, a GitHub Action mode, one-command install |

The last test of phase 6 is Shipcast's own launch, generated and published by Shipcast. The full
design, with every decision and the reasoning behind it, is in
[docs/plans/shipcast.md](docs/plans/shipcast.md).

## Built with

TypeScript on Node 24 LTS in a pnpm monorepo. The AI provider is
[claudio](https://github.com/yeyo11/claudio), which runs Claude Code as a service; the Anthropic API
and the Claude Code GitHub Action join it in phase 6.

## Contributing

Ideas and bug reports are welcome as [issues](https://github.com/yeyo11/shipcast/issues). Until the
MVP the code moves fast and straight on `main`, so please open an issue before a pull request; see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © Jose Antonio Garrido
