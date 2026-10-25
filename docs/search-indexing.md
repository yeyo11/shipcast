---
created_at: 2026-10-25T11:41:45.910844848Z
updated_at: 2026-10-25T13:00:17.347530774Z
tags:
    - seo
    - search-console
    - bing
    - metrics
    - publishing
    - blog
---
# Getting the blog's articles indexed

Built on 2026-10-25, after the owner found that Google knew two of the blog's ten pages: it had read
the sitemap once, when it was added the day before, and not since. Search Console's API lets Shipcast
do what the owner would otherwise do by hand ([plans/after-mvp.md](plans/after-mvp.md) brought it
forward). Bing Webmaster Tools joined the same day.

## Google

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

Google's Indexing API is not used: it only accepts job postings and livestreams.

It needs the Search Console account connected in Channels: a service account added to the domain
property as a **full user** (resubmitting a sitemap is a write; the connector asks for the
`webmasters` scope, not the read-only one). The URL Inspection API allows 2,000 inspections a day per
property, far above two URLs per launch every 6 hours.

## Bing

- **On every metrics reading**, each language's article is read through Bing Webmaster Tools' JSON API
  (`BingWebmaster` in `@shipcast/connectors`): its clicks and impressions in Bing
  (`GetUrlTrafficInfo`, metrics `bing.clicks` and `bing.impressions`), and when Bing discovered and
  last crawled it (`GetUrlInfo`, cursor `index-status:bing:<url>`, metric `bing.crawled`). Bing does
  not report "indexed" the way Google does, so Shipcast says "crawled" and nothing more.
- **Telling Bing about a new article** is the blog deploy's job: it pings IndexNow with the changed
  URLs, which Bing and Yandex share, so Shipcast does not submit URLs to Bing itself.
- It needs the **Bing Webmaster Tools** account connected in Channels with the user's API key
  (Settings › API Access › Generate API Key; one key per user, valid for every site they verified).
  The check confirms the key works and that the blog's site is among the user's verified sites.

## On the launch's page

"In search engines" lists, per language, Google's state ("Indexed" or "Not indexed yet", with its
coverage state) and, once Bing has been read, Bing's ("Crawled" or "Not crawled yet"), each with when
it was checked. The numbers sit with the other sources, as "Google Search" and "Bing".

## Related

[[publishing.md]] · [[plans/after-mvp.md]] · [[plans/search-presence.md]] · [[launches-repo.md]] · [[engine.md]] · [[web-app.md]] · [[accounts.md]]
