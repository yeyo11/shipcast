---
created_at: 2026-10-25T11:41:45.910844848Z
updated_at: 2026-10-29T19:48:27.891946875Z
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
- **Each language's article URL is inspected** through the URL Inspection API: whether it is indexed,
  Google's coverage state in its own words ("Submitted and indexed", "Discovered - currently not
  indexed", "URL is unknown to Google"), the last crawl, and the canonical Google selected and the one
  the page declares (`googleCanonical`, `userCanonical`). With `batched-metrics` an article is
  inspected daily until indexed, weekly after, and never past 90 days from its launch; without it,
  on every six-hourly reading. The status is kept per URL (cursor `index-status:<url>`), and the
  number of indexed languages is a metric (`search.indexed`), so its history is kept.
- **The canonical.** Search Console credits clicks and impressions to the canonical URL Google chose.
  When that is not the article's own URL (a dev.to or Hashnode copy, a variant without the trailing
  slash), the article's numbers miss them: the launch's mismatched pages are kept in a
  `search-canonical:<launch>` cursor (`noteCanonicals` in `packages/engine/src/metrics.ts`), forgotten
  once Google agrees again, and the bell shows a line on the launch ("Google files … under …") until
  then. A page not indexed has no Google canonical yet and is not a mismatch.
- **Clicks, impressions, CTR and position** of each language's URL come from Search Analytics
  (`dimensions: ['page']`, an exact-URL filter, final data from the launch's day to today), summed
  over the languages: `search.clicks`, `search.impressions`, `search.ctr` (clicks over impressions
  of the sum) and `search.position` (the average position weighted by impressions, Search Console's
  own way). Final data lags two to three days; fresh data (`dataState: all`) and per-day readings are
  the dated-values work of the stats model.
- **While any article is not indexed**, the sitemap is resubmitted, at most once a day
  (`sitemap-submitted-at`): Google ignores frequent resubmits of an unchanged sitemap.

Google's Indexing API is not used: it only accepts job postings and livestreams.

It needs the Search Console account connected in Channels: a service account added to the domain
property as a **full user** (resubmitting a sitemap is a write; the connector asks for the
`webmasters` scope, not the read-only one). The URL Inspection API allows 2,000 inspections a day per
property, far above two URLs per launch a day.

## Bing

- **Once a day**, each language's article is read through Bing Webmaster Tools' JSON API
  (`BingWebmaster` in `@shipcast/connectors`): its clicks and impressions in Bing
  (`GetUrlTrafficInfo`, metrics `bing.clicks`, `bing.impressions` and their `bing.ctr`), and when Bing
  discovered and last crawled it (`GetUrlInfo`, cursor `index-status:bing:<url>`, metric
  `bing.crawled`). Bing's API has no "indexed" state (its URL Inspection page in the UI has one), so
  Shipcast says "crawled" and nothing more.
- **The period of `GetUrlTrafficInfo` is not documented** (checked 2026-10-29). Microsoft's reference
  gives no window, the call takes no date and its answer (`Clicks`, `Impressions`, `IsPage`, `Url`)
  carries none. The Search Performance report it mirrors keeps 16 months since 2024-10-16 (six
  before), so the code's old "about six months" was a guess, and the total may be a rolling window
  that drops old days rather than a count since the launch. Until the owner compares one article's
  number with the UI's Pages report over 3, 6 and 16 months, Shipcast treats it as Bing's running
  total for the page. The dated way is `GetPageStats` or `GetPageQueryStats` (weekly rows with
  positions), next with the stats model's dated values.
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

[[publishing.md]] · [[plans/after-mvp.md]] · [[plans/search-presence.md]] · [[launches-repo.md]] · [[engine.md]] · [[web-app.md]] · [[accounts.md]] · [[stats.md]]
