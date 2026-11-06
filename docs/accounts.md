---
created_at: 2026-11-05T11:02:46.516416362Z
updated_at: 2026-11-06T07:14:35.584628227Z
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
    - instagram
    - facebook
    - meta
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
channels (the sources of numbers, the owner's GitHub profile and the AI providers). A new network is
its definition, its adapter, its connector and its icon, plus a line in each registry. Every network
that is a channel publishes through its connector
([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).

| Network | Connected with | Publishes | Reads |
| --- | --- | --- | --- |
| dev.to | API key | the English article, canonical to the blog | views, reactions, comments; daily, saves, read time and referrers (Forem's analytics) |
| Bluesky | handle and app password | a post with a link card | likes, reposts, quotes, replies, saves |
| Mastodon | OAuth on the owner's instance | a status with an image | favourites, boosts, quotes, replies |
| Instagram | OAuth, one of three logins: Instagram Login (the Instagram app), Unified Login or Facebook Login for Business (the Meta app) | carousel, story, comment | views, reach and interactions of posts and stories; the account's last day; the profile |
| Facebook | OAuth, Facebook Login for Business with the owner's Meta app; one account per Page shared | a post with the article as its link card | views, clicks, reactions, comments, shares per post; the Page's followers, likes, follows and post engagements; its About text and picture |
| Threads | OAuth with the owner's Meta app | a post with the launch image | views, likes, replies, reposts, link clicks; the profile's views; the profile |
| LinkedIn | OAuth with the owner's LinkedIn app | a post sharing the article | — (Community Management API only) |
| Reddit | OAuth with the owner's Reddit app, a permanent refresh token | one text post per subreddit | score, comments, crossposts, upvote ratio; followers, karma |
| YouTube | OAuth with the owner's Google client | a Short and a horizontal video | views, likes, comments; daily, watch time, engaged views, shares (YouTube Analytics); the channel's numbers and profile |
| Newsletter (Brevo) | API key | one campaign per language | sends, opens (unique, total, Apple MPP's, trackable), clicks (unique, total, per link); the subscribers of brand.yml's lists |
| Hashnode | personal access token, publication host | the English article, canonical to the blog | views, reactions, comments |
| Telegram | bot token, channel, owner's chat | a post with the launch image | each post's reactions, from the changes Telegram pushes to the bot; the channel's members |
| Discord | webhook URL; optionally an invite link | a message with an embed | each message's reactions, read back through the webhook; the server's members, through the invite |
| GitHub profile | a login, no credential | — | the owner's public profile; followers, following, public repos |
| Blog analytics (Cloudflare) | API token, account id, site tag | — | page views and visits, by source and per day |
| Google Search Console | service account JSON key | — | clicks and impressions per day, CTR, position, URL inspection with the canonical |
| Bing Webmaster | API key | — | clicks, impressions, crawl state |
| Anthropic API, OpenAI-compatible server | API key; base URL and model | — | — (AI providers) |

The per-day readings are kept under the day they happened ([decisions/dated-metrics.md](decisions/dated-metrics.md)).

**The repos are not an account.** The engine reaches GitHub through the GitHub App
([decisions/github-app.md](decisions/github-app.md)), which reads each repo's stars, forks, watchers
and traffic (Administration: read). **GitHub Discussions** is a channel published with that same
access (its adapter connects `kind: 'engine'`), so it has no account of its own. The **GitHub
profile** account, added on 2026-10-29, is only the owner's public profile, read through GitHub's
public API with no token, for the profile review and the daily snapshot; it never publishes and
never reads a repo.

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
- **The same account is found by its network id** (since 2026-11-06,
  [decisions/meta-logins.md](decisions/meta-logins.md)). Where a network's settings carry a stable id
  (`pageId` for Facebook, `userId` for Instagram and Threads), reconnecting matches on it, so a renamed
  Page or account updates its row and two Pages with the same name stay two accounts. A row stored
  before it had that id is still found by its label, and the other networks match by label alone. A
  label is unique per network and brand, so a new account whose name is taken is labelled
  "Name (id)"; an account found by its id keeps the label it has, which may be one the owner typed.
- **Import from .env.** One button checks every credential `.env` holds and moves it into the secret
  store as a connected account. The app-level settings that were in `.env` (the launches repo,
  claudio, the networks' OAuth apps, the Instagram setup and the Meta configuration ids) are imported
  on their own at start, into the Settings page ([decisions/github-app.md](decisions/github-app.md)).
  `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN` always mean an Instagram Login account: a Unified
  or Facebook Login token cannot come from `.env`, nor through Action mode, and Facebook has no `.env`
  variables at all.
- **`shipcast youtube import <file>`** connects YouTube once from a file with the OAuth client and a
  refresh token, through the same path as the callback, printing no value
  ([decisions/youtube.md](decisions/youtube.md)).

## The Channels page

Reshaped on 2026-10-26 (`apps/web/src/routes/_app/channels/index.tsx`).

- **Tabs by kind of network**, kept in the address (`/channels?tab=social|blog|measurement`):
  Social networks, Blog & newsletter, Measurement. `groupOf`
  (`apps/web/src/server/network-groups.ts`, tested against the real catalog) derives the tab from what
  the catalog says: a network with no channel (Cloudflare, Search Console, Bing, the GitHub profile)
  is Measurement; dev.to, Hashnode and the newsletter are Blog & newsletter; every other channel is
  Social, Facebook included. Without a tab in the address the page opens on the first tab with an
  account, and an account just connected opens its own tab.
- **No AI providers here** (since 2026-11-02). The Anthropic API and an OpenAI-compatible server are
  configured in Settings → AI, whose Providers list links to each one's connect page
  (`/channels/anthropic`, `/channels/openaiCompatible`); that page goes back to the AI settings, and
  connecting lands there. Connect a network no longer offers them, and an old `/channels?tab=ai`
  link, or the bell's "needs reconnecting" line for an AI account, opens Settings → AI.
- **A card per account, in the launch card's skin**: a glyph tile with a state dot (green for a passed
  check, red for a failed one, a dotted ring while unchecked), the network's name and a state pill,
  the account's avatar, name and handle with its brand, the key number (followers; a Discord server's
  members, when its account has an invite; a Facebook Page's followers with its likes beside them)
  with following and posts and the last sync under it, and the last problem explained. A network with
  no account yet is a quieter dashed card with **Connect an account**; an OAuth network whose app is
  not set yet says which setting it needs, by its label in Settings.
- **Every action is kept**: Sync now is a button on the card; the rest are in its Menu: Check the
  credential, Publish with this one, Rename, Connect another account and Disconnect, which asks first.
- **Sync all** (since 2026-11-02), beside Connect a network in the header, phone and desktop: Sync now
  for every working account of the tab on screen, three at a time, through the same `syncAccountNow`
  server function as the cards (a loop in the page, so the REST API's `syncAccount` per account is
  still its parity). An account that needs reconnecting is named, not synced. The button is disabled
  while it runs; one toast follows it ("Synced 3 of 8") and becomes the outcome, "Synced 7 of 8"
  with each failure named (`syncAllSummary` in `components/channels/view.ts`, tested).
- **Live**: with `realtime-ui` the page reloads on `account` events ([web-app.md](web-app.md#live-pages)).

## Pictures, numbers and freshness

Built on 2026-10-25 ([decisions/account-snapshots.md](decisions/account-snapshots.md)).

- **Avatars.** A working `check()` also returns the profile's picture and name where the same answer
  has them: Bluesky, Mastodon, Instagram, a Facebook Page, dev.to, Hashnode, Reddit, the GitHub
  profile and a Discord webhook's own picture. A check that finds none, or fails, leaves the last one.
  Only plain `https` addresses are kept, never one that carries a credential, so a Telegram channel
  has none. Pictures are plain `<img>` elements, lazy, with `referrerpolicy="no-referrer"`.
- **Snapshots.** Each connector whose API counts them has `profileStats()`, returning followers,
  following and posts and an `extra` map. The daily `snapshots` job (04:00 UTC) runs
  `takeSnapshots`: every account of a known brand is checked again and, where its network counts,
  gets the day's row in `account_snapshots`. One account failing never stops the others.
  Instagram's `extra` holds the account's insights of the last 24 hours (`views1d`, `reach1d`,
  `accountsEngaged1d`, `interactions1d`, `linkTaps1d`, and from 100 followers `follows1d` and
  `unfollows1d`); Threads' the profile's views of the day before (`profileViews1d`); a Facebook
  Page's its `likes` (`fan_count`) and, from its insights of the last day, `follows1d`
  (`page_follows`) and `engagements1d` (`page_post_engagements`). An insight the network refuses is
  named in the sync's line and never fails the counts.
  `shipcast sync [<account id>]` runs the same job from the terminal. The newsletter counts the
  subscribers of brand.yml's lists only, and Discord the members of the server its invite opens.
  dev.to's followers are `/users/me`'s `followers_count` since 2026-10-29 (its articles are still
  counted by paging their list; an instance without the field still pages its followers).
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
  links, guarded by `swapRecord`), a Telegram channel (title and description), a Discord webhook
  (its name) and, since 2026-10-29, a YouTube channel: its description as the bio, and its keywords,
  country and trailer as the links `Keywords: …`, `Country: ES`, `Trailer: <video>`, through
  `brandingSettings` with the `youtube.force-ssl` scope it already had (its name, picture and banner
  stay YouTube Studio's; [decisions/youtube.md](decisions/youtube.md#the-channels-profile)). dev.to,
  Hashnode, Reddit, the GitHub profile, Instagram (name, bio, website, picture), Threads (name,
  bio, picture) and a Facebook Page (its About text and picture) are read but not edited; the links
  Instagram's and Threads' APIs leave out may be pasted beside the read (`profile.paste`). LinkedIn
  reads the name and photo with its token and the owner pastes the About section, then copies the
  proposals.
- **The picture** is set only to brand.yml's `avatar`, never to a proposal: **Use brand.yml's
  picture**, beside a review, asks first and then uploads it as a Telegram channel's photo
  (`setChatPhoto`, the same "Change channel info" right) or a Discord webhook's picture (Modify
  Webhook with Token, the URL already held). Added on 2026-10-29.

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
the networks' OAuth app secrets (the Meta app's among them, `app:meta-app-secret`).

## OAuth flows

`packages/connectors/src/oauth.ts` has most networks' flows as plain functions, and
`packages/connectors/src/meta/` Meta's (Instagram Login, Unified Login, Facebook Login for Business).
Each adapter's OAuth spec says its URLs, scopes and app, and the routes under `/auth/<network>` run
them. A flow's `state` is a one-time value for ten minutes in the process's one-time store: memory, or
Redis with `redis-state`, so a callback reaching another replica still finds it.

- **The app a spec signs in with** is named by its id: a network's own (`instagram`, `threads`,
  `reddit`…) or one several networks share (`meta`). Each app's id and secret are derived once as
  settings, `<app><App|Client>Id` and `…Secret` (`metaAppId`, `META_APP_ID`; `metaAppSecret` in the
  secret store). A spec may also need a configuration id (`instagramConfigId`, `facebookConfigId`),
  a public setting: Meta says it identifies a configuration and gives no access. A sign-in whose
  settings are missing says which, by its label in Settings.
- **Variants.** A network that signs in more than one way declares variants and the setting that
  picks one (`oauthSpecOf` in `packages/runtime/src/oauth-specs.ts`; an unset or unknown value is the
  fallback). The flow keeps its variant with its state, so the callback finishes the sign-in it
  started even if Settings changed in between.
- **Several accounts per sign-in.** A spec's exchange returns a list: Meta's consent may share
  several Pages or Instagram accounts at once, and each becomes its own account, checked and kept
  through the one path every connection takes (`connectAll`, `apps/web/src/server/oauth-flows.ts`).
  The label the owner typed names one account, never several. The browser lands on the first one
  connected; what the sign-in itself left out (a Page Meta gave no token for) and any account that
  was refused are said beside it, and one that fails never undoes the others.
- **Mastodon** has no central developer portal: Shipcast registers itself on the instance the owner
  names (`POST /api/v1/apps`, scopes `read:accounts read:statuses read:notifications write:statuses
  write:media write:accounts`) the first time, keeps that client in the secret store with its scopes,
  and sends the owner to authorise. A client registered with other scopes is registered again on the
  next connection. The token does not expire. `read:notifications`, which the hourly comment feed
  needs, joined on 2026-10-29: a token from before keeps publishing and reading, and its comments
  come with the daily sweep until it is connected again.
- **Instagram** has three variants, picked by the `instagramLogin` setting (`instagram` when unset)
  ([decisions/meta-logins.md](decisions/meta-logins.md)); each account keeps the `login` it came
  from, and an account without one is an Instagram Login account, as every account from before is:
  - **Instagram Login** (`instagram`, apps created before Meta closed it to new ones) needs the
    Instagram app id and secret of the owner's Meta app, and the callback listed exactly in its
    business login settings. The code becomes a short-lived token, swapped at once for a 60-day one,
    refreshed every 30 days by the `instagram-tokens` job. Its account is read on
    `graph.instagram.com`.
  - **Unified Login** (`unified`) needs the Meta app id and secret and `instagramConfigId`: a
    configuration under Instagram → API setup with Unified login, whose token never expires. Meta's
    dialog asks by configuration, never by scope; the code becomes a business integration system
    user token, which reaches every Instagram account assigned to it
    (`/me/assigned_instagram_accounts`); each account keeps it with its id and business id. Never
    refreshed.
  - **Facebook Login for Business** (`facebook`), for an Instagram account linked to a Page, needs the
    Meta app and `instagramConfigId`: a configuration with a User access token and `instagram_basic`,
    `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`,
    `pages_show_list`, `pages_read_engagement` and `business_management` (plus `ads_read` or
    `ads_management` when the owner's role on the Page comes through a business portfolio). The user
    token is swapped for a long-lived one, and every shared Page with an Instagram account linked
    gives an account holding that Page's token, which does not expire.

  Unified and Facebook Login accounts are read on `graph.facebook.com`, by their id. Each setup is
  one per Meta app, which is why the choice is a setting.
- **Facebook** signs in with the Meta app and `facebookConfigId`: a Facebook Login for Business
  configuration with a User access token and `pages_show_list`, `pages_manage_posts`,
  `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `read_insights` and
  `business_management`, in an app with the "Manage everything on your Page" use case, its callback
  `/auth/facebook/callback`. The user token is swapped for a long-lived one and every Page shared
  becomes an account with its own Page token (no refresh). A Page Meta lists without a token (the
  owner's role on it allows no task) is left out and named; when none is usable, the sign-in fails
  and says why.
- **Threads** and **LinkedIn** use the owner's own app, its id and secret in Settings.
- **Reddit** needs the owner's Reddit app, its client id and secret in Settings and its redirect uri
  set to `/auth/reddit/callback`. It asks for `identity submit read history edit` with
  `duration=permanent` ([publishing.md](publishing.md#reddit)); a token from before 2026-10-29 lacks
  `history` and `edit`, so finding a lost post and deleting one ask to connect again.
- **YouTube** needs the owner's Google OAuth client in Settings; scopes `youtube.upload`,
  `youtube.readonly`, `youtube.force-ssl` and, since 2026-10-29, `yt-analytics.readonly` (with the
  YouTube Analytics API on in the project). An account connected before that keeps publishing and
  reading its counters; it is **connected again once** to read its analytics, which say so in the
  metrics run until then. With the consent screen in *Testing*, a refresh token lasts 7 days, and an
  expired one asks to connect YouTube again; the connection's instructions say to publish it
  ([decisions/youtube.md](decisions/youtube.md)).
- **The owner's GitHub user token** is refreshed under a lock shared by every process; inside it the
  token is read again and refreshed only if still due, so two replicas never spend the same refresh
  token and never delete the good one.
- Callbacks are behind the session: the `SameSite=Lax` cookie comes along on the redirect back.

## The Meta settings

Added on 2026-11-05 ([decisions/meta-logins.md](decisions/meta-logins.md)). In Settings, each with
its `.env` name for an install that sets it there:

| Setting | `.env` | What it is |
| --- | --- | --- |
| `metaAppId`, `metaAppSecret` | `META_APP_ID`, `META_APP_SECRET` | The owner's Meta app, for Facebook and Instagram's Unified and Facebook logins; the secret in the secret store |
| `instagramLogin` | `INSTAGRAM_LOGIN` | Instagram's setup in that app: `instagram` (Instagram Login, the default), `unified` or `facebook`; offered as a list, "Instagram Login (default)" when unset |
| `instagramConfigId` | `INSTAGRAM_CONFIG_ID` | The Unified or Facebook Login configuration Instagram signs in with |
| `facebookConfigId` | `FACEBOOK_CONFIG_ID` | The Facebook Login for Business configuration a Page signs in with |
| `instagramAppId`, `instagramAppSecret` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` | Instagram Login's app, unchanged |

Each has a help line in Settings saying when it is needed, so an install on Instagram Login needs
none of the Meta ones.

## Related

[[web-app.md]] · [[publishing.md]] · [[brands.md]] · [[engine.md]] · [[server.md]] · [[decisions/architecture.md]] · [[decisions/youtube.md]] · [[decisions/redis.md]] · [[plans/goal-finish.md]] · [[status.md]] · [[decisions/account-snapshots.md]] · [[decisions/account-analysis.md]] · [[decisions/github-app.md]] · [[decisions/component-layer.md]] · [[decisions/automatic-channels-only.md]] · [[decisions/dated-metrics.md]] · [[decisions/meta-logins.md]] · [[plans/meta-logins.md]]