---
created_at: 2026-10-24T19:52:49.06779029Z
updated_at: 2026-10-24T20:21:27.495385421Z
tags:
    - status
    - roadmap
---
# Status

**Phase 0, foundations, done**; **phase 1, the local MVP, built and waiting for its first real launch** ([plan](plans/shipcast.md#roadmap)).
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
([decisions/main-until-mvp.md](decisions/main-until-mvp.md)). The design system is in
[plans/design-system.md](plans/design-system.md).

Node is pinned to **24.22.1**, the LTS current on 2026-10-24: in `.nvmrc` (which CI reads through
`node-version-file`), in pnpm's `useNodeVersion` (so every `pnpm` script runs on it, whatever Node
is on `PATH`), in `engines` as `>=24.22.1`, and with `@types/node` on the 24 line so the types do not
offer APIs Node 24 lacks.

The MVP's scope is set ([decisions/mvp-scope.md](decisions/mvp-scope.md)): personal brand only, the
repo stays under `yeyo11`, the blog in `yeyo11/launches` on GitHub Pages at `josegarrido.dev`. The
technical stack is confirmed ([plans/stack.md](plans/stack.md)). The MVP publishes on the blog,
dev.to, Bluesky, Mastodon, Instagram and a newsletter (through Brevo, added on 2026-10-24), and drafts
Reddit (for claudio: r/ClaudeAI, r/selfhosted, r/SideProject, r/opensource), through Shipcast's own
connectors; Postiz is discarded. Metrics are in the MVP too.

Services, set up on 2026-10-24:

- **The launches repo** [`yeyo11/launches`](https://github.com/yeyo11/launches) exists, with the Astro
  blog live at <https://josegarrido.dev> (empty until the first launch, HTTPS enforced) and deployed
  on every push to `main` ([launches-repo.md](launches-repo.md)). Its `brand.yml` names the brand's
  site, where articles live.
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)), signed in to Claude.
- **Search and analytics**: Google Search Console property `josegarrido.dev` verified by DNS, sitemap
  submitted, `robots.txt` pointing to it; Cloudflare Web Analytics counting visits on the blog. The
  Meta app's privacy policy URL points to `https://josegarrido.dev/en/privacy/`.
- **Every credential of the MVP but the newsletter's** — GitHub (with repo traffic), claudio, dev.to,
  Instagram (with insights), Bluesky, Mastodon, Cloudflare's analytics API and a Search Console service
  account — is in the owner's `.env` and answered when tested. Accounts, expiry dates and machine
  details are in the owner's local notes, not in the public docs.

**Code:**

- `packages/schema` (2026-10-24): `LaunchConfig` ([launch-yml.md](launch-yml.md)), `Brand`
  ([brands.md](brands.md)) and `ContentPack` ([content-pack.md](content-pack.md)) in Zod 4, YAML errors
  with their line, `missingPieces`, pack inference from semver, and the JSON Schema for Claude. 27
  tests. It set the package template (`tsconfig.json` extending the base with `erasableSyntaxOnly`,
  `exports` pointing at `src/index.ts`, tests on `node:test` run by Node's type stripping).
- `packages/engine` (2026-10-24, [engine.md](engine.md)): the launch registry on `node:sqlite`, launch
  detection from the account's public GitHub events, claudio as the AI provider, and the pipeline from
  a claimed launch to its drafts pull request (fresh clone, prompt with the brand and the truth rule,
  read-only tools, pack validated and complete, articles and per-channel drafts, the launch's media,
  one-commit pull request); then publishing once the pull request is merged, the newsletter, and
  metrics collection ([publishing.md](publishing.md)). 58 tests; the GitHub reads, a claudio
  generation and the rendered articles (in a real build of the blog) were also checked for real.
- `packages/connectors` (2026-10-24, [publishing.md](publishing.md)): dev.to, Bluesky, Mastodon,
  Instagram and Brevo (publish and metrics), Cloudflare Web Analytics and Search Console readers.
  17 tests. The newsletter is built and tested with fakes; Brevo is not set up yet.
- `packages/assets` (2026-10-24): the 1200×630 launch image in the blog's editorial identity
  (Satori and resvg) and the demo GIF turned into an Instagram Reel with ffmpeg. 3 tests.
- `apps/cli` (2026-10-24): `pnpm shipcast launch <repo> [--ref]`, `watch` (detect, draft, publish,
  metrics every 6 h, Instagram token refresh), `publish`, `metrics`, `dashboard`, `status`, configured
  from `.env`. 10 tests. On 2026-10-24 `status` reports every network and source configured with the
  owner's `.env` (dev.to, Bluesky, Mastodon, Instagram, GitHub with traffic, Cloudflare Web Analytics,
  Search Console), and each metrics source answered live; nothing has been published yet.

**Design** (2026-10-24, both merged after the owner tried them running):

- **josegarrido.dev** wears the editorial identity ([personal-identity.md](personal-identity.md)),
  live since 2026-10-24, with the author's photo and `og:image` from each launch's image; the
  blackboard identity it replaced was rejected.
- **Shipcast** has its design system, Cartel ([plans/design-system.md](plans/design-system.md),
  [`design/`](../design/README.md)); the first direction, the signal path, was rejected.

Waiting on the owner:

- Try the blog's `design/assets-v2` branch running (the jg monogram, the favicon redrawn from the
  font's outlines, claudio's drawn cover) and approve it.
- The newsletter: a Brevo account and its API key in `.env`, and a double opt-in subscription form
  created in Brevo; then the sender domain is verified (DNS in Cloudflare), the lists created, the
  form added to the blog with an updated privacy policy, and a test issue sent.
- Upload Shipcast's social preview (`design/social-preview.png`) to the GitHub repo settings.
- Merge claudio's release pull request (#59, v0.8.2), the first release with its `launch.yml`, and
  give the go-ahead for the first real launch.

Next in code:

- claudio's `launch.yml` with `newsletter: approval`, before the v0.8.2 release is cut.
- The first real launch: claudio v0.8.2, end to end, with the owner reviewing the drafts pull request
  before anything is published.
- Later: generated covers (an optional `cover` field in the blog's post schema), one source for the
  project colours, and the dashboard in Cartel.

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[decisions/mvp-scope.md]] · [[plans/stack.md]] · [[claudio.md]] · [[plans/design-system.md]] · [[launches-repo.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[personal-identity.md]] · [[engine.md]] · [[publishing.md]]
