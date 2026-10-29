---
created_at: 2026-10-25T15:45:36.169960691Z
updated_at: 2026-10-29T20:05:28.560891148Z
tags:
    - decision
    - accounts
    - snapshots
    - avatars
    - registry
    - job-queue
    - phase-6
---
# Account snapshots: one a day, from now on

Decided on 2026-10-25, in the pull request that built it. Every connected account's followers,
following and posts are recorded once a day in the registry's `account_snapshots` table, and each
account keeps the profile picture its last check found.

## Why record them at all

No network's API gives an account's history: Bluesky, Mastodon, Instagram, dev.to, Hashnode,
Telegram and GitHub all answer with today's count only. The only way to show how an account grew,
and to analyse it later ([plans/after-mvp.md](../plans/after-mvp.md), account analysis), is to write
the number down every day from the day the account is connected. A day missed is missed for good.

## Why daily, and one row a day

- **Daily is the resolution that matters.** Followers move slowly; a launch's own numbers are
  already read every six hours per piece ([publishing.md](../publishing.md#metrics)). A daily point
  per account is enough for a growth chart and costs a handful of requests a day per account.
- **One row per account per UTC day**, its key `(account_id, day)`. A second reading the same day
  (a **Sync now** in the afternoon after the night's job) replaces the first, so the history has one
  point a day whatever the owner clicks; a reading that arrives late from earlier that day (a retried
  job) never replaces a newer one. Nulls mean "the network does not count this", which is not zero.
- **A `jsonb` `extra`** keeps whatever only one network counts, so a new number needs no migration.
- **The job runs at 04:00 UTC** (`SNAPSHOTS_CRON`), after the Instagram token refresh at 03:30, as a
  `stately` pg-boss queue (`snapshots`) beside `metrics` ([decisions/job-queue.md](job-queue.md)).
  Like the metrics, it waits while automation is off; a Sync now, sent by hand, always runs.
- **Each sync checks the account first**, so the Channels page's status, its "last synced" time and
  its picture stay fresh, and an account whose check fails records no numbers.

## What each network gives

| Network | Picture | Followers | Following | Posts | Extra |
| --- | --- | --- | --- | --- | --- |
| Bluesky | `getProfile.avatar` (public AppView) | `followersCount` | `followsCount` | `postsCount` | |
| Mastodon | `verify_credentials.avatar` | `followers_count` | `following_count` | `statuses_count` | |
| Instagram | `/me profile_picture_url` | `followers_count` | `follows_count` | `media_count` | |
| dev.to | `/users/me profile_image` | counted from `/followers/users`, 1000 a page | — | counted from `/articles/me/published` | |
| Hashnode | `me.profilePicture` | `followersCount` | `followingsCount` | `posts.totalDocuments` | |
| Telegram | none (see below) | `getChatMemberCount` | — | — | |
| Discord webhook | the webhook's avatar on `cdn.discordapp.com` | the server's `approximate_member_count`, through the account's invite | — | — | `online`: `approximate_presence_count` |
| Newsletter (Brevo) | none | contacts who can still receive it, in brand.yml's lists only | — | — | |
| GitHub profile | `avatar_url` | `followers` | `following` | — | `repos`: `public_repos` |
| Cloudflare, Search Console, Bing | none | — | — | — | the site's own numbers |

The networks without counts are still checked every day; they get no snapshot row.

**Discord** counts its members only when the account has an **invite link** (an optional field of
its form): a webhook does not see its server, and `GET /invites/{code}?with_counts=true` is public,
so no bot is needed. A temporary invite stops counting when it expires; a permanent one does not.

**The newsletter's** subscribers are the brand's lists' (brand.yml's `newsletter.lists`), not every
list of the Brevo account; a contact in both languages' lists still counts twice, since Brevo counts
each list on its own. Changed on 2026-10-29: it used to add up every list of the account.

**GitHub** is an account again, but only as the owner's public profile (the `github` network: a
login, no credential), added on 2026-10-29. The repos' own numbers still come through the GitHub App
([github-app.md](github-app.md)), never through this account.

## No address that carries a credential

A picture is stored only when it is a plain `https` URL (`imageUrl` in `packages/connectors`), and
never one that embeds a secret. Telegram is the case: a chat's photo is only downloadable at
`api.telegram.org/file/bot<token>/…`, which would put the bot token in the database and in every
browser that loads the page, so Telegram gets no picture (a proxy through the app is possible
later). Instagram's picture is a signed CDN address that expires after a few days, which is why the
picture is read again on every check rather than once. Pictures are rendered with
`referrerpolicy="no-referrer"`, so the networks' CDNs do not learn the app's address.

## What waits

Networks that push changes (Instagram's webhooks, Mastodon's streaming API) could update an account
the moment it changes; not built yet, the daily job and Sync now cover it.

## Related

[[accounts.md]] · [[engine.md]] · [[decisions/job-queue.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[decisions/github-app.md]] · [[decisions/account-analysis.md]]