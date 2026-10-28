---
created_at: 2026-10-28T12:02:45.424748487Z
updated_at: 2026-10-28T12:02:45.424748487Z
tags:
    - measurement
    - telemetry
    - performance
    - observability
    - phase-0
    - feature-flags
---
# Measurement: provider calls, timings and checks

Built on 2026-10-28 as phase 0 of [plans/performance-refactor.md](plans/performance-refactor.md): what
Shipcast spends on providers and how fast it answers, stored per hour in the registry, so the
before/after comparison reads stored numbers instead of estimates. It changes nothing else.

## What is counted

| What | Where it is taken | Table |
| --- | --- | --- |
| Every outbound HTTP call: provider, endpoint template, method, status (0 = no answer), latency to the headers, Content-Length, rate-limit headers | `globalThis.fetch`, wrapped once per process (`installTelemetry`, `packages/runtime/src/telemetry/fetch.ts`): every connector, the GitHub client and the AI SDKs fall back to it | `provider_calls` |
| Each server function, by its name (`getLaunch`) | a function middleware (`apps/web/src/start.ts`) | `timings`, kind `fn` |
| Each page and API request, by route (`GET /launches/:n`), with a `Server-Timing: app;dur=` header | a request middleware | `timings`, kind `request` |
| Each job attempt (ok, retry, error) and its queue wait | `WorkQueue`'s handler wrapper | `timings`, kinds `job`, `job-wait` |
| Browser load and "quiet" time of fixed pages, and an idle tab's requests a minute | the hourly `probe` job (web process only): headless Chromium, signed in, routed to the process itself | `timings`, kind `browser`; `checks` |
| Missed schedules, late posts, duplicate pieces, metric freshness | the hourly `checks` job, from the registry only | `checks` |

Every call is counted under its **origin**: the server function, page, API route or job running it
(an `AsyncLocalStorage`, `telemetry/origin.ts`). That says *which* page or job spends a provider's
quota. The probe's own page loads mark their requests (`x-shipcast-probe`), and the calls they cause
are counted under `probe`, which every report leaves out.

Labels never carry a secret: the query string is dropped (some APIs take the token there), ids,
handles, file paths and Telegram's bot token in the path become placeholders
(`telemetry/classify.ts`).

## How it is stored

- One row per UTC hour, process and label, added to in place: each process keeps its counters in
  memory and upserts them once a minute (and when it stops). Two processes, or two flushes, add up.
- A latency is a histogram of fixed geometric buckets (25 % wide, `telemetry/histogram.ts`), stored as
  `{bucket: count}`. Histograms add up across processes and hours, which stored percentiles would not.
  A percentile read from them is the bucket's upper bound: it never understates, within 25 %.
- Migration `0012_telemetry` adds the three tables; it is additive.
- A write that fails keeps the counts for the next flush. Measuring never fails the work measured.

## The checks

| Check | OK when |
| --- | --- |
| `missed-schedules` | no scheduled piece is still waiting 10 minutes after its time |
| `late-posts` | no piece that went out in the last day did so more than 5 minutes after its time |
| `duplicate-pieces` | no launch has two live rows of one channel and kind, and no two rows share a network id |
| `freshness` | 99 % of live pieces of the channels Shipcast reads have a reading within the metrics cadence plus an hour (6 h until phase 8 makes it hourly); the share within 1 h is in its detail |
| `idle-tab-requests` | an idle open page asks for less than one request a minute |

They read the registry only, so they cost no provider call. A full registry-against-network
comparison needs each network's list of the account's own posts; it comes with the channel modules
(phase 3), as a capability.

## The report

```bash
node scripts/measure.ts <from>..<to>                 # one window's KPIs, JSON
node scripts/measure.ts <from>..<to> <from>..<to>    # before/after, one Markdown table per KPI
```

On the server: `sudo docker exec shipcast-web-1 node scripts/measure.ts …` (it reads
`SHIPCAST_DATABASE_URL`).

## Settings

- `SHIPCAST_PROBE_PAGES`: the pages the probe loads, comma-separated (`/,/launches/6,/stats`), or
  `off`. By default `/`, `/launches`, `/stats`.
- `SHIPCAST_FLAGS`: the refactor's switches, one per phase that changes behaviour, off unless named
  (`packages/runtime/src/flags.ts`); a name that is not a flag stops the start, rather than being
  ignored.

## The baseline

Deployed on 2026-10-28 at 11:26 UTC (`sha-1be7c0062c01`). The undeployed stop-gaps of that morning
(up to `7ed9732`, and the two plan documents) had gone out at 10:59 UTC with the owner's new
continuous deployment, before it.

The baseline window runs **from 2026-10-28T12:00Z to 2026-10-30T12:00Z** (Wednesday to Friday).
Nothing that alters it is deployed until then, and since every push to `main` deploys, the refactor's
work waits on branches.

## Related

[[plans/performance-refactor.md]] · [[plans/goal-refactor.md]] · [[server.md]] · [[decisions/job-queue.md]] · [[web-app.md]]