---
created_at: 2026-10-25T12:35:27.31879423Z
updated_at: 2026-10-25T12:35:27.31879423Z
tags:
    - decision
    - database
    - postgres
    - drizzle
    - registry
    - phase-6
---
# PostgreSQL and Drizzle for the registry

Decided on 2026-10-25 by the owner, in the roadmap after the MVP
([plans/after-mvp.md](../plans/after-mvp.md#decisions)), and built in the first pull request of
phase 6. The launch registry — launches, posts, cursors, metrics and accounts — moves from
`node:sqlite` (`data/shipcast.db`) to **PostgreSQL**, reached through **Drizzle ORM**, with the same
tables, the same columns and the same guarantees.

## Why Postgres

SQLite allows one writer at a time, and Shipcast now has several: the web app's server functions and
its automation timer, the `shipcast` CLI (`watch`, `publish`, `metrics`), and, next in the roadmap,
an MCP server, a scheduler and the comment assistant. With WAL a second writer waits on a file lock,
and a long transaction in one process stalls every other. Postgres is built for many connections
writing at once, row locks instead of a file lock.

The next pull requests need it too: **pg-boss**, the durable job queue that replaces the in-memory
jobs and the `setTimeout` loop, runs on Postgres, so the same database holds the registry and the
work. Mongo was rejected when the roadmap was decided: launches, posts, accounts and metrics are
relational, and the statistics are joins and aggregates.

Locally it is the `postgres` service of `docker-compose.yml` (the official image, pinned to major 17,
on `127.0.0.1:5433`, data in the `postgres-data` volume), beside claudio. The app and the CLI find it
at `SHIPCAST_DATABASE_URL`, one of the few things that stay in `.env`. `SHIPCAST_DATA_DIR` keeps
meaning the folder of local files (the TLS certificate); the registry is no longer there.

## Why Drizzle

A **typed schema in TypeScript** (`packages/engine/src/db/schema.ts`) that the queries are checked
against, and **SQL migrations under version control**: `drizzle-kit generate` writes them into
`packages/engine/drizzle/`, they are reviewed in the pull request like code, and the registry
applies them at start (`migrate()`, recorded in `drizzle.__drizzle_migrations`, so a second start
applies nothing). Drizzle stays close to SQL: `ON CONFLICT DO NOTHING`, subqueries and transactions
are written as they would be by hand, with no query engine of its own between the code and the
database. An applied migration is never edited; a change is a new one.

## Keeping the guarantees

The first schema mirrors SQLite's column for column (timestamps stay ISO 8601 text, `is_primary`
stays 0 or 1, `settings` stays JSON text), so the rows move 1:1. `Registry` keeps its name and its
methods, now returning promises, and what SQLite's single writer made atomic for free is explicit:

- **A launch happens once**: `claim` is still an `INSERT … ON CONFLICT (repo, ref) DO NOTHING`,
  and Postgres makes a concurrent claim of the same release wait for the first to commit, so exactly
  one wins.
- **One post per launch and channel**: `recordPost` keeps its primary key and its `ON CONFLICT`.
- **One primary account per network and brand**: `addAccount`, `makePrimary` and `deleteAccount`
  run in a transaction holding an advisory lock on that network and brand, since under read
  committed two transactions could each see no primary and both make one.
- `retryChannel` runs in one transaction; migrations take an advisory lock, since the app and the CLI
  may start together.

A refused claim still takes a number from the `launches` id sequence, so ids can have gaps; nothing
reads meaning into them.

## Why PGlite in the tests

The tests run on [PGlite](https://pglite.dev), the real Postgres compiled to WASM, in the test
process: the same SQL, the same constraints and the same migrations as the server, with no docker
and no server to start, in CI or on a laptop. Starting one takes seconds, so each test file migrates
one instance and every test gets a clone of it (`memoryRegistry()` in
`@shipcast/engine/testing`). It is loaded on demand: the app and the CLI never load the WASM.

## Why postgres.js

The driver is [postgres.js](https://github.com/porsager/postgres) (`postgres`) rather than `pg`:
pure JavaScript with no native addon, ESM, with its own pool and prepared statements, and the
Drizzle driver (`drizzle-orm/postgres-js`) is first-class. `pg` would bring its types separately
and an optional native binding; nothing in Shipcast needs what only `pg` has.

## Moving an install

`pnpm sqlite-to-postgres` (`scripts/sqlite-to-postgres.ts`) moves an existing `data/shipcast.db`:
it opens the file read-only, migrates the Postgres at `SHIPCAST_DATABASE_URL`, copies every row in
one transaction keeping the ids, moves the id sequences past them, and prints the rows per table
before and after. It refuses a database that already holds rows; `--force` empties it first. Stop
the app and the CLI before running it, so nothing is written to the old file while it is read.

## Related

[[plans/after-mvp.md]] · [[engine.md]] · [[status.md]] · [[plans/stack.md]] · [[accounts.md]] · [[publishing.md]] · [[web-app.md]]
