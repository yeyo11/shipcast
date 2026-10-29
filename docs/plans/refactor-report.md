---
created_at: 2026-10-29T16:28:25.224404758Z
updated_at: 2026-10-29T16:29:32.899964029Z
tags:
    - plan
    - report
    - performance
    - measurement
    - refactor
---
# Report: the performance refactor, before and after

The comparison the [performance plan](performance-refactor.md) asked for, one table per KPI, written
on 2026-10-29 when the owner stopped the measurement. The numbers come from the stored hours
([measurement.md](../measurement.md)), read with `node scripts/measure.ts <before> <after>`:

- **Before**: 2026-10-28T12:00Z to 2026-10-29T08:00Z, 20 hours with numbers in every one, the code
  before the refactor (`sha-1be7c0062c01`).
- **After**: 2026-10-29T13:00Z to 2026-10-29T15:00Z, **2 hours**, with every flag of the refactor on
  ([server.md](../server.md#what-production-runs-2026-10-29)). The Sluice article was published
  during it.

Per-day values are the window's counts scaled to 24 hours, so an after value is its 2 hours times 12.
A latency is a percentile read from histogram buckets 25 % wide, given as the bucket's upper bound: it
never understates, and a change of 20 % or 25 % is one bucket, within the resolution. Read the
[caveats](#caveats) before any number.

## Summary

| KPI | Target | Result |
| --- | --- | --- |
| Provider calls per day | −70 % | **missed**: −29 %, inflated by the article's publish |
| GitHub calls per day; 304s | −80 %; above 60 % | calls **missed** (−54.7 %); 304s **met** (61.7 %) |
| `getLaunch` p95, external calls | under 150 ms, 0 | calls **met** (0); time **missed** (264.7 ms, from 1,972 ms) |
| Launch page load p95 | under 1 s | **missed**: 1,578 ms, from 3,852 ms |
| Idle tab requests a minute | under 1 | **met**: 0 |
| Comment runs | one call per account | calls per run −58.5 %; see below |
| Metric freshness | 99 % within cadence | **not shown**: the check was miscounting (fixed after the window) |
| Duplicates / missed schedules / mismatches | 0 / 0 / 0 | 0 / 0 / not measured |
| Peak quota use | under 50 % | **met**: 20 % at most |
| Scale test | 0 / 0 / 0 | **not run** |
| Chaos tests | no duplicate, no lost job | **not run** |
| Places to edit to add a network | 1 module and 1 registry line | 4 files and 2 registry lines |
| Duplicated helpers and channel maps | 0, one channel registry | met |

## Provider calls per day, total and per provider

Target: −70 % or better, with metrics read more often.

| | Before | After | Change |
| --- | --- | --- | --- |
| **Total** | 3,919.2 | 2,784 | −29 % |
| github | 2,251.2 | 1,020 | −54.7 % |
| instagram | 306 | 456 | +49 % |
| devto | 301.2 | 84 | −72.1 % |
| josegarrido.dev | 301.2 | 204 | −32.3 % |
| mastodon | 301.2 | 120 | −60.2 % |
| bluesky | 162 | 156 | −3.7 % |
| threads | 100.8 | 168 | +66.7 % |
| google | 51.6 | 264 | +411.6 % |
| bing | 40.8 | 24 | −41.2 % |
| telegram | 33.6 | 60 | +78.6 % |
| brevo | 21.6 | 96 | +344.4 % |
| cloudflare | 21.6 | 48 | +122.2 % |
| local | 7.2 | 0 | −100 % |
| discord | 4.8 | 36 | +650 % |
| scontent-fra5-1.cdninstagram.com | 4.8 | 0 | −100 % |
| cdn.discordapp.com | 2.4 | 0 | −100 % |
| files.mastodon.social | 2.4 | 0 | −100 % |
| linkedin | 2.4 | 48 | +1,900 % |
| media.licdn.com | 2.4 | 0 | −100 % |

Metrics are read more often, as the target asks: 24 metric runs a day instead of 4.8, each with 11
provider calls instead of 38. The providers that rose are those a publish calls (the newsletter
through Brevo, YouTube through Google, the social networks the article went out on), in a 2-hour
window that held a publish, and Cloudflare's Web Analytics, read with the metrics, which are hourly
now. GitHub, dev.to, Mastodon, the blog and Bing fell between 32 % and 72 %.

## GitHub calls per day and the share answered 304

Target: −80 %; 304s above 60 %.

| | Before | After | Change |
| --- | --- | --- | --- |
| Calls per day | 2,251.2 | 1,020 | −54.7 % |
| Share of GETs answered 304 | 10.6 % | 61.7 % | +482.1 % |

The 304 target is met: every GET is conditional through the ETag cache (`9007c87`). The volume is not:
the article's publish reads and writes the launches repo, and a 2-hour window gives that weight.

## `getLaunch` p95 (server)

Target: under 150 ms and 0 external calls.

| | Before | After | Change |
| --- | --- | --- | --- |
| p95 | 1,972.2 ms | 264.7 ms | −86.6 % |
| Provider calls per run | 8.24 | 0 | −100 % |

No external call: the launch page reads the drafts snapshot (`c3a98d7`), and a page loader that
reaches a provider fails its test (`cb229dd`). 264.7 ms is a bucket's upper bound, so the real p95 lies
between about 212 and 265 ms, above the target.

## Launch page with 13 drafts, load p95

Target: under 1 s. The page is the REA article's launch, `/launches/6`, loaded by the hourly probe in
headless Chromium.

| | Before | After | Change |
| --- | --- | --- | --- |
| `/launches/6`, load | 3,851.9 ms | 1,577.7 ms | −59 % |
| `/launches/6`, settled | 4,814.8 ms | 2,465.2 ms | −48.8 % |
| `/`, load | 3,081.5 ms | 2,465.2 ms | −20 % |
| `/stats`, load | 1,262.2 ms | 1,009.7 ms | −20 % |

Two probe runs fall in a 2-hour window, so the p95 is close to the worst of them, and the first page
loaded after a deploy paid a cold start ([caveats](#caveats)).

## UI requests per idle open tab per minute

Target: under 1.

| | Before | After | Change |
| --- | --- | --- | --- |
| `idle-tab-requests`, share of runs ok | 95 % | 100 % | +5.3 % |
| `idle-tab-requests`, worst | 2 | 0 | −100 % |

An idle tab holds one event stream (`/api/events`) and asks for nothing.

## Comment runs

Target: one call per account, not per post.

| | Before | After | Change |
| --- | --- | --- | --- |
| Runs per day | 52.8 | 48 | −9.1 % |
| Average | 4,542.8 ms | 4,097.4 ms | −9.8 % |
| Provider calls per run | 20.5 | 8.5 | −58.5 % |
| Failures | 4 | 0 | −100 % |

The stored numbers count calls per run, not per account, so the target itself is shown by the code:
each account's comments are read from its own feed in one call (`8ccbf2d`), with tests. 8.5 calls per
run is below the 12 connected accounts.

## Metric freshness

Target: within cadence 99 % of the time.

| | Before | After | Change |
| --- | --- | --- | --- |
| `freshness`, share of runs ok | 0 % | 0 % | 0 % |
| `freshness`, worst | 0.55 | 0.76 | +39.3 % |

Neither number measures the target: the check counted pieces that have no numbers of their own
([caveats](#caveats)).

## Duplicates, missed schedules, registry against network

Target: 0 / 0 / 0.

| | Before | After | Change |
| --- | --- | --- | --- |
| `duplicate-pieces`, share ok / worst | 100 % / 0 | 100 % / 0 | 0 |
| `missed-schedules`, share ok / worst | 100 % / 0 | 100 % / 0 | 0 |
| `late-posts`, share ok / worst | 100 % / 0 | 100 % / 0 | 0 |

The registry against network comparison is not measured: the checks read the registry only, and no
check lists each network's own posts yet ([measurement.md](../measurement.md#the-checks)).

## Peak quota use per provider

Target: under 50 % of its limit.

| | Before | After | Change |
| --- | --- | --- | --- |
| bluesky | 10 % | 10 % | 0 % |
| discord | 20 % | 20 % | 0 % |
| github | 2.4 % | 0.3 % | −87.5 % |
| mastodon | 2.7 % | 3.3 % | +22.2 % |
| threads | 1 % | 1 % | 0 % |

Only the providers that send quota headers appear.

## Scale test

Target: 3 web, 2 worker and 1 heavy replicas (24 h by the owner's decision of 2026-10-28) with 0
duplicates, 0 missed schedules, 0 mismatches, no lost secret writes and no failed OAuth callbacks.

**Not run.** The driver and its check of plan, registry and fake networks exist (`scripts/scale-test.ts`,
`7ccf29b`), as do fake networks for every channel (`744e74a`). The preview stack it runs against is
ready in [yeyo11/infra#25](https://github.com/yeyo11/infra/pull/25), not merged.

## Chaos tests

Target: kill a worker mid-publish, restart Redis, roll a deploy: no duplicate, no lost job, schedules
rebuilt from Postgres.

**Not run**, for the same reason. The driver counts requests to a replica that was stopping apart, for
the rolling deploy (`330ef77`). Production saw one unplanned case: the BullMQ cutover failed the
one round still in pg-boss as never run, and the next round was rebuilt from Postgres
([server.md](../server.md#what-production-runs-2026-10-29)).

## Places to edit to add a network

Target: from about 40 to 1 module and 1 registry line.

| Before | After |
| --- | --- |
| about 30 files, with per-channel tables that had drifted apart | 4 files (definition, adapter, connector, icon) and 2 registry lines, plus 2 route files for OAuth |

Not met to the letter: the layering forbids I/O in the domain, so a channel is a pure definition and a
runtime adapter, each in its own registry. YouTube was the first network built this way
([decisions/architecture.md](../decisions/architecture.md)).

## Duplicated helpers and channel-name maps

Target: 0 duplicates; one channel registry.

Met: the helpers exist once (phase 1), every per-channel table derives from the channel registry, and
dependency-cruiser's rules, run by `pnpm typecheck`, keep the old `Registry` facade gone and the
entry points off connectors and repositories ([decisions/architecture.md](../decisions/architecture.md)).

## Other numbers

| Job | Before | After | Change |
| --- | --- | --- | --- |
| round: average, calls per run | 3,157.7 ms, 7.1 | 979.6 ms, 1.6 | −69 %, −77.5 % |
| metrics: runs a day, average, calls per run | 4.8, 33,622.6 ms, 38 | 24, 8,642.8 ms, 11 | +400 %, −74.3 %, −71.1 % |
| publish: runs a day, average, calls per run | 4.8, 28,956.9 ms, 16.3 | 48, 67,665.9 ms, 24.3 | +900 %, +133.7 %, +49.1 % |
| snapshots: runs a day, calls per run | 10.8, 4.8 | 132, 2.2 | +1,122 %, −54.2 % |
| `syncAccountNow` p95 | 9,404 ms | 4,814.8 ms | −48.8 % |
| `whoAmI` p95 | 44.4 ms | 7.5 ms | −83.1 % |

Some server functions' p95 rose (`getAttention` 108 → 169 ms, `getSearch` 108 → 212 ms,
`getOnboardingState` 44 → 169 ms), each from a handful of calls in 2 hours.

## Caveats

- **The after-window is 2 hours, not 48.** The plan asked for 48 h after, the same hours of the day as
  the baseline; the owner stopped the measurement on 2026-10-29. Two hours scaled to a day multiply any
  one event by 12, and the percentiles rest on few samples. Every number above is a direction, not a
  measurement of the target.
- **The Sluice article was published inside the window.** Its publish runs (4 in 2 hours, 48 a day
  scaled), their longer average and the snapshots that follow a publish inflate the publish job and
  the providers it calls: Google (YouTube's two videos), Brevo (the newsletter), LinkedIn, Discord,
  Telegram, Threads, Instagram and GitHub. The baseline held no publish of that size.
- **Freshness read 0.76 because stories and comments were counted.** The check counted Instagram's
  story and link comment, which have no numbers of their own, as never read, while every readable
  piece had been read within the hour. Fixed by `085974f` (`readsMetrics` in the channel registry,
  the same rule the metrics rounds use), which went out after the window; the baseline's 0.55 has the
  same error in it ([measurement.md](../measurement.md#the-checks)).
- **The first request after a deploy paid a cold start.** The server build left npm packages
  external, so a launch page's first visit after a restart imported about 2,900 modules and took 11 to
  15 s in production. Fixed by `e40d8be`: the date, Base UI and motion libraries are bundled, and a
  page-serving process warms its route chunks at boot before `/readyz` lets it in. It shipped after
  the window, so the page loads above may hold one such visit.
- **The scale and chaos tests were not run.** Their driver is written; the preview stack is ready in
  [yeyo11/infra#25](https://github.com/yeyo11/infra/pull/25) and waits to be merged. Until they run,
  horizontal scale is built but not proven.

## Related

[[plans/performance-refactor.md]] · [[plans/goal-refactor.md]] · [[measurement.md]] · [[server.md]] · [[decisions/architecture.md]] · [[decisions/redis.md]] · [[plans/handoff-2026-10-29.md]] · [[status.md]]
