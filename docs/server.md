---
created_at: 2026-10-29T00:57:43.940170813Z
updated_at: 2026-10-29T15:35:18.257427073Z
tags:
    - server
    - deploy
    - docker
    - secrets
    - tls
    - proxy
    - redis
    - scaling
    - health
    - flags
---
# Running Shipcast on a server

Built on 2026-10-27 to move the owner's install off the laptop onto a server, `apps-1` (yeyo11/infra,
`stacks/shipcast`). The app is reachable over the tailnet only; since 2026-10-29 one route, GitHub's
webhook, is public on a hostname of its own (below). The desktop install (`pnpm app`, the keychain,
the app's own certificate) does not change; a server differs in a few places, each switched by the
environment.

Since 2026-10-28 the code can also run as several processes of different roles, with Redis and
PgBouncer beside Postgres ([plans/performance-refactor.md](plans/performance-refactor.md)), each part
behind a flag. On 2026-10-29 all of it was turned on in production.

## What production runs (2026-10-29)

Every deploy goes through CI: a push to `main` runs CI, publishes the image and deploys it to `apps-1`.
Each deploy of the refactor was made with a `pg_dump` of the registry taken first (kept on the server
and copied to the laptop), the table counts compared after it, and no scheduled post due within 20
minutes. In order:

1. `a6db7c4`, the Telegram notifier fix (the owner's notices never go to the public channel).
2. `8bab777`, the whole refactor with every flag off. Migrations 0013 to 0016 were applied, after a
   first run on a restored copy of production's registry.
3. The flags, one at a time, each added to `SHIPCAST_FLAGS` in the server's `.env` once the one before
   it was verified there: `publishing-service`, `batched-metrics`, `realtime-ui`, `redis-state`,
   `bullmq`, `secrets-table`, `ai-runner`, `github-events`. **All eight are on.** `ai-runner` was
   then retired the same day, its runner the only AI path (below, [The flags](#the-flags)).
4. `9d68d49`, pushed on 2026-10-29 and going through CI's deploy as this was written: the cold-start
   fix (`e40d8be`: npm libraries bundled into the server build and the route chunks warmed at boot,
   [Health and shutdown](#health-and-shutdown)), after a launch page's first visit after a restart
   took 11 to 15 s in production; the freshness check's fix ([measurement.md](measurement.md)); the
   first AI layer's removal and the end of the global AI budget ([claudio.md](claudio.md)).

What the stack holds now (the infra side is yeyo11/infra's pull requests, named by number):

| Part | In production |
| --- | --- |
| Processes (#21) | The same image as three services by `SHIPCAST_ROLE`: `web` (rolled out with docker-rollout, so a deploy keeps the pages up), `worker` and `heavy` (below, [Process roles](#process-roles-shipcast_role)) |
| Postgres (#21) | Behind PgBouncer in transaction pooling, with the pool settings below; the migrator connects past it |
| Redis (#9) | `redis-queue` (AOF, `noeviction`) for BullMQ, locks and one-time values; `redis-cache` (LRU) for caches and events |
| Secrets (#21) | `SHIPCAST_SECRET_STORE=table`, the encrypted `secrets` table, after `shipcast secrets migrate --from file` copied the 22 keys of the encrypted file |
| AI (#18) | Shipcast's own headless claudio, `ghcr.io/yeyo11/claudio:0.11.0-headless`, with its own volumes and `CLAUDIO_DAILY_SPEND_CAP_USD=100`, reached inside the stack at `http://claudio:8797`; its token is in a file of its own on the server. Shipcast's `claudio-url` setting and its `app:claudio-token` secret point at it, and every AI task runs on the AI task runner ([claudio.md](claudio.md)) |
| Webhooks (#10) | `shipcast-hooks.josegarrido.dev` is public and forwards only `POST /api/github/webhook`, with a per-client rate limit keyed on `Cf-Connecting-IP` (infra's decision 0014). The GitHub App's webhook URL and events were set by the owner |
| The probe (#24) | Runs on `heavy` and times `web`'s pages: `SHIPCAST_PROBE_TARGET=http://web:8744` (`apps/web/src/server/probe.server.ts`, `02f638e`) |

Seen while turning them on:

- **The BullMQ cutover** failed the one round still waiting in pg-boss with "The queue no longer has
  this job: it was removed before it ran, so nothing was done" (`NEVER_RAN`,
  `packages/runtime/src/queue.ts`). That is by design: the next round is rebuilt from Postgres, and
  was.
- **The first real article on the AI runner** with the headless claudio: the Sluice article, staged as
  yeyo11/launches#13 in two `/v1` chat completions and about 3.5 minutes, waiting for the owner's
  approval.
- **The healthchecks** made `worker` and `heavy` log an `AbortError` on every probe, because a
  finished response also closes and was aborted then. Since `f4050bf` (`apps/web/server.ts`) a
  request is aborted only when its client leaves before the response ends. Since `74dfa29` the
  `AbortError` a browser's event stream throws when it leaves `/api/events` (every page change) is
  not logged either; any other error still is.
- **The reflow check** (`apps/web/scripts/reflow-check.ts`) against production at 320, 390 and
  1280 px found no horizontal overflow. Its small-target and two axe findings were fixed in `a2e31b0`:
  44 px targets at 860 px and below, the chat and the diff scrollable from the keyboard, readable
  outside days. The date picker's days stay about 38 px at 320 px, by the owner's choice, to be
  revisited.

## What changes on a server

| On a desktop | On a server | Switch |
|---|---|---|
| Secrets in the OS keychain (`secret-tool`, `security`) | **An encrypted file**, `<data dir>/secrets.enc`: AES-256-GCM, the key in the environment only, written atomically, mode 600. With `secrets-table`: **the encrypted `secrets` table** in Postgres (below), which production uses | `SHIPCAST_SECRET_STORE=file` or `table`, `SHIPCAST_SECRETS_KEY` |
| The app does TLS itself (Let's Encrypt over Cloudflare DNS) and asks Tailscale Serve for port 443 | **A reverse proxy does TLS** (Traefik); the app serves plain HTTP inside its container, with `SHIPCAST_PUBLIC_URL` as its origin, so links point where the browser is and cookies keep `Secure` | `SHIPCAST_APP_TLS=proxy`, `SHIPCAST_APP_HOST=0.0.0.0` |
| The client is the socket's address | The client address is read from `X-Forwarded-For` only when the connection comes from a listed proxy (the API's failure limiter keys on it) | `SHIPCAST_TRUSTED_PROXIES` |
| Node, pnpm and Chromium installed by hand | **The container image** (`Dockerfile`): Node 24.22.1, pnpm, git, ffmpeg and ffprobe (the videos), Playwright's Chromium with its libraries, run as `node`; published to `ghcr.io/yeyo11/shipcast` (`sha-<12>`, `latest`) by `.github/workflows/image.yml` on every push to main | — |

`secretStoreFor` (`packages/runtime/src/secrets.ts`) picks the store for the web app, the runtime and
the certificate script. `FileStore` reads the file on every call and serialises its own writes, so a
CLI and the app on the same machine see each other's changes; it is still one machine's file, which
is why several replicas need the table.

## Moving an install's secrets

From the keychain to the file, on the machine that holds the keychain:

```bash
SHIPCAST_SECRETS_KEY=$(openssl rand -base64 32) node scripts/keychain-to-file.ts /tmp/secrets.enc
```

It lists the install's entries with `secret-tool search`, reads each value as stored with
`secret-tool lookup`, and writes them with the same `FileStore` the server opens; only the keys'
names are printed. The file goes to the server's data volume; the key goes to the server's `.env`,
apart from it.

From the file (or the keychain) to the table: `shipcast secrets migrate [--from keychain|file]`.
Every key is copied and read back (`migrateSecrets`, `packages/runtime/src/secrets-table.ts`); a key
already in the table with another value is left alone and reported as a conflict. The source is only
read, so it stays the fallback until the table is verified in use. Only key names and counts are
printed. Production moved this way on 2026-10-29 (22 keys, from the file).

## The encrypted secrets table (`secrets-table`)

`TableStore` keeps one row per secret in the registry: each value is sealed (AES-256-GCM) with a data
key of its own, and the data key with the master key `SHIPCAST_SECRETS_KEY`, which only the
environment holds, so a dump of the database opens nothing. A write changes one row atomically and
bumps its `version`; `compareAndSet` writes only over the version the caller read, which is how a
GitHub user-token refresh on one replica never overwrites another's. `SHIPCAST_SECRET_STORE=table` is
refused unless the `secrets-table` flag is on, and needs `SHIPCAST_APP_TLS=proxy` (the app's own
certificate key lives in the bootstrap store, not the table).

## Process roles (`SHIPCAST_ROLE`)

One image and one entry point (`apps/web/main.ts`); the role decides what a process takes on
(`packages/runtime/src/roles.ts`). Production runs `web`, `worker` and `heavy`:

| Role | Does |
| --- | --- |
| `all` (default) | everything in one process, as a local install runs |
| `web` | HTTP, the pages, the REST API and the event streams; enqueues work, never works a queue |
| `worker` | the short, network-bound queues (`publish`, `scheduled`, `delivery`, `round`, `metrics`, `snapshots`, `checks`, `drafts-snapshot`, `instagram-tokens`), the crons, the round, and the maintenance that keeps scheduled posts and job rows in line with the queue, under a lock every ten minutes |
| `heavy` | what runs an AI, git, Chromium, ffmpeg or satori: `draft`, `article`, `profile-review`, `assistant-check`, `comments` (it drafts replies with the AI), `probe` |

`QUEUE_ROLES` is the one table that defines the split. A `worker` or `heavy` process serves no page:
it listens in plain HTTP for its orchestrator's `/livez` and `/readyz` only. In a split no process
reconciles at boot; the worker does it under a lock. `realtime-ui` on split processes requires
`redis-state`, whose bus carries a job's events from the worker to the web replicas. YouTube's videos
are rendered inside the `publish` job, so on the `worker` role. The probe runs on `heavy`, so in a
split `SHIPCAST_PROBE_TARGET` points it at `web`; unset, it times its own process.

## Redis (`redis-state`, `bullmq`)

Two instances, both holding only what can be rebuilt from Postgres
([decisions/redis.md](decisions/redis.md)):

| Variable | Instance | Holds |
| --- | --- | --- |
| `SHIPCAST_REDIS_QUEUE_URL` | `redis-queue`: `noeviction`, AOF | BullMQ, locks, one-time values (OAuth state, console sign-in links), the API failure limiter, per-provider quotas, webhook delivery dedupe |
| `SHIPCAST_REDIS_CACHE_URL` | `redis-cache`: `allkeys-lru`, no persistence | GitHub ETag and file caches, sessions and identities of the hourly reads, pub/sub events |

A process connects to Redis only when `redis-state` or `bullmq` is on; with both off it uses the
in-memory adapters, as a single process always did. Clients connect lazily and retry for ever with
backoff, so a Redis restart is waited out. `bullmq` moves every queue from pg-boss to BullMQ on
`redis-queue` (`jobQueue`, `packages/runtime/src/queue-factory.ts`), for every role at once; a job
still waiting in pg-boss at the switch is failed as never run, and the work it stood for is rebuilt
from Postgres.

## Postgres pools and PgBouncer

Each process's pool is sized from the environment, so N processes fit behind PgBouncer in
transaction mode:

- `SHIPCAST_DB_POOL_MAX`: postgres.js's pool (10 when unset);
- `SHIPCAST_QUEUE_POOL_MAX`: pg-boss's pool (4 when unset);
- `SHIPCAST_DB_PREPARE=false`: no prepared statements, which transaction pooling does not keep;
- `SHIPCAST_DATABASE_MIGRATE_URL`: the migrator's direct connection past PgBouncer, since its session
  advisory lock needs one server connection.

## Health and shutdown

- `/api/health` answers `ok` once the app's context is up (it also starts it); the image's
  `HEALTHCHECK` uses it.
- `/livez` answers without touching anything, so a slow database never gets a live process restarted.
- `/readyz` answers 200 when the registry answers, Redis answers (when the process uses it) and the
  process is not draining; otherwise 503, with each check's state (`ok`, `draining`, `failing`) and
  the role, never an address or a message.
- **A process that serves pages is not ready until it is warm** (since 2026-10-29,
  `apps/web/src/server/warm.ts`). The server build loads its routes and server functions on demand,
  so the first visit to a page after a restart used to import that page's chunk, and every module it
  needs, while the visitor waited (11 to 15 s for a launch page in production). At boot the server
  now imports the entry's lazy chunks and the router's (one per route) and, until they are loaded,
  `/readyz` answers 503 with `{"ready":false,"checks":{"process":"warming"}}`, so the proxy keeps
  visitors on a process that has them. The wait is capped at 60 s: a stuck or slow warm-up is logged
  and stops holding readiness, so it never keeps the process out of rotation for good. A chunk that
  fails to load is logged and skipped. A `worker` or `heavy` process serves no page, so it warms
  nothing and is ready as soon as its checks are. The other half of the fix is in the build
  ([web-app.md](web-app.md#how-it-is-built)): the date, Base UI and motion libraries are bundled
  instead of loaded file by file.
- On SIGTERM or SIGINT (`packages/runtime/src/lifecycle.ts`) the process marks itself draining
  (`/readyz` turns 503), waits `SHIPCAST_DRAIN_SECONDS` (0 by default) for the proxy to notice, stops
  taking HTTP and lets requests in flight finish, stops the queue (running jobs are handed back:
  pg-boss expires them, BullMQ's lock lapses), flushes the telemetry, closes Redis and the registry.
- A request's abort signal fires only when its client leaves before the response ends
  (`apps/web/server.ts`), so a healthcheck that reads its answer and hangs up logs nothing.

## The flags

`SHIPCAST_FLAGS` is a comma-separated list (`packages/runtime/src/flags.ts`); every flag is off
unless named, and an unknown name stops the start. Production names all of them:

| Flag | Turns on |
| --- | --- |
| `publishing-service` | publishing through `PublishingService` with attempt rows ([decisions/publishing-state.md](decisions/publishing-state.md)) |
| `secrets-table` | the encrypted `secrets` table |
| `redis-state` | shared ephemeral state, caches and events in Redis |
| `bullmq` | jobs on BullMQ instead of pg-boss |
| `github-events` | pages read the drafts snapshot; GitHub is read on events and hourly |
| `batched-metrics` | hourly, batched metrics and comment feeds |
| `realtime-ui` | pages updated over server-sent events instead of polling |

A flag is turned off again by an environment change and a restart, with no deploy.

A flag whose path became the only one is **retired**: its switch is removed from the code, and its
name moves to `RETIRED` in `flags.ts`, so an environment that still lists it starts as before (the
name is accepted and ignored instead of stopping the start as unknown) and retiring a flag never
needs an environment change first. Retired so far: `ai-runner` (2026-10-29), once the AI task runner
was verified in production and the first AI layer was deleted ([decisions/ai-layer.md](decisions/ai-layer.md)).

## Webhooks

`/api/github/webhook` acts on a delivery only when `X-Hub-Signature-256` matches the GitHub App's
secret (or the older per-repo one); with `github-events` it also refuses a body over 5 MB before
reading it and drops a redelivery it already handled. In production GitHub reaches it at
`shipcast-hooks.josegarrido.dev`, a public hostname that forwards that one path and method and
nothing else, rate-limited per client; the rest of the app stays on the tailnet. With
`github-events` the poll is hourly and conditional, and `push`/`pull_request` deliveries refresh the
drafts snapshot.

## Related

[[install.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[claudio.md]] · [[measurement.md]] · [[status.md]] · [[decisions/web-app-stack.md]] · [[decisions/redis.md]] · [[decisions/architecture.md]] · [[decisions/publishing-state.md]] · [[decisions/ai-layer.md]] · [[plans/performance-refactor.md]]