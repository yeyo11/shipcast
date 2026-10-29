---
created_at: 2026-10-29T16:30:18.390507021Z
updated_at: 2026-10-29T16:30:36.744043702Z
tags:
    - decision
    - postgres
    - pgbouncer
    - migrations
    - operations
    - incident
---
# The migration lock: always on the direct address, always released by hand

Decided on 2026-10-29, after the lock left on a pooled connection stopped production's processes from
starting. Fixed in `3797ae7`.

## What the lock is

Every process that opens the registry runs the migrations first (`connectPostgres`,
`packages/engine/src/db/connect.ts`). Drizzle's migrator takes no lock of its own and the app, the
workers and the CLI may start together, so the migrator takes a **session advisory lock**
(`pg_advisory_lock`) on a client of its own with `max: 1`. A session lock belongs to one server
connection for its whole life.

Since the refactor, production reaches Postgres through **PgBouncer in transaction pooling**
([server.md](../server.md#postgres-pools-and-pgbouncer)). Transaction pooling hands a server connection
to a client for one transaction only, and keeps the server connection open after the client leaves. So
the processes' pools go through PgBouncer, and the migrator is meant to connect past it, on
`SHIPCAST_DATABASE_MIGRATE_URL`.

## What happened on 2026-10-29

- **A script connected through PgBouncer.** The process roles pass `poolOptions(env)`
  (`packages/runtime/src/roles.ts`), which carries the direct address as `migrateUrl`. Two entry
  points opened the registry without it: `shipcast secrets migrate` in the CLI and
  `scripts/measure.ts`. One of them, run against production, took the migration lock through
  PgBouncer.
- **The lock stayed.** The script ended its client, which ended its connection to PgBouncer but not
  PgBouncer's session with Postgres. The lock had only ever been released by the connection's end, so
  it stayed held by an idle pooled server connection.
- **Every later start waited on it.** Each process started afterwards blocked in
  `pg_advisory_lock` forever. Production's `worker` and `heavy` went unhealthy.
- **Recovery** was an emergency rollback: the stack redeployed by hand with `deploy-stack`, and
  `pg_terminate_backend` of the idle server connection holding the lock, which released it. The
  processes then started.

## The decision

- **The migrator always connects to the direct address.** Every entry point that opens the registry
  passes `poolOptions(process.env)`, so the migrator takes `SHIPCAST_DATABASE_MIGRATE_URL` when it is
  set: the CLI's `secrets migrate` (`apps/cli/src/main.ts`) and `scripts/measure.ts` now do, as the
  process roles already did.
- **The migrator unlocks explicitly.** After the migrations, ok or not, it runs
  `pg_advisory_unlock` before it ends its client. The lock is no longer left to the connection's end,
  which behind a pooler that keeps server connections is not the session's end.

Rejected:

- **A transaction-scoped lock** (`pg_advisory_xact_lock`), which transaction pooling would keep:
  Drizzle's migrator reads what was applied and opens its own transaction for the rest, so a lock in a
  transaction of ours would not cover it.
- **No lock, relying on PgBouncer**: two processes starting together would run the same migration
  twice.

## How to apply it

- A new entry point that opens the registry (a script, a CLI command, a job runner) passes
  `poolOptions(process.env)` to `connectRepositories`, never only the URL.
- Should a start hang on the migration lock again, look for the holder in `pg_locks` (an advisory lock
  held by an `idle` backend whose client is PgBouncer) and end that backend with
  `pg_terminate_backend`; restarting Shipcast's processes alone does not free it.

## Related

[[server.md]] · [[engine.md]] · [[decisions/postgres.md]] · [[plans/performance-refactor.md]] · [[plans/refactor-report.md]] · [[plans/handoff-2026-10-29.md]]
