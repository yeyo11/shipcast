---
created_at: 2026-10-25T11:06:04.761591497Z
updated_at: 2026-10-25T11:06:04.761591497Z
tags:
    - plan
    - seo
    - blog
    - knowledge-graph
    - wikidata
---
# Search presence: sitelinks and a knowledge panel

Decided on 2026-10-25 by the owner, who wants the blog to show in Google the way a known brand does:
a result with sitelinks under it, and a knowledge panel beside it. Neither can be forced; Google
grants both. This plan gives Google every signal it reads. It runs with the blog's work in
[plans/after-mvp.md](after-mvp.md#the-blog-in-parallel), and builds on
[search-indexing.md](../search-indexing.md), which keeps every article indexed.

## Where it starts

On 2026-10-25 Google had two of the blog's ten pages: it had read the sitemap once, the day the site
was added. The sitemap was resubmitted the same day, and Shipcast now resubmits it when an article goes
live and while one is missing. Google's results for the owner's name also hold a namesake: a Spanish
racing cyclist with a Wikidata item and a Wikipedia article, so every signal has to say plainly which
José Antonio Garrido the blog is about.

## Sitelinks

Google picks sitelinks on its own, from sites with clear sections that people search for by name. What
helps:

- **A site name and favicon Google accepts**: the `WebSite` structured data with `name` and
  `alternateName`, and a square favicon of at least 48 px on every page (in the blog's current pull
  request).
- **A structure of real sections**, the pages Google tends to choose:
  - a page per project (`/en/projects/claudio/`, `/en/projects/shipcast/`, and the Spanish ones)
    gathering its launches, with what the project is, its repository and its latest version;
  - an index of every article, by date and by project;
  - About and the newsletter, as today.
  Their design goes to the owner with a live preview before it ships.
- **Breadcrumbs** (`BreadcrumbList`) on every page under the home.
- **Searches for the brand**: the name and the domain, in the profiles, the READMEs and every post
  Shipcast publishes. A `site:` query never shows sitelinks; the test is a search for the name.

## A knowledge panel

The panel comes from Google's Knowledge Graph, which recognises entities, not pages. The signals:

- **The `Person` on the blog** (`@id` `https://josegarrido.dev/#person`) with the same name, photo
  and description everywhere, and `sameAs` to every profile: GitHub, Mastodon, Bluesky, dev.to,
  Instagram.
- **A Wikidata item for the owner**, which Google reads, kept distinct from the cyclist by its
  description ("software developer"). Its statements: instance of human, occupation software
  developer, official website, GitHub username, Mastodon address, Bluesky handle; and items for the
  projects (free software, developer the owner, source code repository, MIT licence, programmed in
  TypeScript) linked to it. The blog's `Person` then adds the item to `sameAs`.
  - Wikidata asks for an item to describe a clearly identifiable entity backed by serious public
    references. Repositories and the owner's own blog are self-published, so the item is at risk of
    deletion until something independent writes about the owner or the projects; independent coverage
    (an interview, a talk, an article by someone else) is what makes it hold.
  - Wikidata's conflict-of-interest guideline allows people to create their own item, disclosed on
    the user page. The owner creates it from their own Wikidata account; Shipcast's side prepares the
    statements ready to paste into QuickStatements.
- **Links from outside**: dev.to already points to the blog as the original; each project's README
  should link the blog and the article that launched it.
- **Claiming the panel** once Google shows one: the owner verifies through Google and can then suggest
  changes.

Sitelinks are realistic within weeks of the structure being in place. A panel may take months, and
depends on the independent references above.

## Related

[[plans/after-mvp.md]] · [[search-indexing.md]] · [[launches-repo.md]] · [[plans/shipcast.md]] · [[brands.md]]
