---
created_at: 2026-10-24T14:59:22.176629314Z
updated_at: 2026-10-24T15:27:40.223476906Z
tags:
    - launches-repo
    - blog
    - astro
    - github-pages
    - privacy
---
# The launches repo

[`yeyo11/launches`](https://github.com/yeyo11/launches), created on 2026-10-24, is the personal
brand's launch blog, live at **<https://yeyo11.github.io/launches/>**. It is the second repository of
the [approval flow](plans/shipcast.md#approval): Shipcast opens a pull request there with a launch's
drafts, and merging it publishes the article and lets Shipcast distribute the rest. It is a repo of
its own, not a folder of `yeyo11/shipcast`, because Shipcast is a product other developers install
with their own launches repo, approvals need pull requests (which `shipcast` does without until the
MVP, [decisions/main-until-mvp.md](decisions/main-until-mvp.md)), and a merge there means *publish*.

## What it is

- **Astro 7, static**, deployed to GitHub Pages by `.github/workflows/deploy.yml` (the official
  `withastro/action` and `actions/deploy-pages`) on every push to `main`. Pages is set to build from
  workflows. Node 24.22.1 through `.nvmrc` and pnpm's `useNodeVersion`, as in Shipcast.
- **`site: https://yeyo11.github.io`, `base: /launches`, trailing slashes.** Every canonical URL is
  `https://yeyo11.github.io/launches/<lang>/<slug>/`, and the dev.to copies point to it, so `site`,
  `base` and published slugs never change without a redirect.
- **Bilingual**: Astro i18n with `en` (default) and `es`, both prefixed; `/` redirects to `/en/`.
  Each page links its translation (`hreflang`) when it exists.
- **RSS per language** (`/<lang>/rss.xml`) and a sitemap.
- **Night theme by default, day on a toggle**, from the [design system](plans/design-system.md): the
  night tokens (abyss background, ice text, ignition and signal accents, a `#4A6C94` rule at 3.4:1),
  and the day tokens behind `[data-theme='day']`. The choice is stored in `localStorage` and applied by
  an inline script before the first paint, so a reader who picked day never sees a flash of night.
  Code blocks carry both Shiki themes (`github-dark`, `github-light`) as CSS variables and follow the
  page; at night they sit on the deck colour instead of github-dark's grey. Night became the default
  on 2026-10-24 at the owner's request; the first version was day only. Saira for display, Atkinson
  Hyperlegible Next for text, an 18 px root because it is a reading surface, a 37 rem measure. The
  index draws the launches as a signal line with a release node per article. Checked at 1280 and
  375 px wide, in both themes.
- **The brand** is described in `brand.yml` at the root ([brands.md](brands.md)); the site reads it
  for the author, the profile links (with `rel="me"`) and the support link in the footer.
- **Privacy policy** at `/<lang>/privacy/` (`src/pages/[lang]/privacy.astro`), added on 2026-10-24
  because Meta requires its URL to create the Instagram app: what Shipcast accesses (the owner's own
  accounts, `instagram_business_basic` and `instagram_business_content_publish`), that it stores
  tokens only locally and collects nothing about anyone else, that the blog has no cookies or
  analytics, and how to delete data (`#data-deletion`, also the URL for Meta's data deletion field).
  Contact: `yeyo@inmoseo.net`, the address already public in the code of conduct. Linked from the
  footer. Update it, and its date, whenever a connector starts accessing something new.

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

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[plans/design-system.md]] · [[plans/stack.md]] · [[brands.md]] · [[content-pack.md]]
