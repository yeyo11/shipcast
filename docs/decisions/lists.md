---
created_at: 2026-10-27T17:43:39.451258814Z
updated_at: 2026-10-27T17:43:39.451258814Z
tags:
    - decision
    - web-app
    - lists
    - api
    - registry
---
# The app's lists: paged in the database, hand-rolled, no TanStack Table

Decided on 2026-10-27, closing the "Lists" point of milestone 3 (the interface) of the
[goal after the MVP](../plans/goal-after-mvp.md), which asked for "lists with pagination, search,
filters and sorting on TanStack Table, over paged and indexed queries". Comments and Jobs already had
their pagers and Stats' ranking its sort; the Launches list read the newest sixty launches whole. It
now pages, searches, filters and sorts in the database. TanStack Table is not adopted.

## What was built

- **The registry** (`packages/engine/src/registry.ts`) has one launch filter, `LaunchFilter`: the
  status, what started the launch (`trigger`), the pack (`kind`), the repository, words to find and
  the order (`newest` or `oldest`, both on `(created_at, id)`). Three reads use it:
  - `launchList` gives a numbered page with the total, from a count and an `OFFSET` of the same
    `WHERE`; a page past the end shows the last one. This is the Launches page's.
  - `launchesPage` is the REST API's keyset page, now filtered and in either direction (the cursor is
    the last launch's `created_at` and id).
  - `launchFacets` gives what the filters can offer, from grouped counts: the repositories, statuses,
    triggers and kinds that some launch has, with how many, in the vocabulary's own order.
- **The words** match the repository and the ref, case-insensitively, with `%`, `_` and `\` taken as
  letters. An article keeps its title only in its ref (`article:<slug>`), so the words are also
  matched as a slug: "Hello, world" finds `article:hello-world`.
- **Indexes** (migration `0010_launches_list`, additive): `launches_by_newest` on
  `(created_at DESC, id DESC)`, and the same order after `status` (`launches_by_status`) and after
  `repo` (`launches_by_repo`). Postgres reads each forwards for the newest first and backwards for the
  oldest. The trigger and the kind have a handful of values each and are filtered while the order's
  index is walked; the words are a `LIKE '%…%'`, which no btree serves, over a table with one row per
  release. A trigram index (`pg_trgm`) is left for the day the launches number in the tens of
  thousands.
- **The Launches page** (`apps/web/src/routes/_app/index.tsx`, `components/LaunchFilters.tsx`) keeps
  its design: what waits for the owner as rows above, what went out as a grid of equal cards, split
  within each page. Its bar follows the Comments page's pattern: the words (applied once the typing
  pauses), then **Filters** (Status, Started by, Kind, and Project as a combobox with a search) in a
  popover on a desktop and a bottom sheet on a phone, with a count when any is set, then the order as
  a compact Select, then how many launches match. Twenty-four launches a page, with Previous and Next
  under the grid. Every choice is in the address (`q`, `status`, `trigger`, `kind`, `repo`,
  `sort=oldest`, `page`), read by `readLaunchesSearch` (`server/launches-search.ts`), which drops what
  is not a filter, so a view is a shareable link and a hand-edited one cannot break the page. An empty
  registry still shows the first-run illustration; a filter with no match says so and offers to show
  every launch.
- **The API**: `GET /launches` takes `q`, `trigger`, `kind`, `repo` and `sort` besides `limit`,
  `cursor` and `status`, all optional, so every earlier call answers as before ([api.md](../api.md)).

## Why numbered pages on the page and a cursor in the API

The page shows "Page 2 of 5" and keeps the page in its address, which a cursor cannot give; the
launches are few enough (one per release or article) that an offset costs nothing. A client walking
the whole list through the API is better served by a keyset, which a launch claimed meanwhile never
shifts, and that API already had one. A cursor walks the order it was given in: an oldest-first cursor
carries its order, and sending it without `sort=oldest` is refused rather than skipping launches. A
newest-first cursor is the two-item one the API always gave.

## Why no "most viewed" order

A launch's views are not a column. They are the sum, per network's view-like metric, of each piece's
latest reading plus the site sources' (`launchNumbers` in `server/launch-summary.server.ts`), from the
`metrics` history. Ordering by them would mean computing that for every launch on every page load, or
keeping a denormalised total that every metrics round updates. The Stats page's ranking already ranks
launches by popularity, normalised per network, which is the better question; the list keeps time
orders only.

## Why TanStack Table is not adopted

- **None of the app's lists is a table of columns.** Launches is a grid of cards and rows, Comments a
  stack of cards with a reply form each, Jobs a log. TanStack Table is a model of rows, columns,
  sorting, filtering and pagination in the browser; its value is in column definitions and
  client-side row models, and these lists have neither.
- **The work is the database's.** Paging, filtering and sorting happen in SQL and come back as one
  page; the browser holds 24 launches or 25 comments at a time. With TanStack Table in "manual" mode
  the library would only carry state that the address already carries (TanStack Router's search
  params, validated per route), so it would add a second source of truth.
- **Weight for nothing.** It would be another dependency in the client bundle to render what the
  hand-rolled components render now.
- **The real tables are small and done.** Stats' ranking (`components/stats/RankingTable.tsx`) and
  the search table sort on the server too; reworking them would be churn with no change for the owner.

If a list ever becomes a wide grid of columns the owner sorts and hides in the browser (an export
view, say), TanStack Table is the candidate then.

## Consequences

- A new list follows the same shape: a filter type and a paged read in the registry with an index
  for its order, a `read…Search` that cleans the address, a server function that returns the page and
  the facets, and the shared bar classes (`comment-toolbar`, `comment-search`, `stats-filters-button`,
  `comment-pager`).
- The waiting rows are split per page: a launch waiting for approval that is not on the current page
  shows on its own page and in the bell, not above every page.

## Related

[[plans/goal-after-mvp.md]] · [[web-app.md]] · [[api.md]] · [[decisions/component-layer.md]] · [[decisions/app-design-direction.md]] · [[decisions/comment-assistant.md]] · [[stats.md]]
