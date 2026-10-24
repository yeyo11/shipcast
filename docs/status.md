---
created_at: 2026-10-24T16:06:01.965618408Z
updated_at: 2026-10-24T16:14:30.382129094Z
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
is on `PATH` — the owner's nvm default is still 22 for other projects), in `engines` as
`>=24.22.1`, and with `@types/node` on the 24 line so the types do not offer APIs Node 24 lacks.

The MVP's scope is set ([decisions/mvp-scope.md](decisions/mvp-scope.md)): personal brand only, no
domain, the repo stays under `yeyo11`, the blog in `yeyo11/launches` on GitHub Pages. The technical
stack is confirmed ([plans/stack.md](plans/stack.md)). The MVP publishes on the blog, dev.to, Bluesky,
Mastodon and Instagram and drafts Reddit, through Shipcast's own connectors; Postiz is discarded.

Services, checked on 2026-10-24:

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches) exists, with the Astro
  blog live at <https://yeyo11.github.io/launches/> (empty until the first launch) and deployed on
  every push to `main` ([launches-repo.md](launches-repo.md)).
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)): container healthy, Claude
  Code 2.1.302 signed in with a claude.ai Max account, and the API answers `200` to
  `CLAUDIO_API_TOKEN`.
- **dev.to**: the account `yeyo11` exists and `DEVTO_API_KEY` authenticates against
  `GET /api/users/me`.
- **Instagram**: the Meta app (`INSTAGRAM_APP_ID` 1461361715882703, Instagram API with Instagram
  Login) has a token for `josegarridodev`, a Creator account (`MEDIA_CREATOR`), user id
  `17841416971174400`; `content_publishing_limit` answers with a quota of 100 posts per 24 hours, so
  the publish permission is granted. The token was generated in the app dashboard on 2026-10-24 and
  lasts 60 days: the connector must refresh it before about 2026-12-23. The privacy policy Meta asked
  for is on the blog ([launches-repo.md](launches-repo.md)).
- **Bluesky**: `BLUESKY_APP_PASSWORD` opens a session for `yeyo11.bsky.social`
  (`did:plc:vpgn4ohaml234vdh7ayg6iza`, active).
- **Mastodon**: `MASTODON_ACCESS_TOKEN` belongs to `@yeyo11` on mastodon.social, through an app named
  `shipcast` with the scopes `profile`, `write:media` and `write:statuses`.
- **GitHub**: `GITHUB_TOKEN_PERSONAL` authenticates as `yeyo11` (fine-grained, expires on 2026-11-23).

Every credential of the MVP is in `.env` and answers. `INSTAGRAM_APP_ID`, `BLUESKY_HANDLE` and
`MASTODON_INSTANCE` are not in it: they are public, and the code takes them from `brand.yml` or
defaults (`mastodon.social`) rather than requiring them.

**Code:** `packages/schema` exists (2026-10-24): `LaunchConfig` ([launch-yml.md](launch-yml.md)),
`Brand` ([brands.md](brands.md)) and `ContentPack` ([content-pack.md](content-pack.md)) in Zod 4,
YAML errors with their line, `missingPieces`, pack inference from semver, and the JSON Schema for
Claude. 26 tests on `node:test`, run by Node's native type stripping; it set the package template
(`tsconfig.json` extending the base with `erasableSyntaxOnly`, `exports` pointing at `src/index.ts`).

Waiting on the owner:

- The subreddits for Reddit drafts.
- Confirm the languages of X and LinkedIn, and the tone (phase 5).
- Reserve `shipcast` on npm (free on 2026-10-24).
- Upload the social preview; hand the design briefs on.

Next in code:

- `packages/engine`: release polling, launch registry, claudio client; then `apps/cli`.
- `packages/connectors`: launches repo (drafts pull request), dev.to, Bluesky, Mastodon, Instagram,
  Reddit drafts; and the OG image and demo video Instagram needs.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[decisions/mvp-scope.md]] · [[plans/stack.md]] · [[claudio.md]] · [[plans/design-system.md]] · [[launches-repo.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]]
