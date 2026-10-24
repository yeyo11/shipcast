---
created_at: 2026-10-24T12:53:39.547837253Z
updated_at: 2026-10-24T13:12:34.405317495Z
tags:
    - status
    - roadmap
---
# Status

**Phase 0, foundations** ([plan](plans/shipcast.md#phase-0-foundations)).

Done on 2026-10-24: the repository exists and is public at
[github.com/yeyo11/shipcast](https://github.com/yeyo11/shipcast) — MIT, pnpm monorepo on TypeScript
and Node 24 LTS, the same stack as claudio — with the agent setup copied from claudio: `CLAUDE.md`,
pando as the knowledge base and code index ([knowledge-base.md](knowledge-base.md)), the
`write-knowledge-doc` skill, and Sluice gates for `typecheck` and `test`. CI
(`.github/workflows/ci.yml`) runs install, audit, typecheck and test on every pull request and on
main. `.env.example` lists the secrets phase 1 will read. Work goes straight to `main` until the MVP
([decisions/main-until-mvp.md](decisions/main-until-mvp.md)). The design direction and the briefs
for the design system are in [plans/design-system.md](plans/design-system.md).

Node is pinned to **24.22.1**, the LTS current on 2026-10-24: in `.nvmrc` (which CI reads through
`node-version-file`), in pnpm's `useNodeVersion` (so every `pnpm` script runs on it, whatever Node
is on `PATH` — the owner's nvm default is still 22 for other projects), in `engines` as
`>=24.22.1`, and with `@types/node` on the 24 line so the types do not offer APIs Node 24 lacks.

There is no code yet, so the gates pass without checking anything. The first package sets the
template the others follow: a `tsconfig.json` extending `tsconfig.base.json`, and tests run with
Node's test runner through `tsx --test test/*.test.ts`, as in claudio.

Next in phase 0:

- Define the `launch.yml` schema and the JSON content pack, as the first package (`packages/schema`).
- Hand the design briefs to a designer and to Claude Design; record the result in `design-system.md`.
- Check and reserve the name (GitHub organisation, npm, domain); fallback LaunchLoop.
- Create the launches repo with the Astro blog on GitHub Pages.
- Create the dev.to and Hashnode accounts.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[plans/design-system.md]] · [[launch-yml]] · [[content-pack]]
