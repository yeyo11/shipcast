---
created_at: 2026-10-24T16:41:30.950321489Z
updated_at: 2026-10-24T16:56:17.703629885Z
tags:
    - status
    - roadmap
---
# Status

**Phase 0, foundations, done** except reserving the name on npm; **phase 1, the local MVP, starts**
([plan](plans/shipcast.md#roadmap)). Of phase 0: the repo, the `launch.yml` and content pack schemas,
the launches repo with its blog and the dev.to account are in place; Hashnode left the MVP.

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
is on `PATH`), in `engines` as `>=24.22.1`, and with `@types/node` on the 24 line so the types do not
offer APIs Node 24 lacks.

The MVP's scope is set ([decisions/mvp-scope.md](decisions/mvp-scope.md)): personal brand only, the
repo stays under `yeyo11`, the blog in `yeyo11/launches` on GitHub Pages at `josegarrido.dev`. The
technical stack is confirmed ([plans/stack.md](plans/stack.md)). The MVP publishes on the blog,
dev.to, Bluesky, Mastodon and Instagram and drafts Reddit, through Shipcast's own connectors; Postiz
is discarded.

Services, set up on 2026-10-24:

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches) exists, with the Astro
  blog live at <https://josegarrido.dev> (empty until the first launch, HTTPS enforced) and deployed
  on every push to `main` ([launches-repo.md](launches-repo.md)).
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)), signed in to Claude.
- **Every credential of the MVP** — GitHub, claudio, dev.to, Instagram, Bluesky and Mastodon — is in
  the owner's `.env` and answered when tested. Accounts, expiry dates and machine details are in the
  owner's local notes, not in the public docs.

**Code:** `packages/schema` exists (2026-10-24): `LaunchConfig` ([launch-yml.md](launch-yml.md)),
`Brand` ([brands.md](brands.md)) and `ContentPack` ([content-pack.md](content-pack.md)) in Zod 4,
YAML errors with their line, `missingPieces`, pack inference from semver, and the JSON Schema for
Claude. 26 tests on `node:test`, run by Node's native type stripping; it set the package template
(`tsconfig.json` extending the base with `erasableSyntaxOnly`, `exports` pointing at `src/index.ts`).

**Design, in progress on branches** (2026-10-24): the owner's personal visual identity for
`josegarrido.dev`, and Shipcast's design system assets under `design/` (tokens, logo, channel icons,
social preview, specimen). Both are proposals: nothing reaches `main` or goes live until the owner
validates it.

Waiting on the owner:

- Validate the two design proposals once they are ready.
- The subreddits for Reddit drafts.
- Point the Meta app's privacy policy URL to `https://josegarrido.dev/en/privacy/`.
- Reserve `shipcast` on npm (free on 2026-10-24).
- Upload the social preview.

Next in code:

- `packages/engine`: release polling, launch registry, claudio client; then `apps/cli`.
- `packages/connectors`: launches repo (drafts pull request), dev.to, Bluesky, Mastodon, Instagram,
  Reddit drafts; and the OG image and demo video Instagram needs.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[decisions/mvp-scope.md]] · [[plans/stack.md]] · [[claudio.md]] · [[plans/design-system.md]] · [[launches-repo.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]]
