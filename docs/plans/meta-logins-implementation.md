---
created_at: 2026-11-06T07:37:59.421139565Z
updated_at: 2026-11-06T07:37:59.421139565Z
tags:
    - plan
    - implementation
    - oauth
    - instagram
    - facebook
    - connectors
---
# Every Meta login: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instagram connects through Instagram Login, Unified Login or Facebook Login for Business,
whichever the owner's Meta app has, and Facebook Pages become a channel Shipcast publishes on.

**Architecture:** A network's OAuth spec may hold variants chosen by a setting; `exchange` returns a
list of accounts; each Instagram account keeps the `login` it came from, which picks its connector's
host. Meta's login flows live in `packages/connectors/src/meta/`; the Facebook channel is a
definition, a connector and an adapter like every other channel, published through
`textPostStrategy`.

**Tech Stack:** TypeScript strict (no `any`, `noUncheckedIndexedAccess`), Node 24, pnpm workspace,
`node:test` with `assert/strict`, Zod, TanStack Start for the web app.

**Spec:** [plans/meta-logins.md](meta-logins.md). Read it first: this plan argues from it.

**Status:** built on 2026-11-05 and 2026-11-06. What changed from this plan, and why, is in
[Outcome](#outcome); the tasks below are left as they were written.

## Global Constraints

- Graph API version for every new Meta call: `v27.0` (`META_GRAPH_VERSION`). The Instagram Login host
  keeps its current default `v25.0`.
- Unified and Facebook dialogs: `https://www.facebook.com/v27.0/dialog/oauth` with `client_id`,
  `config_id`, `redirect_uri`, `response_type=code`, `state`; **never `scope`**.
- Code exchange: `GET https://graph.facebook.com/v27.0/oauth/access_token` with `client_id`,
  `client_secret`, `redirect_uri`, `code`.
- `instagramLogin` values: `instagram` | `unified` | `facebook`; default `instagram`.
- An account's `login` setting absent means `instagram`.
- New settings: `metaAppId` (setting `meta-app-id`, env `META_APP_ID`), `metaAppSecret` (secret
  `app:meta-app-secret`, env `META_APP_SECRET`), `instagramLogin` (setting `instagram-login`, env
  `INSTAGRAM_LOGIN`), `instagramConfigId` (setting `instagram-config-id`, env
  `INSTAGRAM_CONFIG_ID`), `facebookConfigId` (setting `facebook-config-id`, env `FACEBOOK_CONFIG_ID`).
- Graph ids are read as strings, never through a JSON number (Instagram ids pass 2^53).
- Facebook channel id, pack key, icon and UTM source: `facebook`; mode `off` by default.
- Facebook permissions: `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`,
  `pages_manage_engagement`, `read_insights`, `business_management`.
- Instagram permissions for Unified and Facebook logins: `instagram_basic`,
  `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`; the Facebook
  login adds `pages_show_list`, `pages_read_engagement`, `business_management`.
- Checks run through Sluice: `verify` with the absolute worktree path (`gates: ["test"]` for the
  suite, the default for typecheck). Never run `pnpm test`/`tsc` in the shell.
- Work in a worktree from `origin/main`; commit with Conventional Commits and the attribution line;
  push to `origin main` after Tasks 4, 5, 8 and 9 (a push deploys to apps-1, so only green states).
- Documents only through pando's `kb_add_document` (a hook blocks direct writes to `docs/**/*.md`).

## Review Focus

1. **Accounts connected before this change** (settings `{ userId, refreshedAt }`, no `login`) keep
   publishing on `graph.instagram.com` and keep their 30-day refresh. Pinned in Task 4.
2. **The owner switches `instagramLogin`** while accounts from another login exist: each account
   keeps its own host and refresh, whatever the setting says now. Pinned in Task 4.
3. **The setting changes between `/auth/instagram` and its callback**: the callback finishes the
   variant that started. Pinned in Task 1.
4. **Instagram and Page ids past 2^53** (17 digits) survive the flows byte for byte. Pinned in Task 2.
5. **An owner with many Pages**: `/me/accounts` pages through `paging.next`, and Pages with no linked
   Instagram account are skipped, not failed. Pinned in Task 2 and Task 5.

---

### Task 0: Spike with the owner's Meta app

Settles the three facts the docs leave open. Needs the owner: a Meta app owned by their business
portfolio, in Development mode, with the Instagram use case on "API setup with Unified login" (one
configuration with "never" expiry if offered) and the "Manage everything on your Page" use case
with a Facebook Login for Business configuration of type *User access token*. No code is kept.

- [ ] **Step 1:** Ask the owner for a Page token and a Unified (BISU) token generated in the App
  Dashboard ("Generate token"), handed over through a file outside the repo, never pasted in chat
  logs or committed.
- [ ] **Step 2:** With the Page token, call
  `GET https://graph.facebook.com/v27.0/{ig-user-id}?fields=id,username,followers_count` and
  `GET .../{ig-user-id}/media?fields=id,comments_count&limit=1`. Record: works / error.
- [ ] **Step 3:** With the Page token, call
  `GET https://graph.facebook.com/v27.0/{page-post-id}/insights?metric=post_impressions,post_impressions_unique,post_clicks,post_reactions_by_type_total,post_media_view`
  and `GET .../{page-id}/insights?metric=page_follows,page_media_view,page_post_engagements&period=day`.
  Record which names Meta accepts and which it refuses by name.
- [ ] **Step 4:** With the BISU token, `GET https://graph.facebook.com/v27.0/debug_token?input_token=<token>&access_token=<app id>|<app secret>`;
  record `expires_at` (0 = never) and whether the dashboard offered "never".
- [ ] **Step 5:** Record the findings as a `## Spike findings (date)` section of
  [plans/meta-logins.md](meta-logins.md) through `kb_add_document` (no ids, no tokens). Then:
  - If Step 2 failed with the Page token, Task 5 keeps the **long-lived user token** instead (60
    days) and its refresher swaps it with `grant_type=fb_exchange_token` every 30 days; say so in
    the findings.
  - The accepted metric names of Step 3 become `FACEBOOK_POST_METRICS` and `FACEBOOK_PAGE_METRICS`
    in Task 7.
- [ ] **Step 6:** Commit `docs(plans): record the Meta logins spike`.

If the owner is not available, skip to Task 1 and leave Tasks 5 and 7's open points as written
below (Page token for Instagram; metric names `post_impressions_unique`, `post_clicks`,
`post_reactions_by_type_total` for posts and `page_follows`, `page_post_engagements` for the Page),
flagged in the commit message.

---

### Task 1: Variants, shared apps and a list of accounts in the adapter contract

**Files:**
- Modify: `packages/runtime/src/channels/adapter.ts` (`OAuthApp`, `OAuthSpec`, `NetworkSpec.oauth`)
- Create: `packages/runtime/src/oauth-specs.ts`
- Modify: `packages/runtime/src/settings.ts` (app settings by app id, the three Meta settings, `choices`)
- Modify: `packages/runtime/src/channels/{instagram,threads,linkedin,reddit,youtube}.ts` (`app.id`, list exchange)
- Modify: `packages/runtime/src/preview/world.ts` (`PreviewOAuth.exchange` returns a list)
- Modify: `packages/runtime/src/index.ts` (exports)
- Modify: `apps/web/src/server/channels.server.ts` (`startOAuth`, `finishOAuth`, `finishPreview`, `connectWith`)
- Modify: `apps/web/src/server/channels-view.server.ts:41-43` (`instagramOAuth`, `oauthReady`)
- Modify: `apps/web/src/components/SettingsForm.tsx` (a `<select>` for a setting with `choices`)
- Modify: `apps/web/src/server/settings.functions.ts` (send `choices` with each setting)
- Test: `packages/runtime/test/oauth-specs.test.ts` (new), `packages/runtime/test/channel-adapters.contract.test.ts`, `packages/runtime/test/settings.test.ts`

**Interfaces:**
- Produces (adapter.ts):
  ```ts
  export interface OAuthApp { clientId: string; clientSecret: string; configId?: string }
  export interface ConnectedAccount { label?: string; credentials: Credentials }
  export type ConfigSetting = 'instagramConfigId' | 'facebookConfigId';
  export interface OAuthSpec {
    /** `id` names the app's settings: the network's own (`instagram`) or a shared one (`meta`) */
    app: { id: string; term: 'app' | 'client'; name: string };
    /** The configuration id Facebook Login for Business needs, from this setting */
    config?: ConfigSetting;
    authorizeUrl(app: OAuthApp, redirectUri: string, state: string): string;
    exchange(app: OAuthApp, redirectUri: string, code: string, http?: typeof fetch): Promise<ConnectedAccount[]>;
    errorParams: readonly string[];
  }
  export interface OAuthVariants { setting: 'instagramLogin'; fallback: string; variants: Readonly<Record<string, OAuthSpec & { label: string }>> }
  // NetworkSpec.oauth?: OAuthSpec | OAuthVariants
  ```
- Produces (oauth-specs.ts):
  ```ts
  export function isVariants(oauth: OAuthSpec | OAuthVariants): oauth is OAuthVariants
  /** The variant the settings name (unknown or unset: `fallback`), or the one spec; undefined without oauth */
  export function oauthSpecOf(network: NetworkSpec, settings: SettingsValues, variant?: string): { spec: OAuthSpec; variant: string | undefined } | undefined
  /** Every spec a network may sign in with, for deriving the app settings */
  export function oauthSpecsOf(network: NetworkSpec): OAuthSpec[]
  ```
- Produces (settings.ts): `RuntimeSettings.oauthApp(spec: OAuthSpec): OAuthApp | undefined` (id and
  secret by `spec.app.id`, `configId` from `spec.config` when set; undefined when the id, the secret,
  or a required configuration id is missing); `RuntimeSettings.missingFor(spec: OAuthSpec): string | undefined`
  (the label of the first missing one); `oauthSettingName(appId, part)` keyed by app id;
  `Definition.choices?: readonly string[]`; `BaseValues` gains `instagramLogin`, `instagramConfigId`,
  `facebookConfigId`.
- Produces (preview/world.ts): `PreviewOAuth.exchange(...): Promise<ConnectedAccount[]>`.

- [ ] **Step 1: Write the failing tests** in `packages/runtime/test/oauth-specs.test.ts`:

```ts
test('a network with variants signs in with the one its setting names, else the fallback', () => {
  const net = fakeNetwork({ setting: 'instagramLogin', fallback: 'instagram', variants: { instagram: specA, unified: specB } });
  assert.equal(oauthSpecOf(net, { instagramLogin: 'unified' } as SettingsValues)?.spec, specB);
  assert.equal(oauthSpecOf(net, {} as SettingsValues)?.spec, specA);
  assert.equal(oauthSpecOf(net, { instagramLogin: 'nonsense' } as SettingsValues)?.spec, specA);
});
test('a callback finishes the variant its flow started, whatever the setting says now', () => {
  const net = fakeNetwork({ setting: 'instagramLogin', fallback: 'instagram', variants: { instagram: specA, unified: specB } });
  assert.equal(oauthSpecOf(net, { instagramLogin: 'instagram' } as SettingsValues, 'unified')?.spec, specB);
});
test('two specs sharing the meta app derive its settings once', () => {
  assert.deepEqual(Object.keys(SETTINGS).filter((n) => n.startsWith('meta')).sort(), ['metaAppId', 'metaAppSecret']);
});
```

  In `channel-adapters.contract.test.ts` keep the `instagramAppId`/`instagramAppSecret` assertions
  (lines 110-111) unchanged and add:

```ts
assert.deepEqual(app('metaAppId'), ['META_APP_ID', 'setting', 'meta-app-id', 'The Meta app id']);
assert.deepEqual(app('metaAppSecret'), ['META_APP_SECRET', 'secret', 'app:meta-app-secret', 'The Meta app secret']);
```

  In `settings.test.ts`: `instagramLogin` refuses `'tiktok'` with a message naming the three
  choices, and `settings.oauthApp(spec)` with `config: 'instagramConfigId'` is undefined until
  `instagramConfigId` is written, then carries it as `configId`.

- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL, `oauthSpecOf` and
  `ConnectedAccount` not exported.
- [ ] **Step 3: Implement.** In `adapter.ts` the interfaces above. `oauth-specs.ts` as specified.
  In `settings.ts`, `oauthAppSettings()` iterates `oauthSpecsOf(spec)` for every network and
  deduplicates by `app.id`; the three Meta settings are plain `Definition`s, `instagramLogin` with
  `choices: ['instagram', 'unified', 'facebook']` and a `check` that refuses anything else. Every
  existing adapter sets `app.id` to its network id and its `exchange` returns `[ { label?, credentials } ]`.
  `PreviewOAuth.exchange` returns a one-element list.
- [ ] **Step 4: The web routes.** `startOAuth` resolves `oauthSpecOf(networkSpec(id), ctx.settings.current())`,
  answers `back(networkId, 'Set ' + ctx.settings.missingFor(spec) + ' in Settings (/settings) first.')`
  when `oauthApp(spec)` is undefined, and stores the variant in the flow (`remember({ ...flow, variant })`).
  `finishOAuth` resolves the spec with `flow.variant`. `connectWith` becomes
  `connectAll(networkId, flow, accounts: ConnectedAccount[])`: an empty list answers
  `back(networkId, '<name> shared no account with Shipcast.')`; each account goes through
  `connectAccount` in order (`flow.label` only when there is one account); the browser lands on the
  first connected account (`connected(account)`); when none connected, `back` with the problems
  joined by `'; '`. `channels-view.server.ts` computes `oauthReady` with `oauthSpecOf` + `oauthApp`.
  `getSettings` sends `choices`; `SettingsForm` renders a `<select>` for a setting that has them.
- [ ] **Step 5:** Sluice `verify` (typecheck, then `gates: ["test"]`). Expected: PASS, including
  `app-parity` and `mcp-parity` (no new server function: settings already have their route and tool).
- [ ] **Step 6: Commit** `feat(accounts): sign-in variants, shared OAuth apps and several accounts per sign-in`.

---

### Task 2: Meta's login flows

**Files:**
- Create: `packages/connectors/src/meta/graph.ts`, `meta/facebook-login.ts`, `meta/unified-login.ts`, `meta/instagram-login.ts`, `meta/index.ts`
- Modify: `packages/connectors/src/oauth.ts` (move the Instagram Login pair out; re-export it from `meta/`)
- Modify: `packages/connectors/src/index.ts` (export `./meta/index.ts`)
- Test: `packages/connectors/test/meta-logins.test.ts` (new; `fakeFetch` and `sequence` from `test/fake.ts`)

**Interfaces:**
- Produces:
  ```ts
  export const META_GRAPH_VERSION = 'v27.0';
  export const UNIFIED_INSTAGRAM_PERMISSIONS: readonly string[]; // instagram_basic, instagram_content_publish, instagram_manage_comments, instagram_manage_insights
  export function facebookDialogUrl(app: { appId: string; configId: string }, redirectUri: string, state: string): string;
  export function exchangeFacebookCode(app: { appId: string; appSecret: string }, redirectUri: string, code: string, http?: typeof fetch): Promise<{ accessToken: string; expiresIn: number | undefined }>;
  export function longLivedUserToken(app: { appId: string; appSecret: string }, accessToken: string, http?: typeof fetch): Promise<{ accessToken: string; expiresIn: number | undefined }>;
  export interface FacebookPageAsset { pageId: string; name: string; pageToken: string; instagram: { id: string; username: string | undefined } | undefined }
  export function listPages(userToken: string, http?: typeof fetch): Promise<FacebookPageAsset[]>;
  export interface UnifiedAccess { accessToken: string; businessId: string; instagram: Array<{ id: string; username: string | undefined }> }
  export function unifiedAccess(app: { appId: string; appSecret: string }, redirectUri: string, code: string, http?: typeof fetch): Promise<UnifiedAccess>;
  // instagram-login.ts: instagramAuthorizeUrl, exchangeInstagramCode, INSTAGRAM_SCOPES, unchanged
  ```

- [ ] **Step 1: Write the failing tests:**

```ts
test('the dialog asks by configuration, never by scope', () => {
  const url = new URL(facebookDialogUrl({ appId: '1', configId: '42' }, 'https://x/auth/instagram/callback', 's'));
  assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v27.0/dialog/oauth');
  assert.equal(url.searchParams.get('config_id'), '42');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.has('scope'), false);
});
test('the code is exchanged by GET on graph.facebook.com', async () => { /* asserts method GET, path /v27.0/oauth/access_token, the four params */ });
test('unified access reads the business and its Instagram accounts, ids as text', async () => {
  // /me answers {"client_business_id":"123","id":"9"}; /me/assigned_instagram_accounts answers
  // {"data":[{"id":"17841416971174401","username":"me"}]} as a raw body
  assert.deepEqual(access.instagram, [{ id: '17841416971174401', username: 'me' }]);
  assert.equal(access.businessId, '123');
});
test('listPages follows paging.next and keeps each Page token and its Instagram account', async () => {
  // two pages of /me/accounts; the second Page has no instagram_business_account
  assert.deepEqual(pages.map((p) => [p.pageId, p.pageToken, p.instagram?.id]), [['17841400000000001', 'pt1', '17841416971174402'], ['2', 'pt2', undefined]]);
});
test('a refused exchange says Meta\'s own message', async () => { /* 400 {"error":{"message":"Invalid verification code"}} → ConnectorError matching /Invalid verification code/ */ });
```

- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL, module `meta/` missing.
- [ ] **Step 3: Implement** with `json`/`ConnectorError` from `http.ts`, network name `'Meta'`.
  `exchangeFacebookCode` does not use a scope. Ids are parsed by `JSON.parse` only where Meta sends
  them as strings (Graph `id` fields are strings); assert in code that `id` is a string and throw a
  `ConnectorError` otherwise. `listPages` asks
  `fields=id,name,access_token,instagram_business_account{id,username}` and follows
  `paging.next` until absent.
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS, `check-oauth.test.ts` still green
  through the re-export.
- [ ] **Step 5: Commit** `feat(connectors): Meta's Facebook Login for Business and Unified Login flows`.

---

### Task 3: The Instagram connector on graph.facebook.com

**Files:**
- Modify: `packages/connectors/src/instagram.ts` (`InstagramOptions`, constructor, `#ownName`, `check`, `profileStats`, `profile`, `refreshToken`)
- Test: `packages/connectors/test/instagram-hosts.test.ts` (new)

**Interfaces:**
- Produces: `InstagramOptions.host?: 'instagram' | 'facebook'` (default `'instagram'`). With
  `'facebook'` the base is `https://graph.facebook.com/${version ?? META_GRAPH_VERSION}` and every
  read of `/me` reads `/${userId}`; `refreshToken()` throws `ConnectorError('Instagram', 'this token is not refreshed: connect Instagram again when it stops working', 400, false)`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('on graph.facebook.com the account is read by its id, not /me', async () => {
  const calls: Call[] = [];
  const ig = new Instagram({ host: 'facebook', userId: '17841416971174401', accessToken: 't', fetch: fakeFetch([['graph.facebook.com/v27.0/17841416971174401', () => Response.json({ id: '17841416971174401', username: 'me', name: 'Me' })]], calls) });
  assert.deepEqual(await ig.check(), { ok: true, account: '@me', displayName: 'Me' });
  assert.equal(calls.some((c) => c.url.includes('/me?') || c.url.includes('/me/')), false);
});
test('a token for another account is refused on graph.facebook.com too', async () => { /* id differs → ok:false, problem mentions @other */ });
test('profile and profileStats read /{id} on graph.facebook.com', async () => { /* fields name,biography,website,profile_picture_url and followers_count,follows_count,media_count */ });
test('graph.instagram.com is unchanged: /me and v25.0', async () => { /* default host, check reads /v25.0/me */ });
```

- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL, `host` not in `InstagramOptions`.
- [ ] **Step 3: Implement** a private `#self(): string` returning `'/me'` or `` `/${this.#user}` `` and
  use it in `#ownName`, `check`, `profileStats`, `profile`. In `check`, on the Facebook host compare
  `me.id` with the user id (no `user_id` field there).
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS, every existing Instagram test green.
- [ ] **Step 5: Commit** `feat(connectors): Instagram on graph.facebook.com for Unified and Facebook logins`.

---

### Task 4: Unified Login for Instagram

**Files:**
- Modify: `packages/runtime/src/channels/instagram.ts` (variants, `build`, `refresh.refresher`)
- Test: `packages/runtime/test/instagram-logins.test.ts` (new)

**Interfaces:**
- Consumes: `OAuthVariants` (Task 1), `facebookDialogUrl`, `unifiedAccess` (Task 2), `Instagram` `host` (Task 3).
- Produces: `instagramAdapter.connect.network.oauth` = `{ setting: 'instagramLogin', fallback: 'instagram', variants: { instagram, unified } }`
  (`facebook` joins in Task 5). Unified accounts: settings `{ login: 'unified', userId, businessId }`,
  secrets `{ accessToken }`, label `@<username>` (or the id when Meta gives no username).
  `export function instagramLoginOf(settings: Record<string, string>): 'instagram' | 'unified' | 'facebook'`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('an account connected before keeps graph.instagram.com and its 30-day refresh', () => {
  const settings = { userId: '17841400000000077', refreshedAt: '2026-10-24T00:00:00Z' };
  assert.equal(instagramLoginOf(settings), 'instagram');
  assert.ok(network.refresh!.refresher(settings, 't'));
  // build() with these credentials and a recording fetch: check() calls graph.instagram.com/v25.0/me
});
test('a unified account reads graph.facebook.com and is never refreshed', () => {
  const settings = { login: 'unified', userId: '17841416971174401', businessId: '123' };
  assert.equal(network.refresh!.refresher(settings, 't'), undefined);
  // build(): check() calls graph.facebook.com/v27.0/17841416971174401
});
test('switching the setting leaves existing accounts on their own login', () => { /* settings.instagramLogin = 'unified'; an account without login still builds on graph.instagram.com and still has a refresher */ });
test('unified sign-in makes one account per Instagram account shared', async () => { /* exchange with two assigned accounts → two ConnectedAccount, each with login unified and its id */ });
test('unified sign-in with no Instagram account shared says so', async () => { /* empty data → rejects /no Instagram professional account/ */ });
```

- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL, `instagramLoginOf` missing.
- [ ] **Step 3: Implement.** The `instagram` variant is today's spec with `app: { id: 'instagram', term: 'app', name: 'Instagram' }`
  and `label: 'Instagram Login'`. The `unified` variant: `app: { id: 'meta', term: 'app', name: 'Meta' }`,
  `config: 'instagramConfigId'`, `label: 'Unified Login'`, `authorizeUrl` → `facebookDialogUrl`,
  `exchange` → `unifiedAccess` mapped to accounts. `build` passes `host: instagramLoginOf(settings) === 'instagram' ? 'instagram' : 'facebook'`
  (read `login` with `get('login')`). `refresher` returns undefined unless the login is `instagram`.
  `permissions` lists both families; `howTo` says: "Set your Meta app's Instagram setup in Settings.
  Unified Login: create a configuration in Instagram → API setup with Unified login whose token never
  expires, and set its id and the Meta app id and secret in Settings."
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(instagram): connect through Unified Login` and **push** to `origin main`
  (this alone lets a new Meta app connect Instagram).

---

### Task 5: Facebook Login for Business for Instagram

**Files:**
- Modify: `packages/runtime/src/channels/instagram.ts` (the `facebook` variant)
- Test: `packages/runtime/test/instagram-logins.test.ts`

**Interfaces:**
- Consumes: `exchangeFacebookCode`, `longLivedUserToken`, `listPages` (Task 2).
- Produces: Facebook-login accounts: settings `{ login: 'facebook', userId: <ig id>, pageId }`,
  secrets `{ accessToken: <Page token> }` (or the long-lived user token, if Task 0 found the Page
  token refused), label `@<username>`.

- [ ] **Step 1: Write the failing tests:**

```ts
test('facebook sign-in keeps one account per Page with Instagram, with the Page token', async () => {
  // code → user token → long-lived token → two Pages, one without Instagram
  assert.deepEqual(accounts.map((a) => [a.credentials.settings.userId, a.credentials.settings.pageId, a.credentials.secrets.accessToken]), [['17841416971174402', '17841400000000001', 'pt1']]);
});
test('Pages with no Instagram account say what to link', async () => { /* every Page without instagram → rejects /none of the Pages you shared has an Instagram professional account linked/ */ });
test('a facebook account reads graph.facebook.com and is never refreshed', () => { /* as the unified one */ });
```

- [ ] **Step 2:** Sluice `verify` (`gates: ["test"]`). Expected: FAIL, no `facebook` variant.
- [ ] **Step 3: Implement** the variant: `app.id: 'meta'`, `config: 'instagramConfigId'`,
  `label: 'Facebook Login (Instagram linked to a Page)'`; exchange → long-lived token → `listPages`
  → the Pages whose `instagram` is set. If Task 0 recorded the Page token refused, keep the
  long-lived user token and give these accounts a refresher calling `longLivedUserToken` every 30 days.
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(instagram): connect an Instagram account linked to a Facebook Page` and **push**.

---

### Task 6: The Facebook channel's definition

**Files:**
- Create: `packages/schema/src/channels/facebook.ts`
- Modify: `packages/schema/src/channels/registry.ts` (after `threads`), `packages/schema/src/channels/index.ts` (export)
- Modify: `packages/schema/src/brand.ts:39` (`languages.facebook: Language.optional()`)
- Modify: `packages/schema/src/tracking.ts` (`UTM_CHANNELS.facebook = { source: 'facebook', medium: 'social' }`; the comment at line 158 no longer calls Facebook a non-channel)
- Modify: `packages/engine/src/prompt.ts:140-157` (`facebookLanguage`, resolved as `linkedinLanguage` is, from `brand.languages.facebook`; added to `PROMPT_VARIABLES`)
- Create: `design/icons/facebook.svg`; regenerate `apps/web/src/components/kit/glyphs.ts` with the repo's glyph script (find it with `grep -rn "Generated from design/icons" --include=*.ts -l` and its `package.json` script)
- Test: `packages/schema/test/content-pack.test.ts`, `packages/schema/test/launch-config.test.ts`, `packages/engine/test/prompt*.test.ts` (whichever covers `linkedinLanguage`)

**Interfaces:**
- Produces: `export const facebook = { id: 'facebook', name: 'Facebook', inSentence: 'Facebook', icon: 'facebook', defaultMode: 'off', group: 'social', publishedBy: 'engine', idempotent: false, schedulable: true, pack: { key: 'facebook', piece, postText }, … } as const satisfies ChannelDefinition<'facebook'>`;
  piece `{ text: string }` with `limits = { facebookText: 2000 }`; `edit: { edit: 'yes', delete: 'yes', fields: <the text field as mastodon.ts declares it>, main: 'post' }`;
  `comments: { read: true, reply: true, replyLimit: 8000 }`; `profile: { read: true, edit: 'no', fields: ['bio', 'avatar'], editable: [] }`;
  metric families `views: ['views'], reactions: ['reactions'], comments: ['comments'], shares: ['shares'], clicks: ['clicks']`, `primary: ['views', 'reactions']`, `cadence: HOURLY_BATCHED`;
  brief: one post in `{{facebookLanguage}}`, at most `{{limit.facebookText}}` characters, the first
  line carries the point, no link in the text (the article is attached as the link card), at most
  three hashtags. Posting windows: weekdays 9-11 (1) and 13-15 (0.8), weekends 10-12 (0.4).

- [ ] **Step 1: Write the failing tests:** a pack with `facebook: { text: 'x'.repeat(2001) }` fails
  with `at most 2000 characters`; a `launch.yml` with `publishing.facebook: approval` parses and one
  without it defaults to `off`; with `languages: { blog: ['es', 'en'], facebook: 'es' }` the brief says
  "Spanish".
- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL.
- [ ] **Step 3: Implement** as specified, following `linkedin.ts` (a post whose link is the card).
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS (the adapter contract test
  tolerates a definition without an adapter until Task 8; if it does not, do Tasks 6 to 8 before verifying the suite).
- [ ] **Step 5: Commit** `feat(schema): the Facebook Page channel's definition`.

---

### Task 7: The FacebookPage connector

**Files:**
- Create: `packages/connectors/src/facebook.ts`; modify `packages/connectors/src/index.ts`
- Test: `packages/connectors/test/facebook.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface FacebookPageOptions { pageId: string; accessToken: string; fetch?: typeof fetch; version?: string; cache?: IdentityCache }
  export class FacebookPage implements CommentReader, Replier {
    publish(p: { text: string; link: string; imageUrl: string }): Promise<Published>; // POST /{page}/feed {message, link}; url from /{post}?fields=permalink_url
    edit(id: string, e: { text: string }): Promise<void>;   // POST /{post} {message}
    delete(id: string): Promise<void>;                      // DELETE /{post}
    metrics(id: string): Promise<Metrics>;                  // FACEBOOK_POST_METRICS + reactions/comments/shares summaries
    comments(postId: string): Promise<Comment[]>;           // /{post}/comments?fields=id,message,created_time,from&filter=stream
    reply(target: ReplyTarget, text: string): Promise<SentReply>; // POST /{comment}/comments {message}
    check(): Promise<Check>;                                // /{page}?fields=id,name,picture{url}; another id → not ok
    profileStats(): Promise<ProfileStats>;                  // followers_count, fan_count as extra.likes; FACEBOOK_PAGE_METRICS for the last day
    profile(): Promise<Profile>;                            // about as bio, picture
  }
  ```
  Metric names map to the definition's families: views, reactions, comments, shares, clicks. A
  metric Meta refuses by name is dropped for the process's lifetime, as `instagram.ts:69-90` does
  (reuse that helper by moving it to `meta/graph.ts` rather than copying it).

- [ ] **Step 1: Write the failing tests:** publish sends `message` and `link` (not `imageUrl`) to
  `/v27.0/<page>/feed` and returns `{ externalId, url: permalink_url }`; edit posts `message` to
  `/<post>`; delete sends `DELETE`; a refused metric name is asked once and then left out; comments
  map `from.name` and mark the Page's own; `check` on another Page's token is `ok: false`.
- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL.
- [ ] **Step 3: Implement** with the metric names from Task 0.
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS.
- [ ] **Step 5: Commit** `feat(connectors): publish, edit, read and answer on a Facebook Page`.

---

### Task 8: The Facebook adapter

**Files:**
- Create: `packages/runtime/src/channels/facebook.ts`; modify `packages/runtime/src/channels/registry.ts` (after `threadsAdapter`)
- Modify: `apps/web/src/routes/auth/` (add `facebook.ts` and `facebook.callback.ts`, copies of the Threads pair), regenerate `routeTree.gen.ts` through the web app's build
- Modify: `apps/web/src/components/channels/view.ts` (a `facebook` case: followers, and likes as `others`)
- Test: `packages/runtime/test/channel-adapters.contract.test.ts` (runs over every adapter), `packages/runtime/test/facebook.test.ts` (new)

**Interfaces:**
- Consumes: `facebook` (Task 6), `FacebookPage` (Task 7), `facebookDialogUrl`, `exchangeFacebookCode`, `longLivedUserToken`, `listPages` (Task 2), `textPostStrategy` and `TextPostPublisher` from `@shipcast/engine`.
- Produces: `facebookAdapter` with `oauth: { app: { id: 'meta', term: 'app', name: 'Meta' }, config: 'facebookConfigId', … }`,
  one account per Page shared (settings `{ pageId }`, secrets `{ accessToken: <Page token> }`, label
  the Page's name), no `refresh`; `publisher` tags the link with the launch's tracking as
  `threads.ts` does; `strategy: textPostStrategy(facebook)`; `editor` a `ChangeEditor` mapping
  `changes.text`; `metrics`; `comments: { reader, replier }`.

- [ ] **Step 1: Write the failing tests:** sign-in with two Pages makes two accounts with their own
  tokens; with no Page shared rejects `/no Facebook Page/`; the publisher hands `FacebookPage.publish`
  a link with `utm_source=facebook`; the contract test lists `facebook` among the adapters and its
  network among the catalog's, with no `.env` variables required.
- [ ] **Step 2:** Sluice `verify` (`gates: ["typecheck"]`). Expected: FAIL.
- [ ] **Step 3: Implement** following `threads.ts` and `youtube.ts` (strategy and `ChangeEditor`).
  `permissions` lists the six Page permissions in words; `howTo`: "Add the Manage everything on your
  Page use case to your Meta app, create a Facebook Login for Business configuration with a User
  access token and the Pages permissions, and set its id and the Meta app id and secret in Settings."
- [ ] **Step 4:** Sluice `verify` (`gates: ["test"]`). Expected: PASS, `app-parity` and `mcp-parity`
  included.
- [ ] **Step 5:** Run the app with the `run` skill in preview mode and connect Facebook through the
  preview consent: the Channels page shows a Facebook card on the Social tab.
- [ ] **Step 6: Commit** `feat(facebook): publish launches on a Facebook Page` and **push**.

---

### Task 9: Documents

**Files (all through `kb_add_document`, read first with `kb_get_document`):**
- Create: `decisions/meta-logins.md` (context, the five decisions, the rejected approaches, the spike's findings, the date)
- Modify: `accounts.md` (the Instagram and Facebook rows, the OAuth flows section, the Meta app settings), `publishing.md` (the Facebook channel), `launch-yml.md` and `content-pack.md` (`facebook`), `status.md`, `plans/meta-logins.md` (Status: built, with the commits)

- [ ] **Step 1:** Write and update each document; `## Related` lists the wiki links.
- [ ] **Step 2:** Sluice `verify` (typecheck). Expected: PASS.
- [ ] **Step 3: Commit** `docs: every Meta login and the Facebook channel` and **push**.

## Outcome

Built by an autonomous run on 2026-11-05 and 2026-11-06, one implementer and one reviewer per task
and a whole-branch review at the end, on the brief [plans/goal-meta-logins.md](goal-meta-logins.md).
The decision record [decisions/meta-logins.md](../decisions/meta-logins.md) says what was built by
layer; this section lists what changed from the tasks above, and why.

### Commits

| Task | Commits |
| --- | --- |
| 1 | `323e0b4`, `17332c6` (the variant kept through the flow; the accounts it could not connect said) |
| 2 | `d85832d` |
| 3 | `0cb2c7a` |
| 4 | `58b2b00` (pushed) |
| 5 | `6e89ef4` (pushed) |
| 6 | `d6f439a` |
| 7 | `076d28b`, `d51c6d2` (a comment's replies threaded under their parent) |
| 8 | `d65e99e`, `5965972`, `e85f447` (pushed) |
| Final review | `cf59ac2`, `1959bae`, `ae3139f` |
| 9 | the documents commits |

The last suite run: 1,797 tests, 1,794 passing, 3 skipped, none failing, through Sluice. No
migration.

### What changed from the plan

- **Task 0 was not run.** It needs the owner's Meta app; the brief skipped it and the run built on
  the fallbacks this plan names. Its three questions are open and in the owner's test list
  ([plans/meta-logins.md](meta-logins.md#spike-findings-not-run-open-questions)).
- **Seven Facebook permissions, not six** (Task 8, `5965972`). Meta's comments guide asks for a third
  read permission to read a Page post's comments; `pages_read_user_content` was added to the
  permissions, the instructions and their test. The Global Constraints line above still lists six,
  as written.
- **`post_total_media_view_unique` instead of `post_impressions_unique`** (final review, `1959bae`).
  The fallback this plan names was retired by Meta on 2025-06-15 for every API version; asking for it
  would have left `views`, the channel's first primary metric, always empty.
- **The comments ask for `parent{id}`** (Task 7, `d51c6d2`). Task 7's fields had no parent, so a
  reply in the flat `stream` looked like a comment: the engine could not see the owner's own replies
  or thread them, and might answer twice. A reply's parent is its `inReplyTo`.
- **The link in the Facebook language** (Task 8). `textPostStrategy(facebook)` would have linked the
  lead article; `textPostStrategy` gained an optional `link`, and Facebook's passes the article in
  `brand.yml`'s `languages.facebook`, as Task 6's brief and the brand schema promise. The publisher
  also receives the launch's tracking.
- **The single-read cadence** (Task 8, `5965972`). Task 6 gave the definition `HOURLY_BATCHED`, but
  the adapter reads one post a call; the definition says `{ hours: 1, read: 'single' }`, and a test
  pins that the reader has no batched form.
- **Account matching by network id** (final review, `ae3139f`). `connectAccount` found an account by
  its label, so two Pages with the same name in one sign-in collapsed into one row (the second's
  token overwriting the first's) and a renamed Page came back as a duplicate. It matches on `pageId`
  or `userId` first, then by label only for a row stored without that id. The registry's unique
  `(network, brand, label)` made a new same-name account need another label: it is "Name (id)",
  which needs no migration.
- **Tokenless Pages skipped and named** (final review, `ae3139f`). `listPages` threw on a Page with
  no token, failing the whole sign-in; it now returns those Pages apart (`{ pages, tokenless }`), and
  the exchanges name them beside the accounts that connected, or fail naming them when none is
  usable. Instagram names only those with an Instagram account linked.
- **Accounts come back from a sign-in with a `problem`** (Task 1 ruling, then `ae3139f`).
  `ConnectedAccount` gained `problem`; `connectAll` lands on the first connected account as Task 1
  says, and carries the exchange's problems first, then the refused accounts', in the same redirect.
- **Each Unified account's own username** (final review, `cf59ac2`). One Unified token serves every
  account shared with it, so the own-username cache, keyed by token alone, gave every account the
  first one's name; it is keyed by token and account.
- **Words for the owner** (final review, `cf59ac2`, `ae3139f`): a comments refusal on
  `graph.facebook.com` names `instagram_manage_comments`; Facebook Login for Instagram says it may
  need `ads_read` or `ads_management` when the Page role comes through a business portfolio; a
  Unified configuration that issues a user token is told to issue a system-user one; Settings gives
  the new settings help lines, readable choices and "Instagram Login (default)" for an unset setup;
  the Channels page names the setting a sign-in lacks.
- **The test gate between Tasks 6 and 8** (pre-flight ruling). Task 6 verified typecheck only and
  committed; the suite, red on the missing adapter until Task 8, was required from Task 8, before the
  push. Nothing red was pushed.

### Rulings kept as they were

- **The Page token for Instagram through Facebook Login** (Task 5, and again after the final
  review's note that Meta's per-endpoint references name a user token): Meta's comparison table
  lists a "Facebook User or Page access token" for that setup, and the Page token does not expire.
  The owner's test settles it; the fallback is the long-lived user token with a refresher.
- **Action mode and the `.env` import** still carry only Instagram Login tokens. The spec covers the
  app's sign-in; such accounts are connected in the app.
- **Parked**: an Instagram row stored with an app-scoped id would get a second card on reconnect
  (the owner's account is stored with its professional id); `client_business_id: null` reads as a
  value (Meta omits the field rather than sending null).
- **Left as minor**: usage telemetry counts `graph.facebook.com` as Instagram; the comments read
  stops at 1,000 per post; a Page insight of `period=day` may be the current partial day; the
  Facebook glyph is a stroked "f", for the owner to judge.

### Deploys

Each push to `main` deployed and was checked healthy.

## Related

[[plans/meta-logins.md]] · [[accounts.md]] · [[publishing.md]] · [[decisions/architecture.md]] · [[decisions/new-networks.md]] · [[decisions/meta-logins.md]] · [[plans/goal-meta-logins.md]]