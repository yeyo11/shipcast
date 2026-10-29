---
created_at: 2026-10-27T18:21:54.106414194Z
updated_at: 2026-10-29T19:44:54.705884301Z
tags:
    - accounts
    - channels
    - connectors
    - keychain
    - oauth
    - brands
    - snapshots
    - avatars
    - github-app
    - reddit
    - profiles
    - secrets
    - youtube
---
# Accounts and channels

Built on 2026-10-25 in `@shipcast/runtime` (shared by the CLI and the [web app](web-app.md)) and the
app's Channels page. Before it, every credential lived in `.env`; now accounts are connected per
brand, checked, and kept in the secret store: the operating system's keychain on a desktop, an
encrypted file or the registry's encrypted `secrets` table on a server ([server.md](server.md)).

## The catalog

Since 2026-10-28 every channel's network comes from its adapter
(`packages/runtime/src/channels/<id>.ts`, [decisions/architecture.md](decisions/architecture.md)): how
an account is connected (`oauth` or a `form`), the fields a form asks (public ones go to the registry,
secret ones to the secret store), the `.env` variables it falls back on, the OAuth spec and token
refresh, what Shipcast does with the account in words, where the credential comes from, and the
connector it builds. `NETWORKS` in `packages/runtime/src/catalog.ts` adds the networks that are not
channels (the sources of numbers and the AI providers). A new network is its definition, its adapter,
its connector and its icon, plus a line in each registry. Every network that is a channel publishes
through its connector ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).

| Network | Connected with | Publishes | Reads |
| --- | --- | --- | --- |
| dev.to | API key | the English article, canonical to the blog | views, reactions, comments |
| Bluesky | handle and app password | a post with a link card | likes, reposts, quotes, replies, saves |
| Mastodon | OAuth on the owner's instance | a status with an image | favourites, boosts, quotes, replies |
| Instagram | Instagram Login (OAuth) | carousel, story, comment | views, reach and interactions of posts and stories; the account's last day; the profile |
| Threads | OAuth with the owner's Meta app | a post with the launch image | views, likes, replies, reposts, link clicks; the profile's views; the profile |
| LinkedIn | OAuth with the owner's LinkedIn app | a post sharing the article | — (Community Management API only) |
| Reddit | OAuth with the owner's Reddit app, a permanent refresh token | one text post per subreddit | score, comments, crossposts, upvote ratio; followers, karma |
| YouTube | OAuth with the owner's Google client | a Short and a horizontal video | views, likes, comments; the channel's numbers |
| Newsletter (Brevo) | API key | one campaign per language | sends, opens, clicks |
| Hashnode | personal access token, publication host | the English article, canonical to the blog | views, reactions, comments |
| Telegram | bot token, channel, owner's chat | a post with the launch image | — (the Bot API gives bots no counts) |
| Discord | webhook URL | a message with an embed | — (webhooks cannot read) |
| Blog analytics (Cloudflare) | API token, account id, site tag | — | visits by source |
| Google Search Console | service account JSON key | — | clicks, impressions, URL inspection |
| Bing Webmaster | API key | — | clicks, impressions, crawl state |
| Anthropic API, OpenAI-compatible server | API key; base URL and model | — | — (AI providers) |

**GitHub is not an account.** The engine reaches GitHub through the GitHub App
([decisions/github-app.md](decisions/github-app.md)), which reads each repo's stars, forks, watchers
and traffic (Administration: read). **GitHub Discussions** is a channel published with that same
access (its adapter connects `kind: 'engine'`), so it has no account of its own.

## Accounts

The registry's `accounts` table (migration `0000`) holds, per account: network, brand, label, public
settings, whether it is the brand's **primary** account on that network, the last check's status,
the identity the network reported, the problem if it failed, and its profile picture
(`avatar_url`, migration `0004_account_snapshots`). Secrets are one entry per account in the secret
store, `account:<id>`, a JSON object. The accounts repository and `AccountService` (rename, make
primary) are the only ways in.

- **Several accounts per network, one primary per brand.** A launch posts once per channel, so it
  uses the brand's primary account; the first connected becomes primary, and another can take over.
  Adding, making primary and removing run in a transaction locked per network and brand.
- **Brands never mix.** A launch only builds connectors from its own brand's accounts. `.env` is a
  fallback only for the brand it speaks for (`SHIPCAST_ENV_BRAND`, `personal` by default).
- **Checked before kept.** Connecting runs the connector's `check()`, a cheap read that proves the
  credential and its permissions; a failing credential is not saved, and the problem is said in words
  ("the token belongs to another account", "rejected: wrong, revoked or expired", "lacks a
  permission"), not as a status code. Connecting the same account again replaces its credential.
- **Import from .env.** One button checks every credential `.env` holds and moves it into the secret
  store as a connected account. The app-level settings that were in `.env` (the launches repo,
  claudio, the networks' OAuth apps) are imported on their own at start, into the Settings page
  ([decisions/github-app.md](decisions/github-app.md)).
- **`shipcast youtube import <file>`** connects YouTube once from a file with the OAuth client and a
  refresh token, through the same path as the callback, printing no value
  ([decisions/youtube.md](decisions/youtube.md)).

## The Channels page

Reshaped on 2026-10-26 (`apps/web/src/routes/_app/channels/index.tsx`).

- **Tabs by kind of network**, kept in the address (`/channels?tab=social|blog|measurement|ai`):
  Social networks, Blog & newsletter, Measurement, AI providers. `groupOf`
  (`apps/web/src/server/network-groups.ts`, tested against the real catalog) derives the tab from what
  the catalog says: an AI provider is under AI providers; a network with no channel (Cloudflare,
  Search Console, Bing) is Measurement; dev.to, Hashnode and the newsletter are Blog & newsletter;
  every other channel is Social. Without a tab in the address the page opens on the first tab with an
  account, and an account just connected opens its own tab.
- **A card per account, in the launch card's skin**: a glyph tile with a state dot (green for a passed
  check, red for a failed one, a dotted ring while unchecked), the network's name and a state pill,
  the account's avatar, name and handle with its brand, the key number (followers) with following and
  posts and the last sync under it, and the last problem explained. A network with no account yet is
  a quieter dashed card with **Connect an account**.
- **Every action is kept**: Sync now is a button on the card; the rest are in its Menu: Check the
  credential, Publish with this one, Rename, Connect another account and Disconnect, which asks first.
- **Live**: with `realtime-ui` the page reloads on `account` events ([web-app.md](web-app.md#live-pages)).

## Pictures, numbers and freshness

Built on 2026-10-25 ([decisions/account-snapshots.md](decisions/account-snapshots.md)).

- **Avatars.** A working `check()` also returns the profile's picture and name where the same answer
  has them: Bluesky, Mastodon, Instagram, dev.to, Hashnode, Reddit and a Discord webhook's own
  picture. A check that finds none, or fails, leaves the last one. Only plain `https` addresses are
  kept, never one that carries a credential, so a Telegram channel has none. Pictures are plain
  `<img>` elements, lazy, with `referrerpolicy="no-referrer"`.
- **Snapshots.** Each connector whose API counts them has `profileStats()`, returning followers,
  following and posts and an `extra` map. The daily `snapshots` job (04:00 UTC) runs
  `takeSnapshots`: every account of a known brand is checked again and, where its network counts,
  gets the day's row in `account_snapshots`. One account failing never stops the others.
  Instagram's `extra` holds the account's insights of the last 24 hours (`views1d`, `reach1d`,
  `accountsEngaged1d`, `interactions1d`, `linkTaps1d`, and from 100 followers `follows1d` and
  `unfollows1d`); Threads' the profile's views of the day before (`profileViews1d`). An insight
  the network refuses is named in the sync's line and never fails the counts.
  `shipcast sync [<account id>]` runs the same job from the terminal.
- **Freshness.** Each account shows its latest numbers and when it was last synced (`lastSynced`),
  with a warning once that is more than 36 hours old (`isStale`).
- **Sync now.** A button per account sends a `snapshots` job for that account alone (keyed
  `account:<id>`, so a second click while it waits is the same job); the page waits up to 20 seconds
  for it and says what it found.

## Profile review and edits

Built on 2026-10-27 ([decisions/account-analysis.md](decisions/account-analysis.md)).

- **A review per account.** On a network's page (`/channels/<network>`), **Review this profile** sends
  a `profile-review` job (a `heavy` one in a split deployment), which reads the profile, the account's
  growth and the brand, and asks the AI settings' `profile` task for proposals within the network's
  limits (its definition's `profile` block). The latest review is kept per account; the page follows
  the job on its events with `realtime-ui`, every few seconds without.
- **Each proposal** is a word diff against the field as it is, with an editable text, **Copy**, and,
  where the network and the credential allow it, **Apply**, which asks before it changes the real
  profile.
- **Edits** reach Mastodon (name, bio, fields; `write:accounts`), Bluesky (name, description and
  links, guarded by `swapRecord`) and a Telegram channel (title and description). dev.to, Hashnode,
  Reddit, Instagram (name, bio, website, picture) and Threads (name, bio, picture) are read but not
  edited; the links Instagram's and Threads' APIs leave out may be pasted beside the read
  (`profile.paste`). LinkedIn reads the name and photo with its token and the owner pastes the About
  section, then copies the proposals.

## The secret store

`secretStoreFor` (`packages/runtime/src/secrets.ts`) picks it by `SHIPCAST_SECRET_STORE`:

- **The keychain** (desktop default). `KeychainStore` uses the desktop keyring through its own
  command-line tools, so there is no native module: `secret-tool` (libsecret) on Linux, with the value
  on stdin, and `security` on macOS. It needs an unlocked session keyring. Entries are under the
  service `shipcast`, or `SHIPCAST_KEYCHAIN_SERVICE`, so a second install or a test copy keeps its own.
- **An encrypted file** (`file`): `<data dir>/secrets.enc`, AES-256-GCM with `SHIPCAST_SECRETS_KEY`.
- **The encrypted table** (`table`, with the `secrets-table` flag): one sealed row per secret in
  Postgres, every replica's, written atomically with a version for compare-and-set
  ([server.md](server.md#the-encrypted-secrets-table-secrets-table)). `shipcast secrets migrate` copies
  a store into it, each key read back.

Besides the accounts, the store keeps the app's session key and API-token pepper (each created once,
under a lock across processes), the TLS and ACME keys (never in the table), each Mastodon instance's
client, the owner's GitHub user token (`app:github-user`), claudio's token, the webhook secret and
the networks' OAuth app secrets.

## OAuth flows

`packages/connectors/src/oauth.ts` has the networks' flows as plain functions; each adapter's OAuth
spec says its URLs, scopes and app, and the routes under `/auth/<network>` run them. A flow's
`state` is a one-time value for ten minutes in the process's one-time store: memory, or Redis with
`redis-state`, so a callback reaching another replica still finds it.

- **Mastodon** has no central developer portal: Shipcast registers itself on the instance the owner
  names (`POST /api/v1/apps`, scopes `read:accounts read:statuses read:notifications write:statuses
  write:media write:accounts`) the first time, keeps that client in the secret store with its scopes,
  and sends the owner to authorise. A client registered with other scopes is registered again on the
  next connection. The token does not expire. `read:notifications`, which the hourly comment feed
  needs, joined on 2026-10-29: a token from before keeps publishing and reading, and its comments
  come with the daily sweep until it is connected again.
- **Instagram Login** needs the Instagram app id and secret of the owner's Meta app, set in the
  Settings page, and the callback listed exactly in its business login settings. The code becomes a
  short-lived token, swapped at once for a 60-day one, refreshed every 30 days by the
  `instagram-tokens` job.
- **Threads** and **LinkedIn** use the owner's own app, its id and secret in Settings.
- **Reddit** needs the owner's Reddit app, its client id and secret in Settings and its redirect uri
  set to `/auth/reddit/callback`. It asks for `identity submit read history edit` with
  `duration=permanent` ([publishing.md](publishing.md#reddit)); a token from before 2026-10-29 lacks
  `history` and `edit`, so finding a lost post and deleting one ask to connect again.
- **YouTube** needs the owner's Google OAuth client in Settings; scopes `youtube.upload`,
  `youtube.readonly`, `youtube.force-ssl`. With the consent screen in *Testing*, a refresh token lasts
  7 days, and an expired one asks to connect YouTube again ([decisions/youtube.md](decisions/youtube.md)).
- **The owner's GitHub user token** is refreshed under a lock shared by every process; inside it the
  token is read again and refreshed only if still due, so two replicas never spend the same refresh
  token and never delete the good one.
- Callbacks are behind the session: the `SameSite=Lax` cookie comes along on the redirect back.

## Related

[[web-app.md]] · [[publishing.md]] · [[brands.md]] · [[engine.md]] · [[server.md]] · [[decisions/architecture.md]] · [[decisions/youtube.md]] · [[decisions/redis.md]] · [[plans/goal-finish.md]] · [[status.md]] · [[decisions/account-snapshots.md]] · [[decisions/account-analysis.md]] · [[decisions/github-app.md]] · [[decisions/component-layer.md]] · [[decisions/automatic-channels-only.md]]
