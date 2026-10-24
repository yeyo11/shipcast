# Contributing to Shipcast

Thanks for your interest. Shipcast is pre-alpha: until the MVP (phase 1 of the
[roadmap](docs/plans/shipcast.md#roadmap)) the maintainer commits straight to `main` and the design
still moves, so the most useful contributions right now are **issues**: a channel you would want, a
launch you do by hand today, a part of the design that looks wrong.

If you want to send code, open an issue first so we can agree on the approach before you spend time
on it.

## Setup

```bash
git clone https://github.com/yeyo11/shipcast.git
cd shipcast
corepack enable        # pnpm at the version pinned in package.json
pnpm install
cp .env.example .env   # only the tokens the phase you run needs
```

Node 22 or newer.

## Checks

```bash
pnpm typecheck
pnpm test
```

CI runs both, plus `pnpm audit`, on every pull request and on `main`.

## Conventions

- **TypeScript strict**, no `any`, and `noUncheckedIndexedAccess` respected.
- **Comments explain why**, not what.
- **English** for everything technical: code, comments, docs, commit messages.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:` …): the changelog will be built from
  them. Pull requests are squash-merged.
- **Every feature and decision gets a document** under `docs/` (plans in `docs/plans/`, decisions in
  `docs/decisions/`) in the same pull request, ending with a `## Related` list of `[[wiki links]]`;
  [docs/knowledge-base.md](docs/knowledge-base.md) explains the format.
- **No secrets in the repo.** Tokens live in `.env`; redact them from logs you paste.
- **Generated content tells the truth.** Anything that writes launch content must distinguish what a
  project implements from what it only plans or documents.

## Code of conduct

By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).
