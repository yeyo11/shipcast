# Shipcast

> **Ship** + broad**cast**: launch your GitHub projects without writing the same announcement ten times.

Shipcast watches your repositories. When you publish a release (or launch by hand), it reads the
project's code — not just its README — with Claude, generates a structured content pack (article,
X thread, LinkedIn post, Show HN and Reddit drafts, demo GIF and OG image) and publishes it to each
channel once you approve it.

**Status:** phase 0, foundations. Nothing runs yet; see [docs/plans/shipcast.md](docs/plans/shipcast.md)
for the design and the roadmap, and [docs/status.md](docs/status.md) for where it stands.

## How it will work

1. A repo opts in with a `.github/launch.yml` that sets the brand, the language, the content pack
   and a publishing mode per channel: `auto`, `approval` or `manual`.
2. The local engine polls the GitHub API for releases (no webhooks, nothing exposed).
3. [claudio](https://github.com/yeyo11/claudio) analyses the repo and returns the content pack as JSON.
4. The drafts land as a pull request in the launches repo, which is also the blog's source: merging
   it publishes the article and fans out to the other channels.
5. Every launch is recorded, so a re-run never repeats a campaign, and its metrics end up in a dashboard.

## License

[MIT](LICENSE)
