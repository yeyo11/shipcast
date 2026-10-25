---
created_at: 2026-10-25T00:01:59.561130176Z
updated_at: 2026-10-25T00:17:58.32574231Z
tags:
    - status
    - roadmap
---
# Status

**Phase 0, foundations, done**; **phase 1, the local MVP: its first real launch went out on 2026-10-25** ([plan](plans/shipcast.md#roadmap), ticked the same day).
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
  blog live at <https://josegarrido.dev> and deployed on every push to `main`
  ([launches-repo.md](launches-repo.md)). Its `brand.yml` names the brand's site, where articles live.
- **claudio** runs from `docker-compose.yml` ([claudio.md](claudio.md)), signed in to Claude.
- **Search and analytics**: Google Search Console property `josegarrido.dev` verified by DNS, sitemap
  submitted, `robots.txt` pointing to it; Cloudflare Web Analytics counting visits on the blog. The
  Meta app's privacy policy URL points to `https://josegarrido.dev/en/privacy/`.
- **Every credential of the MVP** — Brevo, GitHub (with repo traffic), claudio, dev.to, Instagram
  (with insights and comments), Bluesky, Mastodon, Cloudflare's analytics API and a Search Console
  service account — is in the owner's `.env` and answered when tested. Accounts, expiry dates and
  machine details are in the owner's local notes, not in the public docs.

**Code:**

- `packages/schema` (2026-10-24): `LaunchConfig` ([launch-yml.md](launch-yml.md)), `Brand`
  ([brands.md](brands.md)) and `ContentPack` ([content-pack.md](content-pack.md)) in Zod 4, YAML errors
  with their line, `missingPieces`, pack inference from semver, one slug per language, and the JSON
  Schema for Claude (draft-07). It set the package template (`tsconfig.json` extending the base with
  `erasableSyntaxOnly`, `exports` pointing at `src/index.ts`, tests on `node:test` run by Node's type
  stripping).
- `packages/engine` (2026-10-24, [engine.md](engine.md)): the launch registry on `node:sqlite`, launch
  detection from the account's public GitHub events, claudio as the AI provider, and the pipeline from
  a claimed launch to its drafts pull request (fresh clone, prompt with the brand and the truth rule,
  read-only tools, pack validated and complete, articles and per-channel drafts, the launch's media,
  one-commit pull request); then publishing once the pull request is merged, the newsletter, and
  metrics collection ([publishing.md](publishing.md)).
- `packages/connectors` (2026-10-24, [publishing.md](publishing.md)): dev.to, Bluesky, Mastodon,
  Instagram (carousel, story, comment) and Brevo (publish and metrics), Cloudflare Web Analytics and
  Search Console readers.
- `packages/assets` (2026-10-24): the 1200×630 launch image and the Instagram carousel and story in
  the blog's editorial identity (Satori and resvg), and the demo GIF as a video over its backdrop with
  ffmpeg.
- `apps/cli` (2026-10-24): `pnpm shipcast launch <repo> [--ref]` (which retries a failed launch),
  `watch` (detect, draft, publish, metrics every 6 h, Instagram token refresh), `publish [--retry
  <channel>]`, `metrics`, `dashboard [--port] [--host]`, `status`, configured from `.env`.

**Design** (2026-10-24, everything merged after the owner tried it running):

- **josegarrido.dev** wears the editorial identity ([personal-identity.md](personal-identity.md)),
  with the author's photo, `og:image` from each launch's image, the `jg` monogram and favicon drawn
  from Fraunces' outlines, claudio's drawn cover, its own 404, the newsletter form, an about page and
  each page's path in its own language ([launches-repo.md](launches-repo.md)); the blackboard identity
  was rejected.
- **Shipcast** has its design system, Cartel ([plans/design-system.md](plans/design-system.md),
  [`design/`](../design/README.md)); the first direction, the signal path, was rejected.

**The newsletter** (2026-10-24) is set up in Brevo and live on the blog: domain verified, lists and
forms per language, confirmation emails in the blog's style
([publishing.md](publishing.md#the-newsletter)). Replies to `me@josegarrido.dev` reach the owner's own
mail server. claudio turned it on (claudio pull request #62).

**The first real launch** (2026-10-25): claudio v0.9.0, drafted by `shipcast launch yeyo11/claudio
--ref v0.9.0` into [launches#1](https://github.com/yeyo11/launches/pull/1) (AI cost $0.45), edited by
the owner in the pull request (out went every "what does not work yet" part, now also out of the
brand's tone), merged, and published by `shipcast publish`: the article in both languages on the
blog, dev.to, Bluesky, Mastodon, Instagram and the newsletter in both languages; the Reddit drafts are
for the owner to post. Every metrics source answered (Mastodon once the owner widened its token's
scopes). The owner judged the test a success, with Instagram as the weakest result: Instagram became a
carousel with a story and a comment ([publishing.md](publishing.md#the-launchs-media)), and claudio's
launch was published again in that format the same day (the first Reel removed by the owner).
`watch` runs only when the owner starts it: running it as a service was declined on 2026-10-25. The
Instagram bio links to the blog's home page, where the newest launch comes first; a dynamic "link in
bio" page was offered and declined.

What the first run found, each fixed and tested:

- `workspace/` was created by Docker as root, so the clone failed; it now belongs to the owner's user.
- claudio exports `CLAUDIO_API_URL` and `CLAUDIO_API_TOKEN` to the sessions it runs, and `.env` does
  not override the environment, so a Shipcast started from claudio reached the desktop app: Shipcast
  now reads `SHIPCAST_CLAUDIO_URL` and `SHIPCAST_CLAUDIO_TOKEN`.
- Claude Code's `--json-schema` refuses draft 2020-12: the pack's schema is draft-07.
- Brevo's free plan refuses a tagged campaign: the newsletter goes untagged.
- A failed launch could not be retried: a manual `launch` now retries it, and
  `publish --retry <channel>` retries a channel that failed for good.

Waiting on the owner:

- Post the Reddit drafts by hand, after reading each subreddit's self-promotion rules (r/opensource
  wants the Promotional flair).
- Upload Shipcast's social preview (`design/social-preview.png`) to the GitHub repo settings.
- Decide on the stale worktree `worktree-agent-a04f1c5741bdcf80d` (the rejected signal-path design
  assets): delete it or keep it as history.

Next in code:

- One source for the project colours, generated covers per article, the subreddits' flairs in
  `launch.yml`, the pre-flight check (license, README, release), and the dashboard in Cartel.
- Then the rest of the roadmap ([plans/shipcast.md](plans/shipcast.md#roadmap)): the company brand,
  Hashnode, Show HN and Product Hunt, and phase 6 (other AI providers, the GitHub Action mode,
  documentation and Shipcast's own launch).

## Related

[[plans/shipcast.md]] · [[knowledge-base.md]] · [[decisions/main-until-mvp.md]] · [[decisions/mvp-scope.md]] · [[plans/stack.md]] · [[claudio.md]] · [[plans/design-system.md]] · [[launches-repo.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[brands.md]] · [[personal-identity.md]] · [[engine.md]] · [[publishing.md]]
