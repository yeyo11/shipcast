---
created_at: 2026-10-25T11:02:58.125789316Z
updated_at: 2026-10-25T11:02:58.125789316Z
tags:
    - seo
    - search-console
    - metrics
    - publishing
    - blog
---
# Getting the blog's articles indexed

Built on 2026-10-25, after the owner found that Google knew two of the blog's ten pages: it had read
the sitemap once, when it was added the day before, and not since. Search Console's API lets Shipcast
do what the owner would otherwise do by hand ([plans/after-mvp.md](plans/after-mvp.md) brought it
forward).

## What Shipcast does

- **When an article goes live** (the merge deployed it and the publish round sees it answer), Shipcast
  resubmits the sitemap (`<site>/sitemap-index.xml`) to Search Console, so Google reads it again that
  day instead of on its own schedule. Once per launch; a failure there never holds the launch back.
- **On every metrics reading** (every 6 hours), each language's article URL is inspected through the
  URL Inspection API: whether it is indexed, Google's coverage state in its own words ("Submitted and
  indexed", "Discovered - currently not indexed", "URL is unknown to Google"), and the last crawl. The
  status is kept per URL (cursor `index-status:<url>`), and the number of indexed languages is a
  metric (`search.indexed`), so its history is kept.
- **While any article is not indexed**, the sitemap is resubmitted, at most once a day
  (`sitemap-submitted-at`): Google ignores frequent resubmits of an unchanged sitemap.
- **The launch's page** shows, per language, "Indexed" or "Not indexed yet" with the coverage state
  and when it was checked.

Bing and the engines behind IndexNow are told by the blog's own deploy, which pings IndexNow with the
changed URLs. Google's Indexing API is not used: it only accepts job postings and livestreams.

## What it needs

The Search Console account connected in Channels: a service account added to the domain property as a
**full user** (resubmitting a sitemap is a write; the connector asks for the `webmasters` scope, not
the read-only one). The URL Inspection API allows 2,000 inspections a day per property, far above two
URLs per launch every 6 hours.

## Related

[[publishing.md]] · [[plans/after-mvp.md]] · [[launches-repo.md]] · [[engine.md]] · [[web-app.md]]
