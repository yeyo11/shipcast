---
created_at: 2026-10-28T17:09:04.669361223Z
updated_at: 2026-10-28T17:09:04.669361223Z
tags:
    - decision
    - publishing
    - correctness
    - idempotency
    - job-queue
    - refactor
---
# Publishing as claimed attempts: each piece sent once

Built on 2026-10-28 as phase 2 of [plans/goal-refactor.md](../plans/goal-refactor.md), behind the flag
`publishing-service` (`SHIPCAST_FLAGS`). The audit found that the round's publish step and a `publish`
job could publish the same launch at once: the round's `busy()` check was check-then-act, and most
channels were protected only by the unique `posts` row, written **after** the network call. A test
reproduces it: two runs of one launch at once post twice.

## The state machine

`publish_attempts` (migration `0013`, additive) holds one row per piece of a launch (launch, channel,
kind), written **before** the network is called:

| State | Means | Next |
| --- | --- | --- |
| `attempting` | a worker holds the claim, with a lease (20 minutes) | `live`, `retryable` or `failed`; `unknown` if the lease runs out |
| `live` | the piece went out | final for a piece; a channel's whole run may be claimed again and re-checks what is out |
| `retryable` | the network failed in a way trying again can help | claimed by the next run |
| `failed` | refused for good | waits for the owner's Try again |
| `unknown` | a worker died mid-call on a network that cannot recognise a second send | waits for the owner to check the channel and Try again |

- A claim is one `INSERT … ON CONFLICT DO UPDATE … WHERE <takeable>` statement: of any number of workers,
  exactly one gets it. After claiming, the run reads the launch's pieces again (`stillNeeded`), so one
  that read them before another's piece went out sends nothing.
- A lease that ran out is taken over only on an **idempotent** network, from the channel's definition:
  Mastodon (idempotency key) and Reddit (it looks for its submission first). Anywhere else the piece
  becomes `unknown` rather than risk a duplicate post.
- Only the holder closes its claim, so a late answer from a stale worker never overwrites another's.

## What changed around it

- `PublishingService` (`packages/engine/src/publishing/service.ts`) is the one way to publish: the job,
  a scheduled piece's wake-up, a round and the CLI.
- With the flag on, **the round only queues**: each approved launch gets its publish job, whose stately
  key runs one at a time.
- Results are typed (`failures`, `heldElsewhere`); nothing searches the problems for `' (will retry)'`.
- One Try again (`retryChannel`) replaces three implementations with different rules (web, job, CLI);
  the failure cursor's key is built and read in one module (`@shipcast/schema/failures`).
- A channel with a scheduled piece and no publisher keeps the launch drafted instead of publishing it
  and leaving the piece scheduled for ever (found by the characterisation tests).

## Related

[[decisions/architecture.md]] · [[decisions/job-queue.md]] · [[publishing.md]] · [[plans/performance-refactor.md]]