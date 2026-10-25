---
created_at: 2026-10-25T08:11:32.642536429Z
updated_at: 2026-10-25T09:54:41.582497375Z
tags:
    - web-app
    - dashboard
    - channels
    - auth
    - tls
    - decision
    - automation
    - webhooks
---
# The web app

Built on 2026-10-25 for the [goal](plans/goal-finish.md): `apps/web`, the place to see the launches
and their numbers, connect the channels, review and approve drafts, launch a repo, write an article
and choose how the work runs on its own. It replaced the CLI's plain dashboard; the CLI keeps every
other command. The look is Cartel ([plans/design-system.md](plans/design-system.md)): the `design/`
folder is the app's public folder, so tokens, fonts, logo and channel glyphs have one copy.

## Running it

| Command | Does |
| --- | --- |
| `pnpm app` | Builds the app and serves it on `SHIPCAST_PUBLIC_URL` over HTTPS (tailnet only), printing a one-time sign-in link |
| `pnpm app:dev` | Vite's development server on `http://127.0.0.1:3000`, printing a one-time sign-in link |
| `pnpm --filter @shipcast/web exec node scripts/certificate-by-hand.ts` | Gets the certificate without a Cloudflare token: it writes the challenge's TXT record to `data/tls/challenge.json` for someone to create, and waits for DNS to answer it |

What `.env` needs is in `.env.example` under "The web app": the public URL, the GitHub OAuth App's
id and secret, the allowed logins, and the Cloudflare token for the certificate. The app is meant to
move to a VPS or server; until then it runs on the owner's machine.

## How it reaches the owner, and only the owner

- **One private address: `https://shipcast.josegarrido.dev`.** Its A record points at this machine's
  tailnet address, so only the owner's devices on the tailnet can reach it. The record is public DNS,
  but the address behind it answers no one outside the tailnet. A local-network address was tried
  on 2026-10-25 and removed: the app has one address.
- **HTTPS with a real certificate.** Tailscale Serve only issues `*.ts.net` certificates, so the app
  gets its own from Let's Encrypt through the DNS challenge (`apps/web/tls.ts`, with `acme-client`): a
  TXT record proves control, since no authority can reach a tailnet address. The record is placed by
  a `DnsSolver`: Cloudflare's API with `SHIPCAST_TLS_CLOUDFLARE_TOKEN` (Zone DNS edit on the zone), or
  by hand with `scripts/certificate-by-hand.ts` when there is no token. The certificate lives in
  `data/tls/`, its key and the ACME account key in the keychain; it is renewed when less than 30 days
  remain, checked daily and swapped in without a restart. Without a token a valid certificate on disk
  is still served, and the app says how many days it has left. Since 2026-10-25 the token is set and
  the certificate renews itself. `acme-client` pulls `node-forge`, whose advisory GHSA-86w9-cpqp-85rv
  is in a path Shipcast never takes (it signs with Node's own crypto): `pnpm audit` ignores it, with
  the reason, in `pnpm-workspace.yaml`.
- **Port 443 through Tailscale Serve.** The app listens on `127.0.0.1:8744` (8443 was taken on the
  owner's machine) and `pnpm app` runs `tailscale serve --bg --tcp 443 tcp://127.0.0.1:8744`: a plain
  TCP forward, so TLS still ends in the app. A TCP forward cannot share the tailnet's port 443 with a
  Tailscale Serve web handler: another app served on 443 has to move to another port first.
- **Sign in with GitHub.** An OAuth App with the callback `/auth/github/callback`; the code is
  exchanged for a token used once to read the login, which must be in `SHIPCAST_ALLOWED_GITHUB`. The
  token is not kept. The session is the login and an expiry signed with HMAC-SHA256 (key in the
  keychain), in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie for 14 days.
- **Console links.** The app prints a single-use sign-in link (15 minutes) when it starts: a way in
  without GitHub for whoever reads the app's own terminal.
- **Every request is checked.** A request middleware (`src/start.ts`) sends pages without a session to
  `/login` and answers everything else with 401; Start's CSRF middleware refuses any change whose
  `Sec-Fetch-Site`, `Origin` or `Referer` is not the app's own. Server functions check the shape of
  their input (`src/server/input.ts`) before using it. Two paths are public on purpose: `/api/health`
  (it answers `ok` and nothing else) and the GitHub webhook, which carries its own proof.

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
- **Channels** (`/channels`): see [accounts.md](accounts.md). A newly connected account lands on the
  list, scrolled to and focused.
- **Automation** (`/automation`): below.

Every action's outcome is a toast in Cartel (Done, Failed with its diamond, Waiting for you on
yellow), and every error is explained for a person, with the original text folded under Details
(`src/components/errors.ts`). Scrolling is smoothed by Lenis, off for anyone who asks the system for
reduced motion.

## Automation

Added on 2026-10-25 ([plans/mvp-close.md](plans/mvp-close.md)). From its start the app runs the
shared round ([publishing.md](publishing.md#the-rounds-and-the-shipcast-command)) on its own timer, so
nothing depends on a terminal running `watch`; `server.ts` warms the app's context through
`/api/health` as soon as it listens, and the first round runs 15 seconds later.

- **The mode**, chosen in the page and kept in the registry: **Rounds** (polling the account's events
  every interval, at least 60 seconds), **GitHub webhooks** (GitHub's deliveries claim releases and
  merges as they happen; the timer still publishes what is ready, refreshes tokens and reads the
  metrics), or **Off** (only the owner's actions). Rounds is the default.
- **The webhook** (`POST /api/github/webhook`): trusted only with a valid `X-Hub-Signature-256`
  (HMAC-SHA256 of the exact body with the shared secret, compared in constant time), acted on only
  while webhooks are the chosen mode, answered at once (GitHub gives up after ten seconds) while
  drafting and publishing run in the background. A `ping` answers; a published release is claimed by
  the same rules as polling (`claimEvent`, so a release is never launched twice whichever way it
  arrives); a repo made public likewise; a merged pull request in the launches repo publishes its
  launch. Everything else is answered and ignored with its reason.
- **The secret** is generated in the page (32 random bytes), kept in the keychain, shown once and
  rotatable; the page gives the payload URL, the content type and what to tick on GitHub: per repo
  (the owner's are user accounts), *Releases* (and *Repositories* for a repo going public), and
  *Pull requests* on the launches repo.
- **What happened**: the last round and the last delivery, with their lines; and **Run a round now**.
- GitHub can only deliver once the app is reachable from it, which is the VPS's job; signed test
  deliveries (a ping, an ignored event, a bad signature, a merge with no launch) answered as expected
  on 2026-10-25.

## How it is built

- **TanStack Start** (React 19, Vite 8), file routes in `src/routes/`, pages under the `_app`
  layout. Server functions live in `src/server/*.functions.ts`; what only the server may load in
  `*.server.ts`.
- **The engine is not bundled.** The workspace packages are external to the server build and run
  through Node's own TypeScript support, as they do for the CLI, so the native and wasm renderers of
  `@shipcast/assets` and Playwright never go through Vite. Client dependency discovery is turned off
  for the same reason. A consequence in development: a change to an engine package needs a restart
  of `pnpm app:dev`.
- **Production runs Node's own server** (`apps/web/server.ts`): the built Start handler is a `fetch`
  function; the server converts requests, serves `dist/client` with long caching for hashed assets,
  and terminates TLS. No Nitro.
- **One context per process** (`src/server/context.server.ts`): the configuration, the registry,
  the GitHub client, the keychain and the brand (read from the launches repo every five minutes); it
  starts the automation timer. The repo's root is found by its `pnpm-workspace.yaml` from where the
  app runs, not from the module's path, which differs between development and the bundle.
- **Background jobs** (`src/server/jobs.server.ts`) run in the app's process and are kept in memory:
  drafting (minutes of AI work) and publishing (waiting for the deploy, up to 20 minutes, then the
  next round picks it up). The registry holds what matters, so a restart loses only the progress
  lines.

## Related

[[accounts.md]] · [[engine.md]] · [[publishing.md]] · [[plans/goal-finish.md]] · [[plans/mvp-close.md]] · [[plans/design-system.md]] · [[decisions/web-app-stack.md]] · [[status.md]]
