---
created_at: 2026-10-28T17:08:48.348470608Z
updated_at: 2026-10-28T17:08:48.348470608Z
tags:
    - decision
    - architecture
    - solid
    - channels
    - services
    - repositories
    - dependency-rules
    - refactor
---
# Architecture: layers, one module per channel, services and repositories

Decided with the owner on 2026-10-28 in [plans/performance-refactor.md](../plans/performance-refactor.md)
and built the same day as phases 1 to 4 of [plans/goal-refactor.md](../plans/goal-refactor.md). Before it,
adding a network meant editing about 30 files whose per-channel tables had drifted apart; use cases were
written two or three times (retry, multi-edit, publish and notify, error mapping); web server functions
called a 1,600-line `Registry` class directly.

## Layers and the dependency rule

```text
entry points   web server functions · REST API · MCP (via the API) · CLI · job handlers
                 ↓  validate input, call one application service, map the result
application    packages/engine/src/services, packages/engine/src/publishing
                 ↓  depend on narrow ports (packages/engine/src/ports.ts)
domain         packages/schema: channel definitions, pack schema, rules, errors (pure)
                 ↑  implemented by
adapters       repositories (Postgres) · connectors · HttpClient · Redis · BullMQ · runtime channel adapters
```

The rules are dependency-cruiser's (`.dependency-cruiser.cjs`), run by `pnpm typecheck`, so by the
Sluice gate and CI:

| Rule | Says |
| --- | --- |
| `schema-is-pure`, `schema-imports-no-workspace-package` | the domain imports no I/O module and no other package |
| `connectors-import-only-schema` | a connector knows the domain and nothing else |
| `engine-not-runtime-or-apps`, `runtime-not-apps`, `packages-not-apps` | dependencies point inwards |
| `web-entry-points-not-connectors-or-registry` | routes, components and `*.functions.ts` never import a connector or a repository |
| `no-registry-facade`, `repositories-composed-in-one-place` | the old `Registry` stays gone; the repositories are built where a process is composed |
| `no-cycles-between-packages` | no cycles |

## One module per channel, in two halves

The layering forbids I/O in the domain, so a channel is two files with one id:

- **The definition**, `packages/schema/src/channels/<id>.ts`: names (one canonical, one in-sentence),
  icon, default mode, the content-pack piece, the prompt brief, draft files and how they are read back,
  limits and how text is counted, capabilities (edit fields, delete, comments, replies, metrics,
  profile, scheduling), posting windows, metric families, whether a second send is safe
  (`idempotent`). Listed in `channels/registry.ts`; every per-channel table is derived from it, and
  `@shipcast/schema/channels` is safe in the browser.
- **The adapter**, `packages/runtime/src/channels/<id>.ts`: how it is reached (form fields, `.env`
  variables, OAuth spec, token refresh), the connector factory and the capability wiring (publisher,
  editor, metric reader, comment reader and replier, notifier, publish strategy). Listed in
  `runtime/src/channels/registry.ts`.

Contract tests run every definition and every adapter through the same suite, and a fake network added
as one definition and one adapter appears in every derived table, in the Channels catalog, and
publishes through `PublishingService`. **A new network costs four files (definition, adapter, connector,
icon) and two registry lines**, plus two route files when it signs in with OAuth. YouTube was the
first built this way ([youtube.md](youtube.md)).

The drift the audit found is gone by construction: Threads has an icon; the assistant's draft files and
`draftPrefill` find every channel's files (`github-discussion.md`, `newsletter-<lang>.md`,
`reddit-<sub>.md`); each channel has one name everywhere.

## Application services

One implementation of each use case, reached by every entry point:

| Service | Use cases |
| --- | --- |
| `PublishingService` | publish a launch under per-piece claims, Try again, publish again ([publishing-state.md](publishing-state.md)) |
| `PostService` | edit, delete, edit many (one implementation for the page and the API), delete a launch's posts |
| `ScheduleService` | schedule, move, cancel, recommended times, time zone |
| `CommentService` | list, edit a draft, send, dismiss, settings |
| `MetricsService`, `LaunchService`, `AccountService`, `SettingsService` | read now; claim, draft, approve; accounts; settings |
| `NotificationService` | the one publish notice, sent to the owner's private chat only |

Errors share one base, `ShipcastError` (code, retryable, HTTP status), and are mapped to HTTP in one
place (`apps/web/src/server/errors.ts`) for the REST API and the server functions alike.

## Repositories

The `Registry` class is gone. One repository per aggregate in `packages/engine/src/repositories/`
(launches, posts, publish attempts, metrics, accounts and snapshots, jobs, comments, settings, cursors,
API tokens, assistant sessions, attention, secrets, raw read queries), bundled as `Repositories` and built
once per process. `inTransaction` spans several when a use case needs it. Consumers take a `Pick` of what
they use.

## Cross-cutting pieces written once

`HttpClient` (timeouts, retries honouring `Retry-After` on what is safe to repeat, quota headers, ETag
cache, call hooks), the structured logger (pino, correlation ids on the same async context as the
measurement's origin), and the shared test kit (`@shipcast/engine/testing`: fake GitHub, fake
connectors, clock, queue, fixtures) replacing hand-written fakes.

## Related

[[plans/performance-refactor.md]] · [[plans/goal-refactor.md]] · [[decisions/publishing-state.md]] · [[decisions/youtube.md]] · [[decisions/redis.md]] · [[measurement.md]] · [[engine.md]]