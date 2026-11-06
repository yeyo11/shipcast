---
created_at: 2026-11-06T07:13:18.862244578Z
updated_at: 2026-11-06T07:13:18.862244578Z
tags:
    - decision
    - oauth
    - instagram
    - facebook
    - meta
    - accounts
---
# Every Meta login: Instagram's three setups and Facebook Pages

Decided on 2026-11-05 with the owner and built the same day and the next, on `main`. The design is
[plans/meta-logins.md](../plans/meta-logins.md), its implementation plan
[plans/meta-logins-implementation.md](../plans/meta-logins-implementation.md), and the brief of the
autonomous run that built it [plans/goal-meta-logins.md](../plans/goal-meta-logins.md).

## Context

A user who created a new Meta app could not connect Instagram. The App Dashboard of a new app offers
only "API setup with Facebook login" and "API setup with Unified login". Meta's migration guide says
plainly that newly created apps cannot set up the Instagram API with Instagram Login. Existing
integrations keep working with no end date announced, but new features ship only on Unified Login.
Shipcast spoke Instagram Login alone (`instagram.com/oauth/authorize`, `graph.instagram.com`, the
`instagram_business_*` permissions), so nobody with a new Meta app could connect Instagram.

The owner asked, the same day, for Shipcast to support every login Meta offers for the accounts it
can publish on.

## The owner's five decisions

1. **A Facebook account is a way to log in, not a target.** Meta has no API that publishes to a
   personal profile (only live video), so Shipcast never offers one.
2. **Facebook Pages become a full channel** (`facebook`): publish, edit, delete, comments, metrics and
   the profile, like Instagram and Threads.
3. **Instagram offers all three logins**: Instagram Login, Unified Login, and Facebook Login for
   Business for an Instagram account linked to a Page. Settings says which setup the owner's Meta app
   has, and Connect uses it. Accounts connected before keep working untouched.
4. **Each install brings its own Meta app**, as before. Shipcast does not become a Tech Provider:
   Standard Access in Development or Live mode is enough for the owner's own accounts.
5. **Threads is unchanged.** Meta offers it no other login.

## Rejected approaches

- **One network per login** (`instagram`, `instagram-unified`, `instagram-facebook`). A launch posts
  once per channel with the brand's primary account per network, so three Instagram networks would
  mean three Instagram channels in `launch.yml` and three primaries.
- **One "Meta connector"** for Instagram, Pages and Threads. Their APIs differ (Threads is not even
  on `graph.facebook.com`), and the coupling would cost more than the sharing saves.
- **The business integration system user (BISU) token management API now.** A Unified Login
  configuration whose token never expires needs no refresh. It waits until someone needs an expiring
  configuration.
- **The long-lived user token for Instagram through Facebook Login.** Meta's per-endpoint references
  name a user token for that setup, but its own comparison table lists "Facebook User or Page access
  token", and the Page token of a long-lived user token does not expire, where the user token lasts
  60 days with nothing to refresh it. The Page token was kept; if Meta refuses it, the owner's test
  shows it and the fallback is the long-lived user token with a 30-day refresher.
- **A migration dropping the accounts' unique label.** Two Pages with the same name would collide on
  `(network, brand, label)`; the second one is labelled with its id instead (below), which needs no
  migration.

## What was built

### Settings

- **The Meta app**, shared: `metaAppId` (a setting, `META_APP_ID`) and `metaAppSecret` (the secret
  store, `META_APP_SECRET`). The Facebook channel and Instagram's Unified and Facebook logins use it.
- **Kept as they were**: `instagramAppId` and `instagramAppSecret` (Instagram Login's app), and
  Threads' own app. Their setting names, `.env` names and store keys are byte for byte the same.
- **New public settings**: `instagramLogin` (`instagram`, `unified` or `facebook`; unset means
  `instagram`, so an install that worked keeps working; `INSTAGRAM_LOGIN`), `instagramConfigId`
  (`INSTAGRAM_CONFIG_ID`) and `facebookConfigId` (`FACEBOOK_CONFIG_ID`). A configuration id is not a
  secret: Meta says it identifies a configuration and gives no access.
- **The Settings page** offers `instagramLogin` as a list with readable options and the placeholder
  "Instagram Login (default)", and each new setting has a help line saying when it is needed, so an
  install on Instagram Login does not read an unset setting as a fault.

### The adapter contract

- An OAuth spec names the app it uses (`app.id`: its own network's, or `meta`) and, when it needs
  one, the configuration id setting (`config`). The app settings are derived from every spec once per
  app id, so two networks share one app (`oauthAppSettings` in `packages/runtime/src/settings.ts`).
- `NetworkSpec.oauth` is an `OAuthSpec` or `OAuthVariants` (`{ setting, fallback, variants }`):
  `oauthSpecOf` (`packages/runtime/src/oauth-specs.ts`) picks the variant the setting names, the
  fallback when it is unset or unknown.
- **The flow remembers its variant**: `/auth/<network>` stores it with the state, and the callback
  finishes that variant even if Settings changed in between.
- **`exchange` returns a list of accounts** (`ConnectedAccount[]`): Meta's consent may share several
  Pages or Instagram accounts at once, and Shipcast makes one account per shared asset, each through
  `connectAccount` (checked first; the first becomes primary when the brand has none). Every other
  network returns a list of one. The label the owner typed names one account, never several.
- **Each Instagram account remembers its login** (`login` in its public settings). An account
  without it is an Instagram Login account, which is what every account from before is.
- A sign-in that lacks a setting says which, by its label in Settings.

### The login flows (`packages/connectors/src/meta/`)

- **Instagram Login** (`instagram-login.ts`): the existing pair, moved unchanged.
- **Unified Login** (`unified-login.ts`): Meta's dialog with `config_id` and no `scope`, the code
  exchanged on `graph.facebook.com`, `/me?fields=client_business_id` for the business and
  `/me/assigned_instagram_accounts` for its Instagram accounts. One BISU token reaches every account
  shared with it. A configuration that issues a user token instead (no `client_business_id`) is told
  to issue a system-user (business integration) token.
- **Facebook Login for Business** (`facebook-login.ts`): the same dialog and exchange, the user token
  swapped for a long-lived one, then `/me/accounts` with each Page's token and its linked Instagram
  account, followed through `paging.next`.
- All new calls use Graph API `v27.0` (`META_GRAPH_VERSION`); Instagram Login's host stays on `v25.0`.

### The Instagram connector on two hosts

`Instagram` takes a `host`: `instagram` (`graph.instagram.com`, as before) or `facebook`
(`graph.facebook.com`, Unified and Facebook logins). On `graph.facebook.com` the account is read by its
id instead of `/me` (with a BISU token `/me` is the system user), and the check compares the id. The
own-username cache behind the comments is keyed by token **and** account, since one Unified token
serves several accounts. A comments refusal names the permission the account's login grants
(`instagram_manage_comments` on `graph.facebook.com`, `instagram_business_manage_comments` on
Instagram Login). Only Instagram Login accounts are refreshed every 30 days; a BISU token set never to
expire and a Page token are not.

### The Facebook channel

A definition (`packages/schema/src/channels/facebook.ts`), a connector (`FacebookPage`,
`packages/connectors/src/facebook.ts`) and an adapter (`packages/runtime/src/channels/facebook.ts`),
like every channel since the modules ([decisions/architecture.md](architecture.md)): one post in the
brand's Facebook language with the article as its link card, `off` by default, schedulable; edited in
place and deleted; its comments read and answered as the Page; its numbers hourly; the Page's
followers, likes, About text and picture read only. One account per Page shared, with the Page token,
which does not expire. Its sign-in is `/auth/facebook`. [publishing.md](../publishing.md) and
[accounts.md](../accounts.md) have the details.

## Deviations from the spec and the plan

- **Seven Facebook permissions, not six**: `pages_read_user_content` joined. Meta's comments guide
  asks for a third read permission to read a Page post's comments, naming it in a form its permission
  table does not list, while `pages_read_user_content` is listed there for reading what users post
  on a Page. The permissions are `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`,
  `pages_read_user_content`, `pages_manage_engagement`, `read_insights` and `business_management`.
- **`post_total_media_view_unique` instead of `post_impressions_unique`** for a post's `views`. The
  plan's fallback named `post_impressions_unique`, which Meta retired for every API version on
  2025-06-15 and names `post_total_media_view_unique` as its replacement. Asking for the retired one
  would have left the channel's main metric empty.
- **The comments ask for `parent{id}`.** Without it the flat `stream` of a post's comments cannot tell
  a reply from a comment, so the engine could not see the owner's own replies or thread them, and
  might answer twice. A reply's parent becomes its `inReplyTo`.
- **The link in the Facebook language.** `textPostStrategy` (`packages/engine/src/publishing/strategies.ts`)
  takes an optional `link` function; Facebook's passes the article in `brand.yml`'s
  `languages.facebook` (the lead language when the pack lacks it), as LinkedIn's card does, and the
  publisher receives the launch's tracking to tag it.
- **An account is matched by its network id.** Reconnecting found the existing account by its label,
  so two Pages with the same name collapsed into one (the second's token overwriting the first's) and a
  renamed Page came back as a duplicate. `connectAccount` (`packages/runtime/src/accounts.ts`) now
  matches on the id in the settings (`pageId` for Facebook, `userId` for Instagram and Threads),
  falling back to the label only for a row stored before it had that id. Since a label is unique per
  network and brand, a new account whose name is taken is labelled "Name (id)". A renamed account
  found by its id keeps its stored label, which may be one the owner typed.
- **Tokenless Pages are skipped and named.** A Page that `/me/accounts` lists without a token (the
  owner's role allows no task on it) failed the whole sign-in; now it is left out, and its name is said
  beside the accounts that did connect. When every Page is tokenless the sign-in fails and names them.
  For Instagram, only a tokenless Page with an Instagram account linked is named.
- **Single reads every hour.** The plan gave the channel the batched hourly cadence, but the adapter
  has no batched reader; the definition says what it does: `{ hours: 1, read: 'single' }`, one post a
  call.
- **A sign-in's accounts may carry a `problem`.** `ConnectedAccount.problem` holds what the exchange
  itself left out (the tokenless Pages). `connectAll` (`apps/web/src/server/oauth-flows.ts`) lands on
  the first connected account and carries those problems first, then any account `connectAccount`
  refused, in the same redirect; when nothing connected, the Channels page says them all.
- **Facebook Login for Instagram may need `ads_read` or `ads_management`.** Meta's IG Comment and
  insights references ask for one of them when the owner's role on the Page comes through a business
  portfolio; the connection's instructions say so.

## The spike that was not run

The plan opened with a spike against the owner's Meta app in Development mode. The run skipped it,
since it needs the owner, and built on the plan's stated fallbacks. Its three questions stay open, and
the owner's tests answer them:

1. Do the Instagram endpoints on `graph.facebook.com` take a **Page token** (Facebook Login)?
2. Which **Page insights metric names** does Meta accept today? A refused name is dropped at run time
   and the account's sync line names it.
3. Can a Unified Login configuration of one's own issue a **BISU token that never expires**?

## What stays unproven against Meta

The run made no call to Meta: every flow is proven with fake `fetch` and in a preview with fake
consent. Untried against the real API are:

- Unified Login end to end: the dialog, the BISU token, `client_business_id` and
  `assigned_instagram_accounts`;
- Facebook Login for Business, for Pages and for Instagram, including the Page token on Instagram's
  endpoints;
- a Page link post (its card, `permalink_url`), edit, delete, the comments with `parent{id}`, and the
  replies;
- the metric names, and whether `pages_read_user_content` and `ads_read` are what Meta asks for;
- whether Meta sends `error_message` on a refused callback, and omits `client_business_id` rather
  than sending it empty.

The owner's existing Instagram account (Instagram Login, no `login` setting) is pinned by tests to
keep its host, its calls and its refresh, and its daily check runs on the new version.

## Known limits

- **Action mode and the `.env` import cannot carry Unified or Facebook Login Instagram tokens.**
  `INSTAGRAM_USER_ID` and `INSTAGRAM_ACCESS_TOKEN` always build on `graph.instagram.com`. Someone whose
  Meta app has only Unified Login connects Instagram in the app; the Action cannot publish to it until
  a later change adds a login to those variables. Facebook, like Threads, LinkedIn and Reddit, has no
  `.env` variables and signs in through the app only.
- **An Instagram row stored with an app-scoped id** (from an old `.env` import) would not match its
  reconnection by id and gets a second card. It does not concern an account stored with its
  professional id.
- **Usage telemetry** counts `graph.facebook.com` calls as Instagram's: the host alone cannot tell the
  two apart.

## Related

[[plans/meta-logins.md]] · [[plans/meta-logins-implementation.md]] · [[plans/goal-meta-logins.md]] · [[accounts.md]] · [[publishing.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[decisions/architecture.md]] · [[decisions/new-networks.md]] · [[decisions/automatic-channels-only.md]] · [[decisions/action-mode.md]] · [[status.md]]