---
created_at: 2026-10-26T16:39:48.121797373Z
updated_at: 2026-10-29T19:44:02.760738647Z
tags:
    - stats
    - metrics
    - api
    - engine
    - reference
    - phase-9
    - web-app
    - channels
---
# Stats: the model, popularity, the routes and the page

Built on 2026-10-25 for the stats section of milestone 5 of the [goal](plans/goal-after-mvp.md): the
backend the charts read ([decisions/app-design-direction.md](decisions/app-design-direction.md): several
series, period comparisons, a ranking under the chart, filters by channel, account, launch and dates,
sorted by popularity normalised per network). The queries are `packages/engine/src/stats.ts`
([source](../packages/engine/src/stats.ts)); the routes are `apps/web/src/server/stats-api.ts`, spread
into the [REST API](api.md). Every query runs on the `metrics_by_launch` index. The web app's Stats
page reads the same queries in its own process ([below](#the-page)).

## What a reading is

Every metrics run records each counter as it stands ([publishing.md](publishing.md#metrics)): a
post's likes so far, a blog article's visits since the launch, a repo's stars. What happened in a
period is therefore a **difference of readings**, never a sum of them.

**When it was read.** Since migration `0016` a reading has `taken_at` (when the value was first
seen) and `checked_at` (when it was last confirmed). With `batched-metrics` an hourly read that
finds the same value moves `checked_at` on the last row instead of adding one, so the table grows
only when something changes. A row read again unchanged inside a window counts as a reading of that
window; the increase is unaffected, since the value did not move.

**Families.** Each network's names are folded into six families so networks can share a chart. A
channel's families are on its definition (`metrics.families` in `packages/schema/src/channels/<id>.ts`,
gathered as `CHANNEL_METRIC_FAMILIES`); the site-level sources are added in `METRIC_FAMILIES`:

| Source | views | reactions | comments | shares | clicks | impressions |
| --- | --- | --- | --- | --- | --- | --- |
| dev.to, Hashnode | views | reactions | comments | | | |
| Bluesky | | likes | replies | reposts + quotes | | |
| Mastodon | | favourites | replies | boosts + quotes | | |
| Reddit | | score | comments | crossposts | | |
| Instagram | views | likes | comments | shares | | reach |
| Threads | views | likes | replies | reposts + quotes + shares | | |
| GitHub Discussions | | reactions + upvotes | comments | | | |
| YouTube | views | likes | comments | | | |
| Newsletter | opens | | | | clicks | delivered |
| Blog | views | | | | | |
| Search Console, Bing | | | | | clicks | impressions |
| GitHub | | stars | | forks | | |

Left out: Instagram's `saved` and Bluesky's `saves` (its bookmarks), the newsletter's bounces and
unsubscribes, the blog's per-source and per-language split, GitHub's views, which are a rolling
14-day count rather than a counter, and Reddit's `upvoteRatio`. Mastodon's `quotes` are read where
the instance counts them (4.5 and later). Telegram, Discord and LinkedIn read no per-post numbers.

**Ratios.** A reading that is a ratio of one piece, not a count, is listed in its definition's
`metrics.averaged` (gathered as `AVERAGED_METRICS`; today Reddit's `upvoteRatio`). No family takes
it, and wherever a launch's pieces are put together (`latestMetrics`, `metricHistory`) it is their
average instead of their sum.

**Counters.** A counter is listed from the posts and launches, not from the readings, and is one of:

- `p:<post>`: one piece (a post, a video or a newsletter issue), with its account;
- `l:<launch>:<source>`: a launch's site-level source (blog visits, Search Console, Bing), with no account;
- `r:<repo>`: GitHub. Every launch of a repo reads the same repo, so its launches are one counter,
  attributed to the repo's newest launch.

A channel's reading with no piece is skipped: those are the newsletter readings from before the
[post model](decisions/post-model.md), each the sum of both issues, and every such launch has its
issues as pieces now, so counting both would count twice.

**Increase in a period.** A counter starts the period at its **last reading before it**, or at zero
for a piece that had none. GitHub is the exception: with no reading before the period it starts at
its first reading in it. The increase is the highest reading in the period above the start, never
below zero, so a dip takes nothing away and a missed reading is caught up by the next one. In a
series, a counter at a bucket's end stands at its highest reading so far; `cumulative` is the start
plus the increases. The overview's increase is always the sum of the series' buckets.

## Popularity normalised per network

A like on Bluesky and a visit to dev.to are not comparable as raw numbers; each is compared with
what its own network usually gives. For the period, for each network *n* and each **active family**
*f* among views, reactions, comments, shares and clicks (one in which some piece of *n* grew):

```
m(n, f)   = median over the pieces of n read in the period of their increase in f
score(p)  = mean over the active families f of n of  (x(p, f) + 1) / (m(n, f) + 1)
```

A score of 1 is the network's typical piece in the period, 2 twice that. The `+1` keeps a network
whose typical piece got nothing from dividing by zero. Impressions are not scored. A family nobody
grew in is left out, and a network with no active family has no yardstick, so its pieces are not
ranked. A launch's or an account's score is the mean of its pieces' scores, with their raw sums
beside it. The yardsticks come back as `medians`.

Example from the tests: dev.to posts with 1000 and 500 views (20 and 10 reactions) and Bluesky posts
with 6, 1 and 2 likes rank as Bluesky 6 (7/3), dev.to 1000, Bluesky 2 (1.0), dev.to 500, Bluesky 1.

With one account per network, accounts score close to 1 by construction; ranking accounts becomes
meaningful once a network has several.

## The functions

| Function | Returns |
| --- | --- |
| `statsOverview(registry, { from, to, channels?, accounts?, launches?, compareTo? })` | The increase per family overall, per channel and per account; with `compareTo` the previous numbers and a `delta` per family |
| `statsSeries(registry, { metric, groupBy, from, to, bucket, limit?, …filters })` | `buckets` (days, or weeks from Monday, at most 400) and one series per channel, account or launch: `baseline`, `total` and `{ bucket, increase, cumulative }`; past `limit` (10) the rest in `other` |
| `statsRanking(registry, { by, from, to, limit?, offset?, order?, …filters })` | Posts, launches or accounts by score, a page at a time, each with its raw `metrics`, `pieces`, `label`, and for a piece its `url` and `kind` |
| `accountGrowth(registry, accountId, { from, to })` | The account's daily snapshots ([decisions/account-snapshots.md](decisions/account-snapshots.md)) with the change since the snapshot before each one, and the change over the period |

`registry` is a `Pick` of the repositories ([engine.md](engine.md#the-launch-registry)); the raw SQL
(window functions, `FILTER`, `LATERAL`) runs through the `queries` repository on either driver.
Periods are whole UTC days or ISO timestamps (`from` included, `to` excluded). A bad period throws a
`RangeError`. `MetricsService` reads the numbers; the stats only read the registry, so a Stats page
costs no provider call.

## Cost

Each counter's start is one backwards probe of `metrics_by_launch` (launch, source, name, taken_at)
and its period one range scan of it, so a query reads the period's readings plus one per counter,
never the whole history. On a copy of the live registry with a year of synthetic readings added
(170,000 rows), the overview went from 1.2 s with a full-history pass to 20 ms, a 90-day daily series
to 15 ms, and the ranking to 18 ms. Labels are read in one query per table per page.

## Routes

`read` scope, under `/api/v1` ([api.md](api.md)):

| Route | Parameters |
| --- | --- |
| `GET /stats/overview` | `from`, `to` (the last 30 days by default), `channels`, `accounts`, `launches` (comma-separated), `compare=previous` or `compareFrom` and `compareTo` |
| `GET /stats/series` | `metric` (required: `views`, `reactions`, `comments`, `shares`, `clicks`, `impressions`), `groupBy` (`channel`, `account`, `launch`), `bucket` (`day`, `week`), `limit` (1 to 50), the period and the filters |
| `GET /stats/ranking` | `by` (`post`, `launch`, `account`), `order` (`desc`, `asc`), `limit` (1 to 100), `offset`, the period and the filters |
| `GET /accounts/{accountId}/growth` | `from`, `to` as days (the last 90 by default); 404 for an account that does not exist |

A parameter that is not valid is a 400 that says which and why.

## The page

`/stats` in the web app (`apps/web/src/routes/_app/stats.tsx`, its parts in
`apps/web/src/components/stats/`), laid out on 2026-10-26 from the mock-up the owner approved so that
no part needs a long scroll: each tab fits about one screen on a desktop.

- **The toolbar**: the period, one **Filters** button and Export CSV (the chart's series as a file;
  its glyph alone on a phone); the range is the caption under it.
- **Filters**: a popover with what the view is narrowed to (channels, accounts, launches, and Clear
  the filters), how the chart is drawn (grouped by channel, account or launch; lines, areas or bars;
  days or weeks, weeks only past 120 days; compared with the previous period or not) and a custom
  range in one calendar (the `DateRangePicker` of the [component layer](decisions/component-layer.md),
  no later than today). The button counts what is set. "All" starts on the day of the first published
  launch, at most 731 days back.
- **The tabs**: Overview, Ranking, Accounts, Search, as Base UI Tabs. The tab is in the address
  (`/stats?tab=accounts`; `?tab=posts` still opens Ranking); it is left out of the loader's
  dependencies, so moving between tabs never reads the numbers again.
- **Overview**: the totals as one strip that is also the chart's metric switch, and the time chart
  with its zoom and its "Show the data" table.
- **Ranking**: posts, launches or accounts by score, with the raw numbers beside it, sortable by any
  column, ten to a page.
- **Accounts**: one table of the accounts with snapshots: followers, following and posts with their
  change in the period, a sparkline of the chosen measure, when it was last synced, and Sync now.
- **Search**: each published launch's article pages with what Google (URL Inspection) and Bing last
  said of each ([search-indexing.md](search-indexing.md)), and each engine's impressions and clicks
  for the launch in the period, read by `loadSearch` in `apps/web/src/server/stats.server.ts` from
  what the engine already keeps.
- **Live**: with `realtime-ui` the page reloads when a `metrics`, `account` or `post` event arrives
  ([web-app.md](web-app.md#live-pages)).

On a phone (up to 640 px, or a coarse pointer) the period becomes a Select beside **Filters** (a
bottom sheet there), the tabs scroll sideways, the ranking's rows become blocks, and the Accounts and
Search tables scroll inside their own box.

## Checked

`packages/engine/test/stats.test.ts` on PGlite: cumulative readings to increases per bucket, a missed
day carried over, a dip that takes nothing away, a later period starting where the counter stood,
weeks from Monday, two networks of very different scales ranking sensibly, a network with no activity
left unranked, comparison deltas, the filters, ascending order and paging, GitHub counted once per
repo, old launch-wide newsletter readings not counted twice, series labels and `other`, and account
growth across a missed day. `apps/web/test/stats-api.test.ts` covers the scopes, the parameters, the
400s and 404, and the OpenAPI document. On 2026-10-25 the functions ran against a copy of the live
registry restored into a throwaway Postgres 17. `apps/web/test/stats-search.test.ts` and
`apps/web/test/stats-server.test.ts` cover the address, the search tab's input and what it lists.

## Related

[[api.md]] · [[engine.md]] · [[publishing.md]] · [[web-app.md]] · [[search-indexing.md]] · [[measurement.md]] · [[decisions/architecture.md]] · [[decisions/post-model.md]] · [[decisions/account-snapshots.md]] · [[decisions/app-design-direction.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]]
