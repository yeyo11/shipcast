---
created_at: 2026-10-25T06:56:09.686214154Z
updated_at: 2026-10-25T15:46:08.417948158Z
tags:
    - accounts
    - channels
    - connectors
    - keychain
    - oauth
    - brands
    - snapshots
    - avatars
---
# Accounts and channels

Built on 2026-10-25 in `@shipcast/runtime` (shared by the CLI and the [web app](web-app.md)) and the
app's Channels page. Before it, every credential lived in `.env`; now accounts are connected per
brand, checked, and kept in the operating system's keychain.

## The catalog

`NETWORKS` in `packages/runtime/src/catalog.ts` lists every network Shipcast knows: its name, the
channel it publishes (if any), whether it reads numbers, how an account is connected (`oauth`, a
`form`, or `none` for drafts only), the fields a form asks (public ones go to the registry, secret
ones to the keychain), what Shipcast does with the account in words, and where the credential comes
from. A new network is a connector in `packages/connectors` plus one entry here and its builder in
`buildConnector`.

| Network | Connected with | Publishes | Reads |
| --- | --- | --- | --- |
| dev.to | API key | the English article, canonical to the blog | views, reactions, comments |
| Bluesky | handle and app password | a post with a link card | likes, reposts, replies |
| Mastodon | OAuth on the owner's instance | a status with an image | favourites, boosts, replies |
| Instagram | Instagram Login (OAuth) | carousel, story, comment | reach, interactions |
| Newsletter (Brevo) | API key | one campaign per language | sends, opens, clicks |
| Hashnode | personal access token, publication host | the English article, canonical to the blog | views, reactions, comments |
| Telegram | bot token, channel, owner's chat | a post with the launch image | — (the Bot API gives bots no counts) |
| Discord | webhook URL | a message with an embed | — (webhooks cannot read) |
| GitHub | fine-grained token | — | stars, forks, traffic |
| Blog analytics (Cloudflare) | API token, account id, site tag | — | visits by source |
| Google Search Console | service account JSON key | — | clicks, impressions |
| Hacker News, Product Hunt | nothing: drafts only | — | — |

## Accounts

The registry's `accounts` table (migration 3) holds, per account: network, brand, label, public
settings, whether it is the brand's **primary** account on that network, the last check's status,
the identity the network reported, the problem if it failed, and its profile picture
(`avatar_url`, migration `0004_account_snapshots`). Secrets are one keychain entry per account,
`account:<id>`, a JSON object.

- **Several accounts per network, one primary per brand.** A launch posts once per channel, so it
  uses the brand's primary account; the first connected becomes primary, and another can take over.
- **Brands never mix.** A launch only builds connectors from its own brand's accounts. `.env` is a
  fallback only for the brand it speaks for (`SHIPCAST_ENV_BRAND`, `personal` by default); another
  brand gets nothing from it.
- **Checked before kept.** Connecting runs the connector's `check()`, a cheap read that proves the
  credential and its permissions; a failing credential is not saved, and the problem is said in words
  ("the token belongs to another account", "rejected: wrong, revoked or expired", "lacks a
  permission"), not as a status code. Connecting the same account again replaces its credential.
- **Import from .env.** One button checks every credential `.env` holds and moves it into the
  keychain as a connected account; the engine's own GitHub token stays in `.env`. Run on
  2026-10-25: six networks moved; Mastodon's token in `.env` turned out to be invalid and needs
  connecting again through OAuth.

## Pictures, numbers and freshness

Built on 2026-10-25 ([decisions/account-snapshots.md](decisions/account-snapshots.md)).

- **Avatars.** A working `check()` also returns the profile's picture (`avatarUrl`) and name
  (`displayName`) where the same answer has them: Bluesky (the public profile, read after the
  sign-in), Mastodon, Instagram, dev.to, Hashnode, a Discord webhook's own picture, GitHub. Every
  check stores the picture; a check that finds none, or fails, leaves the last one. Only plain
  `https` addresses are kept, never one that carries a credential, so a Telegram channel has none
  (its photo is only downloadable at an address with the bot token in it). The signed-in user's
  GitHub name and picture ride in the signed session cookie, read once at sign-in; a session from a
  console link shows GitHub's public picture for the login. Pictures are plain `<img>` elements,
  lazy, of a fixed size and with `referrerpolicy="no-referrer"`, in the header and the Channels pages.
- **Snapshots.** Each connector whose API counts them has `profileStats()`, returning followers,
  following and posts (each left out where the network does not give it) and an `extra` map; a
  `Built` exposes it. The daily `snapshots` job (04:00 UTC) runs `takeSnapshots`: every account of a
  known brand is checked again and, where its network counts, gets the day's row in
  `account_snapshots`. One account failing never stops the others. `shipcast sync [<account id>]`
  runs the same job from the terminal.
- **Freshness.** Each account on the Channels page shows its latest numbers and when it was last
  synced, its last snapshot or its last check, whichever is newer (`lastSynced`), with a warning once
  that is more than 36 hours old (`isStale`).
- **Sync now.** A button per account sends a `snapshots` job for that account alone (`syncNow`, keyed
  `account:<id>`, so a second click while it waits is the same job), which checks it and records
  today's numbers; the page waits up to 20 seconds for it and says what it found.
- **Not built yet:** updates pushed by the networks (Instagram webhooks, Mastodon's streaming API).

## The keychain

`KeychainStore` (`packages/runtime/src/secrets.ts`) uses the desktop keyring through its own
command-line tools, so there is no native module: `secret-tool` (libsecret: GNOME Keyring, KWallet)
on Linux, with the value on stdin, and `security` on macOS. On Linux it needs `libsecret-tools` and
an unlocked session keyring, which is why the app runs in the owner's desktop session. Besides the
accounts it keeps the app's session key, the TLS and ACME keys, and each Mastodon instance's client.

## OAuth flows

`packages/connectors/src/oauth.ts` has the networks' flows as plain functions; the app holds the
state (ten minutes, in memory) and the client credentials.

- **Mastodon** has no central developer portal: Shipcast registers itself on the instance the owner
  names (`POST /api/v1/apps`, scopes `read:accounts read:statuses write:statuses write:media`) the
  first time, keeps that client in the keychain, and sends the owner to authorise. The token does not
  expire.
- **Instagram Login** needs the Instagram app id and secret of the owner's Meta app in `.env`
  (`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`) and the callback listed exactly in its business login
  settings. The code becomes a short-lived token, swapped at once for a 60-day one, refreshed every
  30 days into the keychain.
- Callbacks are behind the session: the `SameSite=Lax` cookie comes along on the redirect back.

## Related

[[web-app.md]] · [[publishing.md]] · [[brands.md]] · [[engine.md]] · [[plans/goal-finish.md]] · [[status.md]] · [[decisions/account-snapshots.md]]
