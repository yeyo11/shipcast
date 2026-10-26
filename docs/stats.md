---
created_at: 2026-10-26T11:02:17.209413514Z
updated_at: 2026-10-26T12:38:47.349156133Z
tags:
    - stats
    - metrics
    - api
    - engine
    - reference
    - phase-9
    - web-app
---
# Stats: the model, popularity, the routes and the page

Built on 2026-10-25 for the stats section of milestone 5 of the [goal](plans/goal-after-mvp.md): the
backend the charts read ([decisions/app-design-direction.md](decisions/app-design-direction.md): several
series, period comparisons, a ranking under the chart, filters by channel, account, launch and dates,
sorted by popularity normalised per network). The queries are `packages/engine/src/stats.ts`
([source](../packages/engine/src/stats.ts)); the routes are `apps/web/src/server/stats-api.ts`, spread
into the [REST API](api.md). No migration: every query runs on the existing `metrics_by_launch` index.
The web app's Stats page reads the same queries in its own process ([below](#the-page)).

## What a reading is

Every metrics round records each counter as it stands ([publishing.md](publishing.md#metrics)): a
post's likes so far, a blog article's visits since the launch, a repo's stars. What happened in a
period is therefore a **difference of readings**, never a sum of them.

**Families.** Each network's names are folded into six families so networks can share a chart
(`METRIC_FAMILIES`, one table to extend):

| Source | views | reactions | comments | shares | clicks | impressions |
| --- | --- | --- | --- | --- | --- | --- |
| dev.to, Hashnode | views | reactions | comments | | | |
| Bluesky | | likes | replies | reposts + quotes | | |
| Mastodon | | favourites | replies | boosts | | |
| Instagram | views | likes | comments | shares | | reach |
| Newsletter | opens | | | | clicks | delivered |
| Blog | views | | | | | |
| Search Console, Bing | | | | | clicks | impressions |
| GitHub | | stars | | forks | | |

Left out: Instagram's `saved`, the newsletter's bounces and unsubscribes, the blog's per-source and
per-language split, and GitHub's views, which are a rolling 14-day count rather than a counter.

**Counters.** A counter is listed from the posts and launches, not from the readings, and is one of:

- `p:<post>`: one piece (a post or a newsletter issue), with its account;
- `l:<launch>:<source>`: a launch's site-level source (blog visits, Search Console, Bing), with no account;
- `r:<repo>`: GitHub. Every launch of a repo reads the same repo, so its launches are one counter,
  attributed to the repo's newest launch.

A channel's reading with no piece is skipped: those are the newsletter readings from before the
[post model](decisions/post-model.md), each the sum of both issues, and every such launch has its
issues as pieces now, so counting both would count twice. The cost: an old launch's newsletter
growth from before its issues were first read separately lands at that first reading.

**Increase in a period.** A counter starts the period at its **last reading before it**, or at zero
for a piece that had none (a piece starts at zero when it goes out). GitHub is the exception: the
repo had its stars before Shipcast watched it, so with no reading before the period it starts at its
first reading in it. The increase is the highest reading in the period above the start, never below
zero, so a dip (an unlike, a recount) takes nothing away and a missed reading is caught up by the
next one. In a series, a counter at a bucket's end stands at its highest reading so far; the bucket's
increase is the change since the previous bucket, and `cumulative` is the start plus the increases.
The overview's increase is always the sum of the series' buckets.

## Popularity normalised per network

A like on Bluesky and a visit to dev.to are not comparable as raw numbers; each is compared with
what its own network usually gives. For the period, for each network *n* and each **active family**
*f* among views, reactions, comments, shares and clicks (one in which some piece of *n* grew):

```
m(n, f)   = median over the pieces of n read in the period of their increase in f
score(p)  = mean over the active families f of n of  (x(p, f) + 1) / (m(n, f) + 1)
```

A score of 1 is the network's typical piece in the period, 2 twice that. The `+1` keeps a network
whose typical piece got nothing from dividing by zero. Impressions are not scored (they say how often
something was shown, not that anyone cared). A family nobody grew in is left out, since it would pull
every score to 1, and a network with no active family has no yardstick, so its pieces are not ranked.
A launch's or an account's score is the mean of its pieces' scores, with their raw sums beside it.
The yardsticks come back as `medians`.

Example from the tests: dev.to posts with 1000 and 500 views (20 and 10 reactions) and Bluesky posts
with 6, 1 and 2 likes rank as Bluesky 6 (7/3), dev.to 1000, Bluesky 2 (1.0), dev.to 500, Bluesky 1.
Raw numbers would put both dev.to posts first.

With one account per network, accounts score close to 1 by construction; ranking accounts becomes
meaningful once a network has several.

## The functions

| Function | Returns |
| --- | --- |
| `statsOverview(registry, { from, to, channels?, accounts?, launches?, compareTo? })` | The increase per family overall, per channel and per account; with `compareTo` (`'previous'`, the same length just before, or a period) the previous numbers and a `delta` per family (`absolute`, and `relative`, null from zero) |
| `statsSeries(registry, { metric, groupBy, from, to, bucket, limit?, …filters })` | `buckets` (days, or weeks from Monday, at most 400) and one series per channel, account (`none` for what no account published) or launch: `baseline`, `total` and a dense list of `{ bucket, increase, cumulative }`; past `limit` (10) the rest are added up in `other` |
| `statsRanking(registry, { by, from, to, limit?, offset?, order?, …filters })` | Posts, launches or accounts by score, a page at a time (`total`, `next` offset), each with its raw `metrics`, `pieces`, `label`, and for a piece its `url` and `kind` (`site` for site-level numbers) |
| `accountGrowth(registry, accountId, { from, to })` | The account's daily snapshots ([decisions/account-snapshots.md](decisions/account-snapshots.md)) with the change since the snapshot before each one (`days` apart, so a missed day shows), and the change over the period |

Periods are whole UTC days (`2026-10-01` to `2026-10-31`, both included) or ISO timestamps (`from`
included, `to` excluded). A bad period throws a `RangeError`. `Registry.selectRows` runs the raw SQL
(window functions, `FILTER`, `LATERAL`) on either driver.

## Cost

Each counter's start is one backwards probe of `metrics_by_launch` (launch, source, name, taken_at)
and its period one range scan of it, so a query reads the period's readings plus one per counter,
never the whole history. On a copy of the live registry with a year of synthetic readings added
(170,000 rows), the overview went from 1.2 s with a full-history pass to 20 ms, a 90-day daily series
to 15 ms, and the ranking to 18 ms, every scan on the index. Labels are read in one query per table
per page, never one per row.

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
`apps/web/src/components/stats/`), laid out on 2026-10-26 from the mock-up the owner approved (the
"tabs" variant) so that no part needs a long scroll: each tab fits about one screen on a desktop.

- **The header**: the poster title at a smaller size (`clamp(40px, 6vw, 72px)`) and Export CSV, the
  chart's series as a file. On a phone Export CSV is an icon button (a download glyph, named "Export
  CSV") beside the title, so it takes no row of its own.
- **The filter bar**: the period as a segmented control (7 days, 30 days, 90 days, All; Custom appears
  while a custom range is shown) and one **Filters** button, which opens a popover with what the view
  is narrowed to (channels, accounts, launches, and Clear the filters), how the chart is drawn
  (grouped by channel, account or launch; lines, areas or bars; days or weeks, weeks only past 120
  days; compared with the previous period or not) and a custom range, chosen in one calendar (the
  `DateRangePicker` of the [component layer](decisions/component-layer.md): two months side by side,
  a bottom sheet on a phone, no later than today). The button counts what is set.
  "All" starts on the day of the first published launch, at most 731 days back, and is the last 30
  days while nothing is published.
- **The tabs**: Overview, Posts, Accounts, Search, as Base UI Tabs in the component layer's
  `underline` variant (arrows move between them and show each). The tab is in the address with the
  rest of the view (`/stats?tab=accounts`), so a link opens on it; it is left out of the loader's
  dependencies, so moving between tabs never reads the numbers again, and it replaces the history
  entry rather than adding one.
- **Overview**: the totals as one strip that is also the chart's metric switch (a radio group; the
  charted family has Cartel's yellow line under it), and the time chart with its zoom and its "Show
  the data" table.
- **Posts**: the ranking of posts, launches or accounts by score, with the raw numbers beside it,
  sortable by any column, ten to a page.
- **Accounts**: one table of the accounts with snapshots: the network and handle; followers,
  following and posts with their change in the period; a sparkline of the chosen measure over the
  period (scaled to its own range, a missed day left as a gap, the period as a hairline under it); when
  it was last synced; and Sync now. The sparklines are for the eye only: "Show the data" lays every
  day's number out as a table.
- **Search**: each published launch's article pages with what Google (URL Inspection) and Bing
  (crawled or not) last said of each, as on a launch's page ([search-indexing.md](search-indexing.md)),
  and each engine's impressions and clicks for the launch in the period. The engines count a
  launch's pages together, so those numbers span its rows. It is read by `loadSearch` in
  `apps/web/src/server/stats.server.ts` from what the engine already keeps (`articleUrls`,
  `indexStatus`, `statsOverview` on the `search` and `bing` sources); the launches filter narrows it.

On a phone (up to 640 px, or a coarse pointer) the controls take two rows instead of three: the
period becomes a Select and sits with **Filters** (a bottom sheet there) on one row, and the date range
is a small caption under them. Both shapes of the period are rendered and CSS shows one, so the
server's page is already right on a phone. The tabs scroll sideways, the ranking's rows become blocks,
and the Accounts and Search tables scroll inside their own box, never the page.

## Checked

`packages/engine/test/stats.test.ts` on PGlite: cumulative readings to increases per bucket, a missed
day carried over, a dip that takes nothing away, a later period starting where the counter stood,
weeks from Monday, two networks of very different scales ranking sensibly, a network with no activity
left unranked, comparison deltas, the channel, account and launch filters, ascending order and paging,
GitHub counted once per repo, old launch-wide newsletter readings not counted twice, series labels and
`other`, and account growth across a missed day. `apps/web/test/stats-api.test.ts` covers the scopes,
the parameters, the 400s and 404, and the OpenAPI document. On 2026-10-25 the functions ran against a
copy of the live registry restored into a throwaway Postgres 17. For the page,
`apps/web/test/stats-search.test.ts` and `apps/web/test/stats-server.test.ts` cover the address
(the period "all", the tab), the search tab's input and what it lists; the page was checked running
at 1440, 390 and 320 px wide. The date helpers behind the range picker are in
`apps/web/test/dates.test.ts`; the phone layout of 2026-10-26 and the calendar's look were written
without a running preview and are still to be checked by eye.

## Related

[[api.md]] · [[engine.md]] · [[publishing.md]] · [[web-app.md]] · [[search-indexing.md]] · [[decisions/post-model.md]] · [[decisions/account-snapshots.md]] · [[decisions/app-design-direction.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]]
