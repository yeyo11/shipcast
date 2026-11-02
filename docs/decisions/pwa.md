---
created_at: 2026-11-02T23:16:26.042477654Z
updated_at: 2026-11-02T23:16:26.042477654Z
tags:
    - decision
    - pwa
    - service-worker
    - offline
    - web-app
---
# Decision: an installable app, by our own service worker

Decided on 2026-11-03 for v0.3.0 (SHP-28). Shipcast's web app is a PWA: it installs on a phone or a
desktop and opens standalone, shows its own page when the connection is gone, offers each new deploy
instead of swapping it in, and takes web push notifications ([push.md](../push.md)).

## What was chosen

**A service worker of our own, about 150 lines (`apps/web/src/pwa/sw.ts`), built by a small Vite
plugin of our own (`apps/web/pwa-plugin.ts`). No Workbox, no vite-plugin-pwa.**

- The app caches almost nothing on purpose. Every page is rendered on the server with the owner's data
  in it, behind the session cookie, so a page must never sit in a cache: on a shared or lost device
  it would outlive the sign-out. What is left to cache is the build's public files, and that needs
  two strategies, not a framework.
- vite-plugin-pwa targets a single client build. TanStack Start builds two environments (client and
  SSR) on Vite 8 and renders the HTML at request time, so there is no `index.html` to precache and
  the plugin's navigation fallback would have to be turned off. Its `injectManifest` mode would leave
  us writing the same worker with Workbox's runtime added; Workbox's precaching is the part we would
  use, and it is a few lines here.
- The rule that matters, what is cached and what is not, is one pure function
  (`swStrategy` in `src/pwa/rules.ts`) that the tests hold, path by path, rather than a set of
  framework routes.

## The rules

| Request | What the worker does |
| --- | --- |
| Another origin, any method but GET | Nothing: the browser goes to the network as if there were no worker |
| `/api/*`, `/mcp`, `/media/*`, `/uploads/*`, `/avatars/*`, `/auth/*`, `/login`, `/livez`, `/readyz`, server functions (`/_serverFn/*`), `/sw.js`, `/manifest.webmanifest` | Network only, never stored, as a page or a fetch |
| Any other page (a navigation) | Network only, never stored; the precached **offline page** when the network fails |
| `/assets/*` (hashed by the build) | Cache first: precached at install, the name changes with the content |
| `/fonts/*`, `/logo/*`, `/pwa/*`, `/icons/*`, `/tokens.css`, `/offline.html` | Stale while revalidate |
| Anything else (a query string on a public file included) | Network only |

A response is stored only when it is a whole 200 from this origin with no `Set-Cookie` and no
`private` or `no-store` (`cacheable`). The sign-out (`POST /auth/logout`, the shell's and the palette's
form) is seen by the worker, which empties its runtime cache; nothing private is in it in the first
place, since no private path is ever stored.

## Precache, versions and updates

- At build time the plugin lists the client build's `assets/*`, the design folder's fonts, tokens,
  logo and the PWA icons, and the offline page: 104 files, about 3 MB. The worker's version is a hash
  of that list, the non-hashed files' contents, the offline page and the worker's source, so a deploy
  makes a new worker exactly when something it serves changed.
- Install precaches with `cache: 'reload'` (never an old copy from the HTTP cache). A new worker then
  **waits**. The shell (`src/pwa/PwaUpdates.tsx`, mounted in `_app.tsx`) shows the kit's toast "New
  version available" with **Reload**, which stays until it is used; only that click tells the worker
  to take over and reloads that tab. Another open tab says "Shipcast was updated" and waits for its own
  Reload: no page is reloaded in the middle of an edit. The app looks for a new worker hourly and each
  time it comes back to the screen; the worker script is always fetched past the HTTP cache
  (`updateViaCache: 'none'`, and `server.ts` serves `/sw.js`, the manifest and the offline page with
  `no-cache`).
- Activate deletes every `shipcast-*` cache of another version.
- Development (`pnpm app:dev`) serves the manifest and the offline page but registers no worker, so
  Vite's hot reload is never answered from a cache.

## The manifest and the head

`src/pwa/manifest.ts`, served as `/manifest.webmanifest`: name and short name Shipcast, `start_url`
`/launches` (a new route that sends to the list at `/`), `scope` `/`, `display` `standalone`,
`theme_color` and `background_color` `#141413` (the tokens' night ground, the default theme), icons
at 192 and 512 px in `any` and `maskable`, and the shortcuts Launches, Write, Comments and Stats. The
root document links it (with credentials, in case a proxy asking for a sign-in is ever put in front)
and adds `theme-color`, `apple-touch-icon` (180 px), `apple-mobile-web-app-capable`,
`apple-mobile-web-app-status-bar-style` `black-translucent` and the title; `viewport-fit=cover` was
already there, so the bars' `env(safe-area-inset-*)` paddings (`kit.css`) take effect in the
installed app.

The icons and the offline page's scene are committed under `design/pwa/` (the app's public folder),
drawn by `pnpm pwa:assets` (`apps/web/scripts/pwa-assets.tsx`) from `design/logo/mark.svg` and the
Offline illustration, so a build never needs a browser. The offline page (`src/pwa/offline-page.ts`)
is the app's bare Offline page as static HTML on the build's own kit stylesheets, saying "You're
offline", with Try again and a reload as soon as the browser is back online.

## Checked

On 2026-11-03, against the built client in headless Chrome: Chrome's installability check reports no
error, the manifest parses with no error, the worker precaches the 104 files, an offline navigation
shows the offline page, `/api/*` offline fails rather than answering from a cache, and a web push sent
with throwaway VAPID keys through Google's push service (201) is shown by the worker. The full app
could not be started locally for this (its preview needs an https public address), so the update toast
and the Settings page were not seen in a browser before the deploy.

## Related

[[push.md]] · [[web-app.md]] · [[server.md]] · [[decisions/web-app-stack.md]] · [[decisions/component-layer.md]] · [[decisions/architecture.md]]
