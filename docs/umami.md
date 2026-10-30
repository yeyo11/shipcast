---
created_at: 2026-10-30T00:17:23.108283647Z
updated_at: 2026-10-30T00:17:23.108283647Z
tags:
    - umami
    - tracking
    - utm
    - metrics
    - connectors
    - feature-flags
---
# Umami: the blog's visits per launch and channel, from the links' UTM tags

Built on 2026-10-30 (card SHP-4), behind the `umami` flag, off until the owner's Umami instance
exists. Every link to the site that Shipcast publishes carries `utm_source` (the network) and
`utm_campaign` (the launch) ([tracking.md](tracking.md)), but Cloudflare Web Analytics, the blog's
analytics, keeps no query string, so the tags reached nothing. Umami does keep them: this connector
reads each launch's campaign from Umami, split by `utm_source`, and the launch page shows the visits
next to each channel's own numbers. Deploying Umami itself is an infrastructure step done apart.

## What is read

The Umami API as documented at docs.umami.is on 2026-10-30 (Umami v3; paths under `/api` on a
self-hosted instance):

| Call | What it gives |
| --- | --- |
| `GET /websites/{id}/metrics/expanded?type=utmSource&utmCampaign=<campaign>&startAt&endAt` | each source of the campaign over the launch: page views, visits, unique visitors |
| `GET /websites/{id}/pageviews?unit=day&timezone=UTC&utmCampaign=<campaign>&utmSource=<source>&startAt&endAt` | one source's page views and visitors (Umami's `sessions` series) per UTC day |
| `GET /websites/{id}/stats` | the site's visits of the last seven days, for the account's card |
| `GET /websites/{id}` | the account's check: the website's name and domain |

A launch costs one call, plus one per source that sent visits: a launch nobody visited from a
tagged link costs one. The period is the launch's day to today, read whole each time, like the
other dated sources ([decisions/dated-metrics.md](decisions/dated-metrics.md)).

**Credentials.** An API key (`umami_…`, Umami → Settings → API keys), sent as `Authorization:
Bearer`, is the documented way. Without one, a username and password are exchanged at
`POST /api/auth/login` for a token, kept in memory and asked for again once on a 401. A user with
two-factor sign-in gets no token from the login, so the check says to use an API key.

## What is kept

Source `umami`, site-level (no piece), per launch:

- **Readings** (`metrics`), since the launch: `views` and `visits` of the campaign, and for each
  source `views_<utm_source>`, `visits_<utm_source>`, `visitors_<utm_source>`. The sources' unique
  visitors are not added up: one person can come from two networks.
- **Days** (`metric_days`): `views` of the campaign, and for each source `views_<utm_source>` and
  `visitors_<utm_source>`, each under its UTC day. A day read again takes the newest value.

The campaign is `campaignOf(launch)`, the same function that tags the links when they are published,
so a launch's reads always ask for the campaign its links carry. Every published launch is read,
article or not. The cadence is `SITE_CADENCES.umami`: hourly (self-hosted, live, no quota), through
the hourly reads (`collectHourly`, the `batched-metrics` path production runs); the six-hourly
`collectMetrics` does not read Umami. A launch Umami fails for is a problem of that run and stops no
other read.

**Not in the stats.** `umami` is not one of the stats families nor a `SITE_SOURCES` entry: the same
visits are the blog's views (Cloudflare) already, and counting both would count them twice. Umami's
numbers answer "which channel brought readers", per launch.

## Where it shows

- **The launch page, Channels tab**: each tagged channel's totals line gains "N site visits" (the
  page views in its tooltip), from `visits_<utm_source>` mapped back to the channel through
  `UTM_CHANNELS` (`github` is GitHub Discussions). A channel Umami counted nothing for shows nothing.
- **Details, every number**: the `umami` readings under "Umami", like any source.
- **The Channels page, Measurement**: the "Blog analytics (Umami)" account, its card showing the
  site's visits of the last seven days.

## Configuration

An account of the `umami` network in the app (Channels → Measurement), like the other blog
analytics: the Umami address (`https://umami.example.com`; its API is under `/api`, and an address
already ending in `/api` or `/v1` is used as it is), the website id, and either the API key or a
username and password. It has no `.env` variables and is not part of Action mode.

## The flag

`SHIPCAST_FLAGS=umami` (`packages/runtime/src/flags.ts`). Off, which is production's state after
this change:

- the Channels page does not list Umami (`networksOn`), so no account can be connected;
- `buildServices` leaves the `umami` source out even if an account exists, so nothing is read;
- with nothing read, the launch page has no Umami numbers to show.

Turning it on once Umami runs: deploy Umami and add the tracker to the blog (infrastructure, apart),
add `umami` to `SHIPCAST_FLAGS`, restart, then connect the account in Channels.

## Code

`packages/connectors/src/umami.ts` (`UmamiAnalytics`), `packages/runtime/src/catalog.ts` (the
`umami` source, `networksOn`), `packages/runtime/src/services.ts` (the flag),
`packages/engine/src/metrics.ts` (`MetricSources.umami`, `campaignValues`, `campaignDays`, the read
in `collectHourly`), `packages/schema/src/channels/cadence.ts` (`SITE_CADENCES.umami`),
`apps/web/src/server/launch-summary.ts` (`channelSiteVisits`),
`apps/web/src/components/launch/Channels.tsx`. Tests: `packages/connectors/test/umami.test.ts`,
`packages/engine/test/metrics-umami.test.ts`, `packages/runtime/test/umami.test.ts`, and
`channelSiteVisits` in `apps/web/test/launch-summary.test.ts`.

## Not covered

- The blog's conversion events (a subscription, a click to the repo): Umami can count them, nothing
  sends them yet.
- Hand-written `utm_source` values outside `UTM_CHANNELS` are kept (`views_<source>`) but belong to
  no channel on the page.
- Umami's time zone is UTC for the days, as Cloudflare's and GitHub's.

## Related

[[tracking.md]] · [[decisions/dated-metrics.md]] · [[stats.md]] · [[publishing.md]] · [[accounts.md]] · [[server.md]]
