---
created_at: 2026-10-24T18:09:54.605888861Z
updated_at: 2026-10-24T18:21:45.248422631Z
tags:
    - status
    - roadmap
---
# Status

**Phase 0, foundations, done**; **phase 1, the local MVP, in progress** ([plan](plans/shipcast.md#roadmap)).
Of phase 0: the repo, the `launch.yml` and content pack schemas, the launches repo with its blog and
the dev.to account are in place, and the name is reserved on npm (`shipcast@0.0.0`, published by the
owner on 2026-10-24); Hashnode left the MVP.

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
dev.to, Bluesky, Mastodon and Instagram and drafts Reddit (for claudio: r/ClaudeAI, r/selfhosted,
r/SideProject, r/opensource), through Shipcast's own connectors; Postiz is discarded. Metrics are in
the MVP too.

Services, set up on 2026-10-24:

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches) exists, with the Astro
  blog live at <https://josegarrido.dev> (empty until the first launch, HTTPS enforced) and deployed
  on every push to `main` ([launches-repo.md](launches-repo.md)). Its `brand.yml` names the brand's
  site, where articles live.
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)), signed in to Claude.
- **Search and analytics**: Google Search Console property `josegarrido.dev` verified by DNS, sitemap
  submitted, `robots.txt` pointing to it; Cloudflare Web Analytics counting visits on the blog. The
  Meta app's privacy policy URL points to `https://josegarrido.dev/en/privacy/`.
- **Every credential of the MVP** — GitHub, claudio, dev.to, Instagram (with insights), Bluesky and
  Mastodon — is in the owner's `.env` and answered when tested. Accounts, expiry dates and machine
  details are in the owner's local notes, not in the public docs.

**Code:**

- `packages/schema` (2026-10-24): `LaunchConfig` ([launch-yml.md](launch-yml.md)), `Brand`
  ([brands.md](brands.md)) and `ContentPack` ([content-pack.md](content-pack.md)) in Zod 4, YAML errors
  with their line, `missingPieces`, pack inference from semver, and the JSON Schema for Claude. 26
  tests. It set the package template (`tsconfig.json` extending the base with `erasableSyntaxOnly`,
  `exports` pointing at `src/index.ts`, tests on `node:test` run by Node's type stripping).
- `packages/engine` (2026-10-24, [engine.md](engine.md)): the launch registry on `node:sqlite`, launch
  detection from the account's public GitHub events, claudio as the AI provider, and the pipeline from
  a claimed launch to its drafts pull request (fresh clone, prompt with the brand and the truth rule,
  read-only tools, pack validated and complete, articles and per-channel drafts, one-commit pull
  request). 42 tests; the GitHub reads, a claudio generation and the rendered articles (in a real
  build of the blog) were also checked for real.
- `apps/cli` (2026-10-24): `pnpm shipcast launch <repo> [--ref]`, `watch`, `status`, configured from
  `.env`. 3 tests. Checked live up to the point where claudio's latest release, `v0.8.1`, has no
  `launch.yml`.

**Design** (2026-10-24): the "blackboard" identity went live on `josegarrido.dev` and the owner
rejected it ([personal-identity.md](personal-identity.md)); a replacement is being designed by an
external agent. Shipcast's design system assets (tokens, logo, channel icons, social preview,
specimen under `design/`) are ready on a local branch; the owner is not convinced by them and is
getting a second opinion from another agent. Nothing visual reaches `main` until the owner has seen
it running.

Waiting on the owner:

- The new design for `josegarrido.dev`, handed by the owner to an external agent; and a second opinion
  on Shipcast's design system, which the owner is not convinced by.
- Upload the social preview, once Shipcast's design system is settled.
- Merge claudio pull request #60 (its `launch.yml`), and cut a claudio release after it.

Next in code:

- The first real launch: claudio once its `launch.yml` (claudio pull request #60) is merged and a
  release includes it.
- Publishing after the merge of a drafts pull request.
- `packages/connectors`: dev.to, Bluesky, Mastodon, Instagram (the drafts pull request is already in
  the engine); and the OG image and demo video Instagram needs.
- Metrics, now in the MVP: one connector per source (blog analytics, Search Console, GitHub, dev.to,
  Bluesky, Mastodon, Instagram), stored per launch and channel, and a dashboard.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[decisions/mvp-scope.md]] · [[plans/stack.md]] · [[claudio.md]] · [[plans/design-system.md]] · [[launches-repo.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[personal-identity.md]] · [[engine.md]]
