---
created_at: 2026-10-25T01:37:22.715987418Z
updated_at: 2026-10-25T01:37:22.715987418Z
tags:
    - web-app
    - dashboard
    - channels
    - auth
    - tls
    - decision
---
# The web app

Built on 2026-10-25 for the [goal](plans/goal-finish.md): `apps/web`, the place to see the launches
and their numbers, connect the channels, review and approve drafts, launch a repo and write an
article. It replaced the CLI's plain dashboard; the CLI keeps every other command. The look is
Cartel ([plans/design-system.md](plans/design-system.md)): the `design/` folder is the app's public
folder, so tokens, fonts, logo and channel glyphs have one copy.

## Running it

| Command | Does |
| --- | --- |
| `pnpm app` | Builds the app and serves it on `SHIPCAST_PUBLIC_URL` (HTTPS, tailnet only), printing a one-time sign-in link |
| `pnpm app:dev` | Vite's development server on `http://127.0.0.1:3000`, printing a one-time sign-in link |

What `.env` needs is in `.env.example` under "The web app": the public URL, the GitHub OAuth App's
id and secret, the allowed logins, and the Cloudflare token for the certificate.

## How it reaches the owner, and only the owner

- **The domain is private.** An A record of a subdomain of the owner's domain points at this
  machine's tailnet address, so only the owner's devices on the tailnet can reach it. The record is
  public DNS, but the address behind it answers no one outside the tailnet.
- **HTTPS with a real certificate.** Tailscale Serve only issues `*.ts.net` certificates, so the app
  gets its own from Let's Encrypt through the DNS challenge on Cloudflare (`apps/web/tls.ts`, with
  `acme-client`): a TXT record proves control, since no authority can reach a tailnet address. The
  certificate lives in `data/tls/`, its key and the ACME account key in the keychain; it is renewed
  when less than 30 days remain, checked daily and swapped in without a restart.
- **Port 443 through Tailscale Serve.** The app listens on `127.0.0.1:8443` and `pnpm app` runs
  `tailscale serve --bg --tcp 443 tcp://127.0.0.1:8443`: a plain TCP forward, so TLS still ends in
  the app with the domain's certificate. No root, no capability on Node.
- **Sign in with GitHub.** An OAuth App with the callback `/auth/github/callback`; the code is
  exchanged for a token used once to read the login, which must be in `SHIPCAST_ALLOWED_GITHUB`. The
  token is not kept. The session is the login and an expiry signed with HMAC-SHA256 (key in the
  keychain), in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie for 14 days.
- **Console links.** The app prints a single-use sign-in link (15 minutes) when it starts: a way in
  without GitHub for whoever reads the app's own terminal.
- **Every request is checked.** A request middleware (`src/start.ts`) sends pages without a session to
  `/login` and answers everything else with 401; Start's CSRF middleware refuses any change whose
  `Sec-Fetch-Site`, `Origin` or `Referer` is not the app's own. Server functions check the shape of
  their input (`src/server/input.ts`) before using it.

## Sections

- **Launches** (`/`): every launch as the specimen's launch card (state pill, one row per channel
  with its post), what is waiting for the owner on a yellow band, and the work running in the
  background, refreshed while something runs. `/api/launches` gives the same as JSON.
- **A launch** (`/launches/<id>`): its drafts read from the pull request's branch, each article and
  channel text editable (a save is a commit on that branch), the media, **Approve and publish**
  (merges the pull request with a squash, then publishes in the background, waiting for the site to
  deploy), failed channels with **Try again** (that launch only), and the latest numbers by source.
- **Launch a repo** (`/launch`): the owner's repos and their releases, the
  [pre-flight check](engine.md#the-pre-flight-check) shown as Ready / Blocks / Advice, and the choice
  between reviewing the drafts first or publishing without review. Drafting runs in the background.
- **Write** (`/write`): an article in the owner's words, in Spanish or English; the channels it
  also goes to (those with a working account, plus the drafts-only ones); review first or publish
  directly. See [articles](engine.md#articles-written-in-the-app).
- **Channels** (`/channels`): see [accounts.md](accounts.md).

## How it is built

- **TanStack Start** (React 19, Vite 8), file routes in `src/routes/`, pages under the `_app`
  layout. Server functions live in `src/server/*.functions.ts`; what only the server may load in
  `*.server.ts`.
- **The engine is not bundled.** The workspace packages are external to the server build and run
  through Node's own TypeScript support, as they do for the CLI, so the native and wasm renderers of
  `@shipcast/assets` never go through Vite. Client dependency discovery is turned off for the same
  reason (it would crawl from the routes into the engine's source). A consequence in development: a
  change to an engine package needs a restart of `pnpm app:dev`.
- **Production runs Node's own server** (`apps/web/server.ts`): the built Start handler is a `fetch`
  function; the server converts requests, serves `dist/client` with long caching for hashed assets,
  and terminates TLS. No Nitro.
- **One context per process** (`src/server/context.server.ts`): the configuration, the registry,
  the GitHub client, the keychain and the brand (read from the launches repo every five minutes).
- **Background jobs** (`src/server/jobs.server.ts`) run in the app's process and are kept in memory:
  drafting (minutes of AI work) and publishing (waiting for the deploy, up to 20 minutes, then the
  next publish round picks it up). The registry holds what matters, so a restart loses only the
  progress lines.
- **Notices.** With Telegram connected, the owner's own chat with the bot hears when drafts wait,
  when a launch is published and when it fails; `watch` does the same.

## Related

[[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[plans/goal-finish.md]] · [[plans/design-system.md]] · [[decisions/web-app-stack.md]] · [[status.md]]
