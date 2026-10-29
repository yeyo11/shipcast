---
created_at: 2026-10-28T07:09:52.970356924Z
updated_at: 2026-10-29T00:57:23.500022344Z
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

Built on 2026-10-27 to move the owner's install off the laptop onto a server (yeyo11/infra,
`stacks/shipcast`), reachable over the tailnet only. The desktop install (`pnpm app`, the keychain,
the app's own certificate) does not change; a server differs in a few places, each switched by the
environment.

Since 2026-10-28 the code can also run as several processes of different roles, with Redis and
PgBouncer beside Postgres ([plans/performance-refactor.md](plans/performance-refactor.md)). **All of
it is built and behind flags; none of it is turned on in production.** Production today runs one
process (`SHIPCAST_ROLE` unset, so `all`) with `SHIPCAST_FLAGS` empty: pg-boss in Postgres, the
encrypted secrets file, no Redis. Each flag is turned on only once its phase is verified there.

## What changes on a server

| On a desktop | On a server | Switch |
|---|---|---|
| Secrets in the OS keychain (`secret-tool`, `security`) | **An encrypted file**, `<data dir>/secrets.enc`: AES-256-GCM, the key in the environment only, written atomically, mode 600. With `secrets-table`: **the encrypted `secrets` table** in Postgres (below) | `SHIPCAST_SECRET_STORE=file` or `table`, `SHIPCAST_SECRETS_KEY` |
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
printed.

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
(`packages/runtime/src/roles.ts`):

| Role | Does |
| --- | --- |
| `all` (default) | everything in one process, as today |
| `web` | HTTP, the pages, the REST API and the event streams; enqueues work, never works a queue |
| `worker` | the short, network-bound queues (`publish`, `scheduled`, `delivery`, `round`, `metrics`, `snapshots`, `checks`, `drafts-snapshot`, `instagram-tokens`), the crons, the round, and the maintenance that keeps scheduled posts and job rows in line with the queue, under a lock every ten minutes |
| `heavy` | what runs an AI, git, Chromium, ffmpeg or satori: `draft`, `article`, `profile-review`, `assistant-check`, `comments` (it drafts replies with the AI), `probe` |

`QUEUE_ROLES` is the one table that defines the split. A `worker` or `heavy` process serves no page:
it listens in plain HTTP for its orchestrator's `/livez` and `/readyz` only. In a split no process
reconciles at boot; the worker does it under a lock. `realtime-ui` on split processes requires
`redis-state`, whose bus carries a job's events from the worker to the web replicas.

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
`redis-queue` (`jobQueue`, `packages/runtime/src/queue-factory.ts`), for every role at once.

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
- On SIGTERM or SIGINT (`packages/runtime/src/lifecycle.ts`) the process marks itself draining
  (`/readyz` turns 503), waits `SHIPCAST_DRAIN_SECONDS` (0 by default) for the proxy to notice, stops
  taking HTTP and lets requests in flight finish, stops the queue (running jobs are handed back:
  pg-boss expires them, BullMQ's lock lapses), flushes the telemetry, closes Redis and the registry.

## The flags

`SHIPCAST_FLAGS` is a comma-separated list (`packages/runtime/src/flags.ts`); every flag is off
unless named, and an unknown name stops the start:

| Flag | Turns on |
| --- | --- |
| `publishing-service` | publishing through `PublishingService` with attempt rows ([decisions/publishing-state.md](decisions/publishing-state.md)) |
| `secrets-table` | the encrypted `secrets` table |
| `redis-state` | shared ephemeral state, caches and events in Redis |
| `bullmq` | jobs on BullMQ instead of pg-boss |
| `github-events` | pages read the drafts snapshot; GitHub is read on events and hourly |
| `batched-metrics` | hourly, batched metrics and comment feeds |
| `realtime-ui` | pages updated over server-sent events instead of polling |
| `ai-runner` | every AI task through the AI task runner ([decisions/ai-layer.md](decisions/ai-layer.md)) |

A flag is turned off again by an environment change and a restart, with no deploy.

## Webhooks

`/api/github/webhook` verifies `X-Hub-Signature-256` before reading anything (the GitHub App's
secret, or the older per-repo one). It needs a public route to the server, which the server does not
have today, so the engine polls; with `github-events` the poll becomes hourly and conditional, and
`push`/`pull_request` deliveries refresh the drafts snapshot.

## Not on a server

- **claudio**: not run beside the server's install (owner, 2026-10-27); the AI provider is set to the
  Anthropic API or an OpenAI-compatible server in the app's AI settings. A local install runs it from
  `docker-compose.yml` ([claudio.md](claudio.md)).

## Related

[[install.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[claudio.md]] · [[measurement.md]] · [[decisions/web-app-stack.md]] · [[decisions/redis.md]] · [[decisions/architecture.md]] · [[decisions/publishing-state.md]] · [[decisions/ai-layer.md]] · [[plans/performance-refactor.md]]