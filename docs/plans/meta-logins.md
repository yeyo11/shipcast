---
created_at: 2026-11-05T11:42:08.344657615Z
updated_at: 2026-11-05T11:42:08.344657615Z
tags:
    - plan
    - design
    - oauth
    - instagram
    - facebook
    - threads
    - connectors
    - accounts
---
# Every Meta login: Instagram's three setups and Facebook Pages

Designed on 2026-11-05 with the owner. Status: **design approved, not built**. The implementation plan
is [plans/meta-logins-implementation.md](meta-logins-implementation.md).

## Why

A user who created a new Meta app could not connect Instagram: the App Dashboard only offered
"API setup with Facebook login" and "API setup with Unified login". Meta's migration guide for
Instagram Login apps says so plainly: *"Newly created apps can't set up the Instagram API with
Instagram Login"*, while *"your existing integrations will continue to work. There is no end date
yet"*, and *"new features ship only on the Instagram API with Unified Login"*. Shipcast only speaks
Instagram Login (`instagram.com/oauth/authorize`, `graph.instagram.com`, `instagram_business_*`), so
nobody with a new app can connect Instagram today.

The owner asked, on the same day, for Shipcast to support every login Meta offers for the accounts
it can publish on.

## What Meta offers (checked against developers.facebook.com on 2026-11-05)

| Target | Login | Token | API host | Facebook Page | Notes |
| --- | --- | --- | --- | --- | --- |
| Instagram | **Instagram Login** (Business Login for Instagram) | Instagram user token, 60 days, refreshable | `graph.instagram.com` | not needed | existing apps only; `instagram_business_*` |
| Instagram | **Unified Login** (Instagram or Facebook credentials) | Business Integration System User token (BISU); its expiry is chosen in the configuration, "never" by default | `graph.facebook.com` | not needed | needs a `config_id`, an app owned by a business portfolio, `instagram_*` permissions; `/me` is the system user, the accounts come from `/me/assigned_instagram_accounts` |
| Instagram | **Facebook Login for Business** (Instagram linked to a Page) | user token (60 days) → Page token, which does not expire | `graph.facebook.com` | required | `instagram_*` plus Page permissions; the accounts come from `/me/accounts` |
| Facebook Page | **Facebook Login for Business** | user token → Page token, which does not expire | `graph.facebook.com` | it is the target | `pages_*`; Shipcast has no Facebook channel yet |
| Facebook profile | — | — | — | — | **no API publishes to a personal profile** (only live video, `publish_video`) |
| Threads | Threads' own authorisation window | Threads user token, 60 days, refreshable | `graph.threads.com` | not needed | the only login Threads has; Shipcast already supports it |

An app holds **one** Instagram setup ("You can only add one setup per app"). The current Graph API
version is **v27.0**.

## Decisions taken with the owner

1. **A Facebook account is a way to log in, not a target.** Meta has no API to publish to a personal
   profile, so Shipcast never offers it.
2. **Facebook Pages become a full channel** (`facebook`): publish, edit, delete, comments, metrics and
   the profile, like Instagram and Threads.
3. **Instagram offers all three logins.** Settings says which setup the owner's Meta app has, and
   Connect uses it. Accounts connected before keep working untouched.
4. **Each install brings its own Meta app**, as today. Shipcast does not become a Tech Provider:
   Standard Access in Development or Live mode is enough for the owner's own accounts.
5. **Threads is unchanged.** Meta offers it no other login.

## Approach

**Login variants inside each network.** `instagram` stays one network and one channel. Its adapter
declares three OAuth variants; a setting picks the variant; each account remembers which login it
came from, and that tells its connector which host and token to use.

Rejected:

- **One network per login** (`instagram`, `instagram-unified`, `instagram-facebook`): a launch posts
  once per channel with the brand's primary account per network, so three Instagram networks would
  mean three Instagram channels in `launch.yml` and three primaries.
- **One "Meta connector"** for Instagram, Pages and Threads: their APIs differ (Threads is not even on
  `graph.facebook.com`); the coupling would cost more than the sharing saves.
- **Implementing the BISU token management API now**: a configuration whose tokens never expire needs
  no refresh. It waits until someone needs an expiring configuration.

## Design

### 1. The Meta app settings

- **The Meta app**, shared: `metaAppId` (a setting) and `metaAppSecret` (the secret store). The
  Facebook channel and Instagram's Unified and Facebook logins use it.
- **Kept as they are**: `instagramAppId`/`instagramAppSecret` (Instagram Login's "Instagram app") and
  `threadsAppId`/`threadsAppSecret`.
- **New public settings**: `instagramLogin` = `instagram` | `unified` | `facebook` (default
  `instagram`, so an install that works keeps working), `instagramConfigId`, `facebookConfigId`.
  A `config_id` is not a secret: Meta says it identifies a configuration and gives no access.
- **The contract changes**: today each network's two app settings are derived from its `OAuthSpec`
  (`oauthAppSettings` in `packages/runtime/src/settings.ts`). A spec now names the app it uses
  (`app.id`: its own network's, or `meta`) and the extra public setting it asks for (the
  configuration id), so two networks can share one app.

### 2. The adapter contract

- `NetworkSpec.oauth` is an `OAuthSpec` or `{ setting, variants, fallback }`: `/auth/<network>` reads
  the setting and runs that variant; the callback runs the same one, remembered with the flow's
  state, even if the setting changed in between.
- **`exchange` returns a list of accounts.** In Facebook Login for Business the owner may share
  several Pages or Instagram accounts in Meta's dialog; Shipcast makes one account per shared asset,
  through `connectAccount` as today (checked first; the first becomes primary when the brand has
  none). The other networks return a list of one.
- **Each account remembers its login**: `login` in its public settings. An account without it is an
  Instagram Login account, which is what every existing account is.
- The preview's fake consent (`ctx.preview.oauth`) follows the same list shape.

### 3. The login flows (`packages/connectors/src/meta/`)

- **Instagram Login**: today's `instagramAuthorizeUrl` and `exchangeInstagramCode`, moved unchanged.
- **Unified Login**: `https://www.facebook.com/v27.0/dialog/oauth` with `client_id`, `config_id`,
  `redirect_uri`, `response_type=code`, `state` and no `scope`; the code exchanged at
  `GET https://graph.facebook.com/v27.0/oauth/access_token`; `/me?fields=client_business_id` and
  `/me/assigned_instagram_accounts` give the business and its Instagram accounts. The account keeps
  the BISU token, the Instagram account id and the client business id.
- **Facebook Login for Business** (Instagram through a Page, and the Facebook channel): the same
  dialog and exchange with a *user access token* configuration; the user token swapped for a 60-day
  one (`grant_type=fb_exchange_token`);
  `/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}` lists the
  Pages, each with its Page token and its linked Instagram account. The account keeps the Page
  token, which does not expire.
- An answer with no usable asset (no professional Instagram account, a Page without an Instagram
  account, no Page shared) is an error said in words; nothing is kept.

### 4. The Instagram connector over two hosts

- `Instagram` takes `{ host, accessToken, userId, version }`. With `graph.instagram.com` nothing
  changes.
- With `graph.facebook.com`, `check()`, `profile()`, `profileStats()` and the own-username read behind
  the comments read `/{userId}?fields=…` instead of `/me` (with a BISU token `/me` is the system
  user). Publishing, comments and insights already address `/{userId}` and `/{mediaId}`; insights
  Meta refuses by name are already dropped.
- **Refresh**: Instagram Login every 30 days, as today; Page tokens never; BISU tokens never when
  the configuration says "never", which the connection's instructions ask for. A BISU token that does
  expire is not refreshed: once it runs out, the daily check fails and the account asks to be
  connected again, as any account whose token stops working.

### 5. The Facebook channel (`facebook`)

- **Definition** `packages/schema/src/channels/facebook.ts`: a `facebook` piece in the content pack
  (one post in the brand's language, linking the article, whose card shows the article's image),
  `off` by default in `launch.yml`, schedulable, its posting windows and metric families.
- **Connector** `FacebookPage` (`packages/connectors/src/facebook.ts`): publish a link post
  (`/{page}/feed` with the text and the article's link, so the card carries the click); edit
  (`POST /{post}`) and delete (`DELETE /{post}`); read and answer comments (`/{post}/comments`); the
  post's and the Page's insights; the profile (name, about, picture, followers), read only.
- **Permissions**: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`,
  `pages_manage_engagement`, `read_insights`, `business_management`.
- **Parity**: publishing, editing, comments, metrics and accounts are already REST routes and MCP
  tools per channel; the `app-parity` and `mcp-parity` tests prove the new channel is reachable.

### 6. Errors

- Connect with a missing Meta app or configuration id says which setting is missing, as it does for
  an app id today.
- Meta's refusals in the callback (`error_reason`, `error_description`) are said as today.
- A token that stops working (the owner removed the app from the business, moved the Instagram
  account) fails the check; the account asks to be connected again, as any other.

### 7. Testing

- Each flow, each host of the Instagram connector and `FacebookPage` against fake `fetch`, in the
  style of `packages/connectors/test/connectors.test.ts` and `check-oauth.test.ts`.
- The adapter contract (variants, list exchange, shared app settings) in the runtime's tests.
- **A spike first, with the owner's app in Development mode**, to settle three facts the docs leave
  open: whether Instagram endpoints on `graph.facebook.com` take a Page token; the Page insights
  metric names today (Meta retired several in 2024 and 2025); and whether a BISU configuration of
  one's own can be set to never expire.

## Delivery order

Independent commits to `main`, each through the gates:

1. The spike (findings recorded in this plan).
2. The adapter contract and the Meta app settings.
3. Unified Login for Instagram: this alone lets a new app connect.
4. Facebook Login for Business for Instagram.
5. The Facebook channel.
6. The decision record `decisions/meta-logins.md` and the reference docs (`accounts.md`,
   `publishing.md`, `launch-yml.md`, `content-pack.md`).

## Sources

- [Instagram Platform overview](https://developers.facebook.com/documentation/instagram-platform/overview)
- [Migrate an Instagram Login app](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/migration-guide)
- [Unified Login: get started](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started), [authentication](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication), [permissions](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/permissions)
- [Facebook Login for Business](https://developers.facebook.com/documentation/facebook-login/facebook-login-for-business)
- [Long-lived access tokens](https://developers.facebook.com/documentation/facebook-login/guides/access-tokens/get-long-lived)
- [Pages API overview](https://developers.facebook.com/documentation/pages-api/overview), [get started](https://developers.facebook.com/documentation/pages-api/getting-started)
- [Threads: get access tokens](https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions)
- [Permissions reference](https://developers.facebook.com/docs/permissions)

## Related

[[accounts.md]] · [[publishing.md]] · [[decisions/automatic-channels-only.md]] · [[decisions/new-networks.md]] · [[decisions/architecture.md]] · [[plans/meta-logins-implementation.md]]
