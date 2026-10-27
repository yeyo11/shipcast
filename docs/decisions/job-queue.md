---
created_at: 2026-10-25T15:23:21.947209247Z
updated_at: 2026-10-27T17:29:19.251508053Z
tags:
    - decision
    - job-queue
    - pg-boss
    - automation
    - registry
    - phase-6
---
# Durable work on pg-boss

Decided in the roadmap after the MVP ([plans/after-mvp.md](../plans/after-mvp.md), "Durable work")
and built on 2026-10-25 in phase 6, on top of the registry on Postgres
([decisions/postgres.md](postgres.md)). The work that outlives a request (drafting a launch,
publishing it, an article, a channel's retry, a GitHub delivery, the automation round, the metric
reads and the Instagram token refreshes) is a job of **pg-boss**, a queue that lives in the same
Postgres as the registry. Before, jobs were promises in the web app's memory and the rounds a
`setTimeout` loop: a restart lost what was running, the 20-minute wait for a deploy was a loop
sleeping in one process, and the app and `shipcast watch` each ran rounds of their own.

## Why pg-boss

- **No new server.** It uses the Postgres the registry already needs, in its own schema (`pgboss`),
  which it creates and migrates itself when it starts: applying it to an install is a restart. Redis
  (BullMQ) would be one more service to run and back up.
- **What a job needs, built in**: retries with a delay, expiry of a job whose process died (it is
  tried again or failed), queue policies that bound how many jobs are queued and running, cron
  schedules sent once whichever process sees them, and a graceful stop.
- **It runs on PGlite**, through its `fromPglite` adapter with `backend: 'pglite'`, so the tests run
  the real pg-boss and the real SQL in the test process, as the registry's do. There is no in-memory
  stand-in to keep in step. One integration test runs against a real server when
  `SHIPCAST_TEST_DATABASE_URL` points at a throwaway database (see
  `packages/runtime/test/queue-postgres.test.ts`); without it, it is skipped.
- pg-boss brings `pg` for its own small pool (four connections); the registry keeps postgres.js.

## How it is built

`WorkQueue` (`packages/runtime/src/queue.ts`) wraps pg-boss: the queues and their settings, `send`,
`upsert`, `schedule`, `work`, `wait` and `stop`. The handlers (`packages/runtime/src/work.ts`) are
shared, so the app and `shipcast watch` are workers of the same queues and run the same code; either
may pick up a job the other sent.

| Queue | Policy | Retries | What it does |
| --- | --- | --- | --- |
| `draft`, `article` | standard | none | Drafts a claimed launch or an article; publishing directly queues `publish` |
| `publish` | stately, one key per launch | 40, every 30 s | One try at publishing; waiting for the deploy is a retry |
| `delivery` | standard | 2 | A webhook's claim (then `draft`) or merge (then `publish`) |
| `round` | stately, one key | none | Claims (when polling) and publishes what is ready; sends the next round |
| `metrics` | stately | 1 | Reads every launch's numbers; cron `0 */6 * * *` |
| `instagram-tokens` | stately | 2 | Refreshes the tokens that are due; cron `30 3 * * *` |

A draft is never retried on its own: it costs an AI run, and a failed one is recorded on the launch
for the owner to decide.

## Retries replace the waiting loop

A publish job tries once. If the site has not deployed yet, the handler throws `RetryLater`, and
pg-boss runs the job again 30 seconds later, up to 40 times: the 20 minutes the old loop slept, now
in the database, so a restart halfway through loses nothing. A partial publish whose channels will
retry does the same. On the last attempt the job fails with its reason, and the next round's publish
step picks the launch up, as before. The round leaves a launch that has a publish job waiting alone,
so the two never publish it at once.

## Singleton keys, and the chain of rounds

The round queue is `stately` and every round job carries the key `round`: there is at most one round
queued and one running, whichever process sent them. Each round ends by sending the next one, an
interval later (`automation:interval`), read again at every link so a change counts from the next
round. "Run a round now", a start and a saved setting **upsert**: the round already queued is moved,
never a second one added. With `automation:mode` off the chain stops, and the metrics and token jobs
skip unless sent by hand. A cron every ten minutes sends a round with the same key, which is dropped
while the chain has one queued, so a chain broken by a crash mends itself. Publish jobs are keyed
by their launch, so asking to publish twice returns the job already waiting.

## What is kept for the app

pg-boss's tables are its own, change with its versions and are emptied by its retention, so the app
reads a registry table instead: `jobs` (migration `0003_jobs`), one row per pg-boss job, keyed by its
id, with the title, the launch, the state (`created`, `active`, `retry`, `completed`, `failed`), the
attempts, the last 40 log lines, the link, and the created, started and ended times. The wrapper
around every handler writes it at each transition; a job a schedule sent gets its row when it starts.
At start the queue reconciles the rows still waiting or running with pg-boss, so a job it expired or
deleted is not left showing "running". The round prunes rows that ended over a fortnight ago.

The Automation page's work list has the last day's jobs (rounds only while running or failed; the
same page has the last round), paged and counted in the database; a launch's page has its own,
`/api/launches` each launch's, and the REST API's `GET /jobs` the last day's, a cursor at a time
([api.md](../api.md)).

## "The queue no longer has this job"

The line a row gets when the reconciliation at start finds no pg-boss job for it. pg-boss deletes a
job on its own only once it is old: a waiting one 14 days after its start time (its retention), an
ended one a week after it ended. So in practice the line means pg-boss's tables were changed by hand.

It was seen once, on 2026-10-26, as a failed "Automation round" in a preview, never in production:
the production registry and every backup in `data/backups/` were searched on 2026-10-27 and none has
the line. The preview (port 8763, the onboarding's copy of live data) was made from a `pg_dump` of
production taken while production's next round was queued, and its recipe then ran
`delete from pgboss.job where state in ('created','retry')` so the copy would not run production's
queued work. The registry's row of that round stayed `created`; at the preview's start the
reconciliation found no job for it and failed it with this line, and the work list shows a failed
round. Nothing ran and nothing was lost: it is harmless.

Since 2026-10-27 the line says which case it was. A row still waiting reads "The queue no longer has
this job: it was removed before it ran, so nothing was done"; one that had started reads "…: it
stopped without its end being recorded". `packages/runtime/test/queue.test.ts` reproduces the
preview's recipe. A preview that wants no queued work can keep doing so, or turn automation off
(`automation:mode`) and let the queued round find it off.

## Stopping

The app and `shipcast watch` stop their workers on SIGTERM and SIGINT, giving running jobs 20 seconds.
A job still running then stays active in pg-boss until it expires, and is tried again or failed.

## Related

[[decisions/postgres.md]] · [[decisions/post-model.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[engine.md]] · [[web-app.md]] · [[publishing.md]] · [[api.md]]