---
created_at: 2026-10-27T10:37:15.879923142Z
updated_at: 2026-10-27T10:37:24.561779241Z
tags:
    - decision
    - publishing
    - articles
    - devto
    - hashnode
    - assets
---
# Images in an article's body

Decided on 2026-10-27, while staging the article on REA ([plans/goal-article-rea.md](../plans/goal-article-rea.md)),
the first article whose body carries its own screenshots.

## The problem

An article's body goes to three places: the blog (Astro, in the launches repo), dev.to and Hashnode,
the last two with the same Markdown ([publishing.md](../publishing.md)). The blog resolves a
root-relative image such as `/articles/<slug>/player.png`, and so does its preview per branch, where
the owner reviews the drafts pull request before it is merged. dev.to and Hashnode do not: they take
the Markdown as it comes and a root-relative path points nowhere on their sites.

Writing the images as absolute URLs on the blog (`https://josegarrido.dev/articles/<slug>/…`) would
fix those two and break the preview, since the images only exist on the live site once the pull
request is merged.

## The decision

- An article's own images live with its other media, at `public/articles/<slug>/` in the launches
  repo (a release's at `public/launches/<project>/<ref>/`), committed to the drafts pull request.
- The article's Markdown links them **root-relative**: `![What it shows](/articles/<slug>/name.png)`.
  The blog and its preview render them as they are.
- `absoluteLinks(markdown, site)` in `packages/engine/src/publish.ts` puts every root-relative link
  and image (`](/…`) on the brand's site before the body goes to dev.to and Hashnode. Absolute,
  protocol-relative (`//…`) and page-relative links are left alone, and so is anything inside a
  fenced code block.
- Publishing runs after the merge, when the blog has the images, as it already does for `og.png` (the
  dev.to and Hashnode cover) and Instagram's carousel.

## Related

[[publishing.md]] · [[launches-repo.md]] · [[engine.md]] · [[content-pack.md]] · [[goal-article-rea.md]]
