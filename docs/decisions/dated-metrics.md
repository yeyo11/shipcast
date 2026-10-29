---
created_at: 2026-10-29T20:53:14.65712517Z
updated_at: 2026-10-29T20:53:14.65712517Z
tags:
    - decision
    - stats
    - metrics
    - engine
    - schema
---
# Dated metrics: a source that counts per day keeps each day under it

Decided on 2026-10-29, from item 16 of the metrics coverage audit. Every reading Shipcast stored was a
since-launch total stamped with the time it was read, and the stats placed each increase at the hour
of the reading ([stats.md](../stats.md#what-a-reading-is)). For sources whose numbers come in days and
arrive late (Search Console two to three days, Cloudflare's days, a repo's traffic), a "last 7 days"
in Shipcast could never match the source's own screen for the same dates, and a total recomputed over
a rolling or down-sampled window drifted down while the high-water mark hid the drift.

## What was decided

**A table of its own, `metric_days`** (migration `0017_metric_days`, additive): `launch_id`,
`post_id` (null for a site-level source, as in `metrics`), `source`, `name`, `day` (YYYY-MM-DD, in the
source's own calendar: Search Console's is Pacific time, Cloudflare's and GitHub's UTC), `value` and
`read_at`, unique on (launch, piece, source, name, day) with nulls not distinct. A day read again
replaces its value: the source's later word on a day (Search Console's final data after its fresh
data, Cloudflare's estimate of a day it has down-sampled, a repo's day once it is over) is the better
one. `MetricRepository.recordDays` writes them, `metricDays` reads a launch's.

What goes in it (`DATED_METRICS` in `packages/engine/src/stats.ts`):

| Source | Days kept | Read from |
| --- | --- | --- |
| Search Console | `clicks`, `impressions` per launch, the languages added up | `searchanalytics.query` with `dimensions: ['date']` and `dataState: 'all'`, per article URL from the launch's day (`SearchConsole.pageMetricsByDay`) |
| Blog (Cloudflare Web Analytics) | `views`, `visits` per launch, the languages added up | one GraphQL query grouped by `date` and `requestPath` for every due path (`CloudflareAnalytics.pageVisitsByDay`) |
| GitHub repo | `views`, `visitors`, `clones`, `cloners` per day; `stars` given per day | the traffic's daily buckets (the last 14 days) and `/stargazers/history` (the newest 30 weeks), on every launch of the repo |

**How the stats read them.** A counter that has days kept is its days: a period's increase is the
sum of the days in it, a series puts each day in its bucket, the days before the period are where it
started, and its lifetime is every day up to the period's end. A counter with no day kept yet (a
launch read before its source kept days, or the six-hourly `collectMetrics`, which does not read
days) is read as a counter, as before. GitHub's `views` and `clones` are their days or nothing: the
readings of the same names are a rolling 14-day count that the high-water mark would misread, so they
were in no family before and are now the second tier's `views` and `clones` only through their days.
A repo's launches all keep the repo's days, and the stats take each day once per repo. Unique visitors
and cloners per day are kept but in no family: a person on two days is two uniques, so their days do
not add up. Stars stay a counter for the stats (the repo's total, the network's own number); their
days are kept for a later chart.

**Search Console's totals come from its days.** Where the connector reads days, the launch's
`clicks`, `impressions`, `ctr` and `position` readings are derived from them (`daysTotal`, the
position weighted by each day's impressions), so one call per URL replaces the since-launch query,
and the totals include Google's fresh, not yet final, days as its report does.

**The backfill.** The migration moves the one stored reading that already said its day: a repo's
traffic and stars kept as `views:<day>`, `visitors:<day>`, `clones:<day>`, `cloners:<day>` and
`stars:<day>` by the hourly reads of the same release, the newest reading of each day. Nothing else
stored can be dated: a since-launch total says nothing of the day its clicks happened. The real
backfill is the first dated read, which asks each source for every day from the launch's: Search
Console keeps 16 months, Cloudflare's dataset its own window (the dashboard shows six months), GitHub
its 14 days of traffic and 30 weeks of stars.

## What was rejected

- **`taken_at` set to the event date in `metrics`.** It would have mixed two meanings in one column:
  the hourly job decides what is due from `taken_at` and `checked_at`, `latestMetrics` adds up the
  rows that held at the last moment read, and a launch's page draws curves by read time. A day's
  value also changes after it is first read, which a row per reading cannot say without a second row
  for the same day.
- **Re-reading only the recent days.** Cloudflare samples days older than a week, so their estimates
  move a little when read again; keeping the first estimate would freeze a number Cloudflare itself
  revises. Every day is read again each time; the newest word is kept.
- **Bing per day.** `GetUrlTrafficInfo` takes no date and names no window; the dated endpoints
  (`GetPageStats`, top pages only, and `GetPageQueryStats`, per query) are weekly and do not promise a
  page's whole total. Bing stays a counter until the owner's one-off comparison with its UI settles
  the window ([search-indexing.md](../search-indexing.md#bing)).

## Code

`packages/engine/src/db/schema.ts` (`metricDays`), `packages/engine/drizzle/0017_metric_days.sql`,
`packages/engine/src/repositories/metrics.ts` (`recordDays`, `metricDays`),
`packages/engine/src/metrics.ts` (`collectHourly`, `daysTotal`, `sumDays`, `trafficDays`,
`starDays`), `packages/engine/src/stats.ts` (`DATED_METRICS`, the `dd` CTE in `counters` and
`statsSeries`), `packages/connectors/src/search-console.ts`, `packages/connectors/src/cloudflare.ts`.
Tests: `packages/engine/test/stats-dated.test.ts`, `packages/engine/test/metrics-hourly.test.ts`,
`packages/connectors/test/analytics.test.ts`.

## Related

[[stats.md]] · [[publishing.md]] · [[search-indexing.md]] · [[tracking.md]] · [[decisions/github-app.md]] · [[decisions/post-model.md]]
