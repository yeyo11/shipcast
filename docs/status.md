---
created_at: 2026-10-24T12:26:39.832440804Z
updated_at: 2026-10-24T12:43:52.904622248Z
tags:
    - status
    - roadmap
---
# Status

**Phase 0, foundations** ([plan](plans/shipcast.md#phase-0-foundations)).

Done on 2026-10-24: the repository exists and is public at
[github.com/yeyo11/shipcast](https://github.com/yeyo11/shipcast) — MIT, pnpm monorepo on TypeScript
and Node >= 22, the same stack as claudio — with the agent setup copied from claudio: `CLAUDE.md`,
pando as the knowledge base and code index ([knowledge-base.md](knowledge-base.md)), the
`write-knowledge-doc` skill, and Sluice gates for `typecheck` and `test`. CI
(`.github/workflows/ci.yml`) runs install, audit, typecheck and test on every pull request and on
main. `.env.example` lists the secrets phase 1 will read.

There is no code yet, so the gates pass without checking anything. The first package sets the
template the others follow: a `tsconfig.json` extending `tsconfig.base.json`, and tests run with
Node's test runner through `tsx --test test/*.test.ts`, as in claudio.

Next in phase 0:

- Define the `launch.yml` schema and the JSON content pack, as the first package (`packages/schema`).
- Check and reserve the name (GitHub organisation, npm, domain); fallback LaunchLoop.
- Create the launches repo with the Astro blog on GitHub Pages.
- Create the dev.to and Hashnode accounts.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[launch-yml]] · [[content-pack]]
