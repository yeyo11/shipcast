---
created_at: 2026-10-24T17:09:41.922777203Z
updated_at: 2026-10-24T17:20:05.794985518Z
tags:
    - launches-repo
    - blog
    - astro
    - github-pages
    - privacy
    - domain
    - analytics
---
# The launches repo

[`yeyo11/launches`](https://github.com/yeyo11/launches), created on 2026-10-24, is the personal
brand's launch blog and the owner's personal site, live at **<https://josegarrido.dev>**. It is the
second repository of the [approval flow](plans/shipcast.md#approval): Shipcast opens a pull request
there with a launch's drafts, and merging it publishes the article and lets Shipcast distribute the
rest. It is a repo of its own, not a folder of `yeyo11/shipcast`, because Shipcast is a product other
developers install with their own launches repo, approvals need pull requests (which `shipcast` does
without until the MVP, [decisions/main-until-mvp.md](decisions/main-until-mvp.md)), and a merge there
means *publish*.

## What it is

- **Astro 7, static**, deployed to GitHub Pages by `.github/workflows/deploy.yml` (the official
  `withastro/action` and `actions/deploy-pages`) on every push to `main`. Pages is set to build from
  workflows. Node 24.22.1 through `.nvmrc` and pnpm's `useNodeVersion`, as in Shipcast.
- **Served at `https://josegarrido.dev`**, the owner's domain, since 2026-10-24: `site:
  'https://josegarrido.dev'`, no `base`, trailing slashes. Every canonical URL is
  `https://josegarrido.dev/<lang>/<slug>/`, and the dev.to copies point to it, so `site` and published
  slugs never change without a redirect. The move was made before the first article, so no canonical
  URL had to be redirected. The custom domain is set in the repo's Pages settings, HTTPS is enforced
  (certificate for the apex and `www`), `www` and the old `yeyo11.github.io/launches/` answer `301` to
  the domain, and the DNS lives in Cloudflare: four `A` and four `AAAA` records to GitHub Pages and a
  `CNAME` for `www`, all DNS-only (not proxied), because GitHub must issue the certificate and `.dev`
  requires HTTPS. The first deploy after setting the domain was cancelled, likely by the Pages build
  GitHub starts when a domain is set; a manual `workflow_dispatch` re-ran it.
- **Bilingual**: Astro i18n with `en` (default) and `es`, both prefixed; `/` redirects to `/en/` at
  once (a page of its own with a zero-second refresh) and stays out of the sitemap. Each page links its
  translation (`hreflang`) when it exists.
- **RSS per language** (`/<lang>/rss.xml`) and a sitemap.
- **The owner's own identity**: the "blackboard" ([personal-identity.md](personal-identity.md)) is
  live since 2026-10-24 but was rejected by the owner the same day, and a new identity is being
  designed; it stays until the replacement is validated running. It replaced Shipcast's tokens,
  which the site wore while it was only the launches blog. Night theme by default, day on a toggle,
  stored in `localStorage` and applied by an inline script before the first paint. Code blocks carry
  both Shiki themes as CSS variables and follow the page. The home page is titled with the owner's
  name, every other page `<page> | José Antonio Garrido`.
- **The brand** is described in `brand.yml` at the root ([brands.md](brands.md)); the site reads it
  for the author, the profile links (with `rel="me"`), the support link in the footer and the
  analytics token.
- **Visits are counted with Cloudflare Web Analytics** since 2026-10-24: cookieless, no local
  storage, no fingerprinting; the beacon loads only in production builds, with the site token from
  `brand.yml` (`analytics.cloudflareWebAnalytics`; public, it ships in every page). The site was
  created through the Cloudflare API as a host-based site (`josegarrido.dev`, no auto-install, since
  the DNS is not proxied). Shipcast reads these numbers back for its metrics
  ([decisions/mvp-scope.md](decisions/mvp-scope.md)).
- **Privacy policy** at `/<lang>/privacy/` (`src/pages/[lang]/privacy.astro`), added on 2026-10-24
  because Meta requires its URL to create the Instagram app: what Shipcast accesses (the owner's own
  accounts, `instagram_business_basic` and `instagram_business_content_publish`), that it stores
  tokens only locally and collects nothing about anyone else, that the blog sets no cookies and counts
  visits with Cloudflare Web Analytics (what it records and why, updated 2026-10-24), and how to
  delete data (`#data-deletion`, also the URL for Meta's data deletion field). Contact:
  `yeyochico@gmail.com`, as the owner asked. Linked from the footer. Update it, and its date, whenever
  a connector starts accessing something new.

## The contract with Shipcast

What Shipcast writes there, and the content pack has to produce:

- **Articles** at `src/content/posts/<en|es>/<slug>.md`. Front matter, validated at build time by
  `src/content.config.ts`: `title`, `description` (at most 200 characters), `pubDate`, optional
  `updatedDate`, `lang` (`en` or `es`), `translationKey` (shared by both language versions), `repo`
  (the project's URL), optional `version`, `tags`, `draft`.
- **The other channels' pieces** at `launches/<project>/<version>/`, in a format still to be defined
  by the content pack schema.
- **Images for Instagram** (the OG image as JPEG, a demo as MP4) must end up public on this site,
  since Instagram fetches media from a public URL at publishing time
  ([decisions/mvp-scope.md](decisions/mvp-scope.md)).

## Checks

`pnpm check` (`astro check`, which needs TypeScript 6: it refuses 7, so this repo pins `typescript@^6`
while Shipcast uses 7) and `pnpm build`.

## Related

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[plans/design-system.md]] · [[plans/stack.md]] · [[brands.md]] · [[personal-identity.md]] · [[content-pack.md]]
