---
created_at: 2026-10-24T13:47:38.42677389Z
updated_at: 2026-10-24T14:00:50.485944281Z
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
main. Work goes straight to `main` until the MVP
([decisions/main-until-mvp.md](decisions/main-until-mvp.md)). The design direction and the briefs
for the design system are in [plans/design-system.md](plans/design-system.md).

Node is pinned to **24.22.1**, the LTS current on 2026-10-24: in `.nvmrc` (which CI reads through
`node-version-file`), in pnpm's `useNodeVersion` (so every `pnpm` script runs on it, whatever Node
is on `PATH` — the owner's nvm default is still 22 for other projects), in `engines` as
`>=24.22.1`, and with `@types/node` on the 24 line so the types do not offer APIs Node 24 lacks.

The MVP's scope is set ([decisions/mvp-scope.md](decisions/mvp-scope.md)): personal brand only, no
domain, the repo stays under `yeyo11`, the blog in `yeyo11/launches` on GitHub Pages. The technical
stack is proposed in [plans/stack.md](plans/stack.md), waiting for the owner's confirmation.

Services, checked on 2026-10-24:

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches) exists, with the Astro
  blog live at <https://yeyo11.github.io/launches/> (empty until the first launch) and deployed on
  every push to `main` ([launches-repo.md](launches-repo.md)).
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)): container healthy, Claude
  Code 2.1.302 signed in with a claude.ai Max account, and the API answers `200` to
  `CLAUDIO_API_TOKEN`.
- **dev.to**: the account `yeyo11` exists and `DEVTO_API_KEY` authenticates against
  `GET /api/users/me`.

There is no code yet, so the gates pass without checking anything.

Waiting on the owner:

- Confirm the stack.
- `GITHUB_TOKEN_PERSONAL` in `.env` (still empty).
- The personal brand's details: display name, handles per network, default languages, tone.
- Reserve `shipcast` on npm (free on 2026-10-24).
- Upload the social preview; hand the design briefs on.

Next in code:

- `packages/schema`: `launch.yml`, brand config and content pack, once the stack is confirmed.
- `packages/engine`: release polling, launch registry, claudio client; then `apps/cli`.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[decisions/mvp-scope.md]] · [[plans/stack.md]] · [[claudio.md]] · [[plans/design-system.md]] · [[launches-repo.md]] · [[launch-yml]] · [[content-pack]]
