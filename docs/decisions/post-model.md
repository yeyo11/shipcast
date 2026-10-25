---
created_at: 2026-10-25T13:37:28.894376587Z
updated_at: 2026-10-25T13:37:28.894376587Z
tags:
    - decision
    - registry
    - post-model
    - settings
    - metrics
    - migration
    - phase-6
---
# One row per published piece, and typed settings

Decided in the roadmap after the MVP ([plans/after-mvp.md](../plans/after-mvp.md), "Phase 6:
foundations") and built on 2026-10-25 in the second pull request of phase 6, on top of the registry
on Postgres ([decisions/postgres.md](postgres.md)). The registry's `posts` table goes from one row
per launch and channel to **one row per published piece**, readings can point at the piece they are
of, and what the owner chooses moves out of the cursors into a `settings` table. Migration
`0001_post_model` converts every install in place.

## Why one row per piece

One row per launch and channel could not say what a channel actually put out once a channel put out
more than one thing, so the extra pieces were kept wherever they fitted: the blog's two articles as
`en:<slug>,es:<slug>` in one external id, the newsletter's two campaigns as `12,13`, the Instagram
story and comment in the cursors `instagram-story:<launch>` and `instagram-comment:<launch>`, and
each newsletter language sent in `newsletter-sent:<launch>:<lang>`. Every reader had to know each
encoding, nothing could be counted or joined, and none of it recorded which account published it.
What comes next needs a piece of its own: scheduled posts, edits and deletions, a hash of what was
published, the comments under each post, and several accounts per network.

## The kinds

A piece is one of:

- `post`: the channel's post itself (a dev.to article, a Bluesky post, an Instagram carousel…);
- `story` and `comment`: what follows an Instagram post;
- `issue:<lang>`: one newsletter campaign per language;
- `article:<lang>`: one blog article per language, at its own URL, its slug as the external id.

Each row has the account it went out with (`account_id`, null for the blog, which no account
publishes, for credentials from `.env`, and for an old piece that cannot be attributed; set to null
when the account is removed, so its pieces stay), the external id and URL, a `status` (`scheduled`,
`live`, `edited`, `deleted`, `failed`; the engine records `live` today, the rest are for scheduling
and edits), a nullable `content_hash` and `scheduled_at`, and `published_at` and `updated_at`.

## Uniqueness, with nulls not distinct

"A launch happens once" now holds per piece: `posts` is unique on `(launch_id, channel, account_id,
kind)`. A plain unique constraint treats two nulls as different, so two blog articles with no
account would both be accepted; the constraint is `UNIQUE NULLS NOT DISTINCT` (Postgres 15 and
later; the install pins 17, and PGlite is 17 too), so a null account is one account for the
constraint. `recordPost` inserts with `ON CONFLICT DO NOTHING` on it and returns the row already there.

The engine also decides whether a channel is done by kind alone, whatever the account: a channel
with its `post` is never posted again even if the primary account changed since, and the newsletter
is done once every language with a list has its issue. Each piece is recorded the moment it is out
(the Instagram post before its story and comment, each issue before the next language is sent), so a
failure afterwards never sends it twice.

## Metrics per post

`metrics` gains a nullable `post_id`: a reading of a post or a newsletter issue points at it, and
`postMetrics(post)` reads it back. The site-level sources (the blog's visits, Search Console, Bing,
GitHub) stay readings of the launch, with no post. A launch's numbers are its pieces' added up at
the same moment (every round reads all of them at one moment), so the two issues are one newsletter
reading on the launch's page, as before, and each issue can be told apart.

## Settings and cursors

Cursors were holding two different things: positions and state (an ETag, the last event id, a
channel's permanent failure, each article's index status, the last round) and what the owner chose
(the automation mode and interval). Choices get a `settings` table (`key`, a `jsonb` value,
`updated_at`) read typed with `setting<T>(key)` and written with `setSetting(key, value)`, so a
number is stored as a number; the onboarding, the AI settings and the prompts go there next. Cursors
keep positions and state only.

## Converting in place

The conversion is SQL inside the migration, applied at start like every migration, in the one
transaction Drizzle's migrator runs them in, so a failure leaves the registry as it was; each insert
also skips what is already there. On each install:

- each blog row becomes one `article:<lang>` row per `<lang>:<slug>` pair, at
  `<origin of the old URL>/<lang>/<slug>/`, so the site is never written into the migration; an
  older row with one slug for both languages becomes both articles at that slug, as the metrics
  assumed;
- the newsletter's issues come from the `newsletter-sent:<launch>:<lang>` cursors, which held each
  campaign's id and report URL (including an issue whose sibling was still being retried, which had
  no post row yet); a row with no cursors left is split in the order the ids were sent, English first;
- the Instagram story and comment cursors become `story` and `comment` rows of the same launch, by
  the account of its post and dated as the post;
- every other row is a `post`, `live`, by the account that was primary for its network and brand
  when the migration ran, if there is one;
- the channels' readings point at their posts; the old newsletter readings stay the launch's, since
  each was the sum of both issues;
- `automation:mode` and `automation:interval` become settings;
- the cursors that became rows or settings are deleted only once copied; a cursor of a launch that no
  longer exists, or a value that cannot be read, stays.

It was run on a copy of the owner's live registry before merging: 14 rows became 23 (6 articles, 4
issues, 2 stories, 2 comments, 9 posts), every reading of a post attached, and the launches read the
same. The SQLite copy (`pnpm sqlite-to-postgres`) now lands in the first migration's schema, which
is SQLite's, and this migration converts it like any install; `migrateDatabase(db, { upTo })` is
what lets it, and the tests of the conversion, stop at the first schema.

## Related

[[decisions/postgres.md]] · [[plans/after-mvp.md]] · [[engine.md]] · [[publishing.md]] · [[accounts.md]] · [[web-app.md]]
