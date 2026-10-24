---
created_at: 2026-10-24T19:52:47.046194694Z
updated_at: 2026-10-24T21:32:37.943240974Z
tags:
    - launches-repo
    - blog
    - astro
    - github-pages
    - privacy
    - domain
    - analytics
    - seo
    - newsletter
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
  `https://josegarrido.dev/<lang>/<slug>/` (each language with its own slug, in its own words), and
  the dev.to copies point to it, so `site` and published slugs never change without a redirect. The
  move was made before the first article, so no canonical URL had to be redirected. The custom domain
  is set in the repo's Pages settings, HTTPS is enforced (certificate for the apex and `www`), `www`
  and the old `yeyo11.github.io/launches/` answer `301` to the domain, and the DNS lives in
  Cloudflare: four `A` and four `AAAA` records to GitHub Pages and a `CNAME` for `www`, all DNS-only
  (not proxied), because GitHub must issue the certificate and `.dev` requires HTTPS. The first deploy
  after setting the domain was cancelled, likely by the Pages build GitHub starts when a domain is
  set; a manual `workflow_dispatch` re-ran it.
- **Bilingual**: Astro i18n with `en` (default) and `es`, both prefixed; `/` redirects to `/en/` at
  once (a page of its own with a zero-second refresh) and stays out of the sitemap. Each page links its
  translation when it exists.
- **RSS per language** (`/<lang>/rss.xml`) and a sitemap.
- **Paths in each language's words** since 2026-10-24, as Google advises for multilingual sites:
  `/en/privacy/` and `/es/privacidad/`, `/en/subscribed/` and `/es/suscrito/` (`pagePath` in
  `src/site.ts`; the pages render shared components under `src/components/pages/`), and one slug per
  language for articles. `/es/privacy/`, published before, redirects. Every language version lists
  itself, the other one and English as `x-default` in `hreflang`.
- **The newsletter form** (`src/components/Subscribe.astro`), on the home page's blue band and after
  each article: the blog's own form, posting to the language's Brevo form (double opt-in) from
  `brand.yml`'s `newsletter.forms`, with Brevo's hidden trap field for bots and the answer shown in
  place; without JavaScript it is a plain form post. The confirmation link lands on `/subscribed/`,
  kept out of search and the sitemap ([publishing.md](publishing.md#the-newsletter)).
- **Its own 404** (`src/pages/404.astro`), which GitHub Pages serves for every missing path: both
  languages in one page, showing the one the URL asks for before the first paint, with the house
  illustration (a shipping label, "Return to sender") and the latest launches. A static site has no
  other error page.
- **Marks:** the favicon (the italic J over the green rule) and the `jg` monogram are Fraunces
  outlines in SVG, so they render the same without the font, with PNGs at 16, 32 and 180 px.
- **Drawn covers:** a project (`cover` in `src/projects.ts`) or an article (`cover` in its front
  matter) can carry a drawn cover that replaces the CSS illustration; claudio has one.
- **The owner's own identity**: the editorial one ([personal-identity.md](personal-identity.md)),
  live since 2026-10-24, after the rejected "blackboard"; before both, the site wore Shipcast's tokens
  while it was only the launches blog. Night theme by default, day on a toggle, stored in
  `localStorage` and applied by an inline script before the first paint. Code blocks carry both Shiki
  themes as CSS variables and follow the page. The home page is titled with the owner's name, every
  other page `<page> | José Antonio Garrido`.
- **The brand** is described in `brand.yml` at the root ([brands.md](brands.md)); the site reads it
  for the author, the profile links (with `rel="me"`), the support link in the footer, the analytics
  token and the newsletter's forms.
- **Visits are counted with Cloudflare Web Analytics** since 2026-10-24: cookieless, no local
  storage, no fingerprinting; the beacon loads only in production builds, with the site token from
  `brand.yml` (`analytics.cloudflareWebAnalytics`; public, it ships in every page). The site was
  created through the Cloudflare API as a host-based site (`josegarrido.dev`, no auto-install, since
  the DNS is not proxied). Shipcast reads these numbers back for its metrics
  ([decisions/mvp-scope.md](decisions/mvp-scope.md)).
- **Privacy policy** at `/en/privacy/` and `/es/privacidad/`
  (`src/components/pages/PrivacyPage.astro`), added on 2026-10-24 because Meta requires its URL to
  create the Instagram app: what Shipcast accesses (the owner's own accounts,
  `instagram_business_basic` and `instagram_business_content_publish`), that it stores tokens only
  locally and collects nothing about anyone else, that the blog sets no cookies and counts visits
  with Cloudflare Web Analytics (what it records and why), and how to delete data (`#data-deletion`,
  also the URL for Meta's data deletion field). Contact: `yeyochico@gmail.com`, as the owner asked.
  Since 2026-10-24 it covers the newsletter too (only the address and its language are kept, Brevo
  processes them, double opt-in, open and click tracking, one-click unsubscribe). Linked from the
  footer and from the newsletter form. Update it, and its date, whenever a connector starts accessing
  something new.

## The contract with Shipcast

What Shipcast writes there, and the content pack has to produce:

- **Articles** at `src/content/posts/<en|es>/<slug>.md`, each language under its own slug, paired by
  `translationKey` ([content-pack.md](content-pack.md#one-slug-per-language)). Front matter,
  validated at build time by `src/content.config.ts`: `title`, `description` (at most 200
  characters), `pubDate`, optional `updatedDate`, `lang` (`en` or `es`), `translationKey` (shared by
  both language versions), `repo` (the project's URL), optional `version`, `tags`, `draft`, `image`
  (the launch image's path, the page's `og:image`) and `cover` (a drawn cover).
- **The other channels' pieces** at `launches/<project>/<ref>/`: one readable draft per channel and
  `pack.json` ([engine.md](engine.md)).
- **The launch's media** at `public/launches/<project>/<ref>/` (`og.png`, `og.jpg`, `demo.mp4`), served
  by the site once merged, since Instagram fetches media from a public URL at publishing time
  ([publishing.md](publishing.md)).

## Checks

`pnpm check` (`astro check`, which needs TypeScript 6: it refuses 7, so this repo pins `typescript@^6`
while Shipcast uses 7), `pnpm build`, and `node scripts/contrast.mjs` after any colour change.

## Related

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[plans/design-system.md]] · [[plans/stack.md]] · [[brands.md]] · [[personal-identity.md]] · [[content-pack.md]] · [[engine.md]] · [[publishing.md]]
