---
created_at: 2026-10-25T12:53:11.587162587Z
updated_at: 2026-11-01T11:50:20.133001674Z
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
live and while one is missing. Google's results for the owner's name also hold namesakes: a Spanish
racing cyclist with a Wikidata item and a Wikipedia article, and many a "José Garrido" (a
disambiguation page lists them), so every signal has to say plainly which José Antonio Garrido the
blog is about.

## Sitelinks

Google picks sitelinks on its own, from sites with clear sections that people search for by name. What
helps:

- **A site name and favicon Google accepts**: the `WebSite` structured data with `name` and
  `alternateName`, and a square favicon of at least 48 px on every page.
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
  Instagram and Reddit. It linked the owner's Wikidata item too, until Wikidata deleted it (below).
- **A Wikidata item for the owner**, which Google reads, kept distinct from the namesakes by its
  description ("full-stack developer"), and items for the projects linked to it.
  - Wikidata asks for an item to describe a clearly identifiable entity backed by serious public
    references. Repositories and the owner's own blog are self-published, so the items are at risk of
    deletion until something independent writes about the owner or the projects; independent coverage
    (an interview, a talk, an article by someone else) is what makes them hold.
  - Wikidata's conflict-of-interest guideline allows people to create their own item, disclosed on
    the user page.
  - **The risk came true**: the three items were deleted on 2026-10-25, the day they were created, as
    not meeting Wikidata's notability policy (the deletion log, checked 2026-11-01). An item goes back
    only once independent coverage exists to reference it.
- **Links from outside**: dev.to already points to the blog as the original; each project's README
  should link the blog and the article that launched it.
- **Claiming the panel** once Google shows one: the owner verifies through Google and can then suggest
  changes.

Sitelinks are realistic within weeks of the structure being in place. A panel may take months, and
depends on the independent references above.

## Progress

- **2026-10-25**, done:
  - Site name, favicons at 48 and 96 px, breadcrumbs and the `Person` with every profile in
    `sameAs`, on the blog ([launches-repo.md](../launches-repo.md)).
  - The Wikidata items, created through the API from the owner's account, with the conflict of
    interest disclosed on its user page:
    - the owner, Q141856101: human, software developer,
      given and family names, official website, GitHub, Mastodon, Bluesky, Instagram, Reddit and
      Telegram usernames, notable work, each referenced to the about page except Telegram;
    - claudio, Q141856151, and Shipcast, Q141856152: free software, developer the owner,
      source repository, MIT licence, programmed in TypeScript, described at their launch articles.
  - The owner's item added to the blog's `sameAs`.
  - QuickStatements needs an autoconfirmed account (four days and fifty edits), so the items went
    through the Wikidata API with a bot password the owner created.
- **2026-10-25**, undone the same day: Wikidata deleted all three items as not meeting its notability
  policy (the deletion log, checked 2026-11-01), so none of them exists. The blog's `sameAs` stops
  linking the owner's item in a separate change to the launches repo.
- **Next**: the project pages and the article index (design with the owner), links from each
  project's README to the blog, and adding the owner to the "José Garrido" disambiguation page.

## Related

[[plans/after-mvp.md]] · [[search-indexing.md]] · [[launches-repo.md]] · [[plans/shipcast.md]] · [[brands.md]]
