# Shipcast

Automates the launch of GitHub projects: on a release (or a manual launch) it analyses the repo with
Claude, generates a content pack for every channel and publishes it after the owner approves it.
pnpm monorepo, TypeScript, Node 24 LTS (24.22.1, pinned in `.nvmrc` and in pnpm's `useNodeVersion`,
so every `pnpm` script runs on it whatever is on `PATH`) — the same stack as
[claudio](https://github.com/yeyo11/claudio), which is also Shipcast's AI provider. The design and
the roadmap are in [docs/plans/shipcast.md](docs/plans/shipcast.md); where the project stands is in
[docs/status.md](docs/status.md).

## Principles

- **The code is the source of truth, not the README.** Generated content must tell what is
  implemented from what is planned or only documented. An article that promises a feature that does
  not exist is a bug.
- **Nothing is published without its channel's mode.** Each channel is `auto`, `approval` or
  `manual` in the repo's `.github/launch.yml`; Reddit and Hacker News are always drafts.
- **Brands never mix.** The personal brand (yeyo11) and the company brand (josegarridodigio) have
  their own accounts, tone and language.
- **A launch happens once.** Every launch is recorded; re-running a workflow or publishing a minor
  version must not repeat a campaign.
- **Local first.** The engine runs on the owner's laptop, polls the GitHub API (both accounts are user
  accounts, so there are no organisation webhooks) and reaches the outside through Tailscale Serve
  only when needed. The GitHub Action mode comes in phase 6.

## Layout

- `packages/schema` — `launch.yml`, `brand.yml` and the content pack: Zod schemas, line-aware YAML
  errors, the pack's JSON Schema for Claude ([docs/launch-yml.md](docs/launch-yml.md),
  [docs/content-pack.md](docs/content-pack.md))
- `packages/` — the other libraries as they arrive: engine, connectors
- `apps/` — runnable apps (CLI, dashboard)
- `docs/` — the knowledge base: plans in `docs/plans/`, decisions in `docs/decisions/`

## Checks

```bash
pnpm typecheck
pnpm test
```

Both run as [Sluice](.sluice.toml) gates (`typecheck` on pre-commit, `test` on pre-push through
`.githooks/`). An agent verifies through Sluice's `verify` tool, not by running them in the shell.

## Conventions

- TypeScript strict, no `any`, respect `noUncheckedIndexedAccess`.
- Comments explain why, not what.
- Everything technical is English (code, comments, docs, commits, prompts, agent files), even when
  the chat is Spanish. Generated content is produced in Spanish and English; a person's own words
  stay as written.
- Settings-shaped documents (`launch.yml`, brand config) are files; accumulating records (launches,
  metrics) are rows in a database.
- Commits follow Conventional Commits.
- **Until the MVP, work goes straight to `main`**: no feature branches, no pull requests, small
  commits that pass the Sluice gates. Agents running in parallel worktrees keep to their own branch
  and leave the integration into `main` to the maintainer. An agent working on `main` pushes without
  asking, once the commit passes the gates (Sluice runs `test` on pre-push). After the
  MVP, pull requests come back, squash-merged ([docs/decisions/main-until-mvp.md](docs/decisions/main-until-mvp.md)).
- Secrets (API keys, tokens for each network) live in `.env`, never in the repo.

## Knowledge

Write every feature and every decision as a document under `docs/` (plans in `docs/plans/`,
decisions in `docs/decisions/`), in the pull request that builds it, with the
`write-knowledge-doc` skill. **Every document is written through pando's `kb_add_document`**, new
or updated, never with Write or Edit: the tool sets the front matter (dates, tags), mirrors the file
to `docs/` and indexes its links. A hook blocks direct writes to `docs/**/*.md`.
[docs/knowledge-base.md](docs/knowledge-base.md) has the format, the tools and the re-sync.

`docs/` is also a searchable knowledge base, kept by [pando](https://github.com/digiogithub/pando)
(declared in [.mcp.json](.mcp.json)), and the source is indexed by symbol.

**Search it first.** When you are asked anything about this project — what it does, how it works,
where it stands, why something was decided, where something lives — the **first tool call of the
turn is `kb_search_documents`**, followed by `code_hybrid_search` when the answer is in the source
rather than in the docs. Reading files and running git is how you *verify* what the search returned,
or what you fall back to when it returned nothing.

Search unless one of these holds: the user named the exact file, you are looking for a literal
string or a known identifier (that is grep's job), or the turn is pure editing with no question in
it. A search that returns nothing costs one call.

`code_*` results are only as fresh as the last pass, so check the project's `indexing_status` is
`completed` and look at `last_indexed_at` before trusting them against recent commits.
