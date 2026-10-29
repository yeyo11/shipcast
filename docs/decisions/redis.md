---
created_at: 2026-10-29T00:06:52.17335511Z
updated_at: 2026-10-29T00:06:52.17335511Z
tags:
    - decision
    - redis
    - bullmq
    - job-queue
    - scaling
    - realtime
    - refactor
---
# Redis: queues, caches, locks and events, with Postgres as the only truth

Decided with the owner on 2026-10-28 ([plans/performance-refactor.md](../plans/performance-refactor.md),
[plans/goal-refactor.md](../plans/goal-refactor.md)) and built the same day behind the flags
`redis-state` and `bullmq`. It supersedes the queue part of [job-queue.md](job-queue.md): pg-boss
stays only until BullMQ is verified in production, then is drained and removed.

## The rule

**Postgres is the only source of truth.** Redis holds what can be lost and rebuilt from Postgres:
queued jobs, schedules, caches, counters, locks, one-time values and events. Losing either instance
costs work and re-reads, never data or correctness:
- a scheduled post is a `posts` row with `scheduled_at`; its delayed job is rebuilt from the row at
  start and every 10 minutes (`reconcileScheduled`, under a lock);
- a piece is sent once because of its Postgres claim (`publish_attempts`,
  [publishing-state.md](publishing-state.md)), never because of a Redis lock;
- a cached answer is served only when validated (an ETag) or invalidated by an event.

## Two instances

| Instance | Holds | Settings |
| --- | --- | --- |
| `redis-queue` | BullMQ's jobs and schedulers, locks, one-time values (OAuth state, console sign-in links), the API failure limiter, per-provider quotas, webhook delivery dedupe | `noeviction`, AOF `everysec`, a volume: losing an entry before its TTL would be an error, not only slowness |
| `redis-cache` | caches (GitHub ETags and files, identities and sessions of the hourly reads), version keys, pub/sub events | `allkeys-lru`, no persistence |

Both private to the stack's network, password protected (`REDIS_PASSWORD`), Redis 7.4
(yeyo11/infra `stacks/shipcast`).

## The ports (packages/runtime/src/redis)

`Cache` (TTL, `remember`, version keys bumped by events), `Lock` (`SET NX PX` with a token, renewal,
`withLock`), `EventBus` (typed events: `settings.changed`, `launch.changed`, `post.changed`,
`job.changed`, `comment.changed`, `metrics.changed`, `account.changed`, `attention.changed`,
`brand.changed`, `github.installation.changed`), `OneTimeStore` (`GETDEL`), `WindowLimiter`,
`TokenBucket` (per provider, observing the quota each provider reports), `DeliveryDedupe`. Each has a
Redis adapter and an in-memory one, sharing their logic so they cannot drift. With `redis-state` off a
single process uses the in-memory ones, as before.

**A lease lock excludes only while its holder renews it.** A process paused longer than the TTL can
find another holder beside it when it wakes. So the lock coordinates maintenance and short critical
sections; whatever must happen exactly once is decided in Postgres.

## BullMQ (packages/runtime/src/queue-bullmq.ts)

One `JobQueue` interface, implemented by pg-boss (`WorkQueue`) and BullMQ (`BullQueue`), checked by
one contract suite run against both:
- pg-boss's **stately** policy (one queued and one running per key) reproduced with per-key slots
  under a lock;
- **upsert** moves the queued job of a key, keeping its id and its `jobs` row;
- crons are BullMQ job schedulers (idempotent across processes);
- a stalled job counts as an attempt; a worker killed mid-job hands its job back when its lock
  expires, and it is never run twice at once;
- the `jobs` table stays the audit, written by one shared handler wrapper.

**Cutover:** `drainPgBoss` reports what pg-boss still holds; BullMQ starts once it is empty. Nothing
is copied from pg-boss: schedules and state are rebuilt from Postgres.

## Realtime

Every registry write announces what changed (ids only), from whichever process wrote it, over the
`EventBus`; one SSE stream per browser tab (`/api/events`) relays them, with `Last-Event-ID` resume and
a `resync` on a gap. Pages reload only the loader an event concerns; the polling intervals are gone
behind `realtime-ui` (an idle tab: about 0.2 requests a minute).

## Related

[[decisions/job-queue.md]] · [[decisions/publishing-state.md]] · [[decisions/architecture.md]] · [[plans/performance-refactor.md]] · [[server.md]]