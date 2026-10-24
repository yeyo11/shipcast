---
created_at: 2026-10-24T14:00:18.933559816Z
updated_at: 2026-10-24T14:00:18.933559816Z
tags:
    - launches-repo
    - blog
    - astro
    - github-pages
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
  `https://yeyo11.github.io/launches/<lang>/<slug>/`, and the dev.to and Hashnode copies point to it,
  so `site`, `base` and published slugs never change without a redirect.
- **Bilingual**: Astro i18n with `en` (default) and `es`, both prefixed; `/` redirects to `/en/`.
  Each page links its translation (`hreflang`) when it exists.
- **RSS per language** (`/<lang>/rss.xml`) and a sitemap.
- **Day theme of the [design system](plans/design-system.md)**: Saira for display, Atkinson
  Hyperlegible Next for text, the day tokens in `src/styles/global.css`, an 18 px root because it is a
  reading surface, a 37 rem measure. The index draws the launches as a signal line with a release node
  per article. Checked at 1280 and 375 px wide.

## The contract with Shipcast

What Shipcast writes there, and the content pack has to produce:

- **Articles** at `src/content/posts/<en|es>/<slug>.md`. Front matter, validated at build time by
  `src/content.config.ts`: `title`, `description` (at most 200 characters), `pubDate`, optional
  `updatedDate`, `lang` (`en` or `es`), `translationKey` (shared by both language versions), `repo`
  (the project's URL), optional `version`, `tags`, `draft`.
- **The other channels' pieces** at `launches/<project>/<version>/`, in a format still to be defined
  by the content pack schema.
- The blog's identity (author, links) sits in `src/site.ts` until the brand config owns it.

## Checks

`pnpm check` (`astro check`, which needs TypeScript 6: it refuses 7, so this repo pins `typescript@^6`
while Shipcast uses 7) and `pnpm build`.

## Related

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[plans/design-system.md]] · [[plans/stack.md]] · [[content-pack]] · [[brands]]
