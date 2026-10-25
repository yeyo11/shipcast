---
created_at: 2026-10-25T00:01:53.433354998Z
updated_at: 2026-10-25T01:39:48.131645181Z
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
  `/en/privacy/` and `/es/privacidad/`, `/en/subscribed/` and `/es/suscrito/`, `/en/about/` and
  `/es/sobre-mi/` (`pagePath` in `src/site.ts`; the pages render shared components under
  `src/components/pages/`), and one slug per language for articles. `/es/privacy/`, published before,
  redirects. Every language version lists itself, the other one and English as `x-default` in
  `hreflang`.
- **The newsletter form** (`src/components/Subscribe.astro`), on the home page's blue band, after
  each article and on the about page: the blog's own form, posting to the language's Brevo form
  (double opt-in) from `brand.yml`'s `newsletter.forms`, with Brevo's hidden trap field for bots and
  the answer shown in place; without JavaScript it is a plain form post. The confirmation link lands
  on `/subscribed/`, kept out of search and the sitemap ([publishing.md](publishing.md#the-newsletter)).
- **Its own 404** (`src/pages/404.astro`), which GitHub Pages serves for every missing path: both
  languages in one page, showing the one the URL asks for before the first paint, with the house
  illustration (a shipping label, "Return to sender") and the latest launches. A static site has no
  other error page.
- **An about page** at `/en/about/` and `/es/sobre-mi/` (`src/components/pages/AboutPage.astro`,
  2026-10-25), written from the owner's own GitHub profile and approved by them: who they are, the
  projects (claudio, Shipcast and Sluice, the one project of their work account they chose to show),
  their stack with Simple Icons logos, a few facts, their quote kept in English, and how to reach them
  (`me@josegarrido.dev`). Linked from the header, the blue band and the footer. The site's copy is
  short and talks to the reader; at the owner's request it does not promise "what does not work yet",
  nor mention that it is written in two languages.
- **The footer** shows the profiles as their logos (`src/components/Profiles.astro`, shared with the
  about page), small links to RSS, the about page and the privacy policy, and `© <year of the build>
  <author>`. RSS is only there and in the head's `alternate` link, which feed readers discover on their
  own: the newsletter is how a person follows the blog.
- **Marks:** the favicon (the italic J over the green rule) and the `jg` monogram are Fraunces
  outlines in SVG, so they render the same without the font, with PNGs at 16, 32 and 180 px.
- **Project looks in `projects.yml`** (2026-10-25): each known project's flat colour, motif and
  cover, at the repo's root beside `brand.yml`. The blog reads it at build time (`src/projects.ts`,
  same fallback for a project not listed: a colour and a motif picked from its name by a hash) and
  Shipcast reads it when it draws a launch's images, so both agree from one list.
- **Covers:** a project (`cover` in `projects.yml`) or an article (`cover` in its front matter) can
  carry a cover that replaces the CSS illustration; claudio's is drawn. A project launched without one
  gets one generated by Shipcast in the house style (1600×900, its colour and motif, no text) at
  `public/covers/<project>.jpg`, and the drafts pull request lists it in `projects.yml`.
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
  create the Instagram app: what Shipcast accesses (the owner's own accounts on each network it
  publishes to or reads from), that it stores tokens only locally and collects nothing about anyone
  else, that the blog sets no cookies and counts visits with Cloudflare Web Analytics (what it records
  and why), and how to delete data (`#data-deletion`, also the URL for Meta's data deletion field).
  Contact: `yeyochico@gmail.com`, as the owner asked. Since 2026-10-24 it covers the newsletter too
  (only the address and its language are kept, Brevo processes them, double opt-in, open and click
  tracking, one-click unsubscribe). Linked from the footer and from the newsletter form. Update it,
  and its date, whenever a connector starts accessing something new.

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
- **The launch's media** at `public/launches/<project>/<ref>/` (`og.png`, `og.jpg`, the Instagram
  carousel and story), served by the site once merged, since Instagram fetches media from a public URL
  at publishing time ([publishing.md](publishing.md)).
- **Articles written in Shipcast's app** keep their pieces at `articles/<slug>/` (with a `launch.yml`
  holding the channels chosen in the app) and their media at `public/articles/<slug>/`
  ([engine.md](engine.md#articles-written-in-the-app)).
- **`projects.yml`** gains a project's generated cover when it is launched without one.
- **Without a pull request**, when the owner publishes directly from the app, the same files arrive
  as one commit on `main`.

## Checks

`pnpm check` (`astro check`, which needs TypeScript 6: it refuses 7, so this repo pins `typescript@^6`
while Shipcast uses 7), `pnpm build`, and `node scripts/contrast.mjs` after any colour change.

## Related

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[plans/design-system.md]] · [[plans/stack.md]] · [[brands.md]] · [[personal-identity.md]] · [[content-pack.md]] · [[engine.md]] · [[publishing.md]]
