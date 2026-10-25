---
created_at: 2026-10-25T01:37:52.826370246Z
updated_at: 2026-10-25T01:37:52.826370246Z
tags:
    - decision
    - web-app
    - stack
    - tls
    - keychain
    - auth
---
# The web app's stack and its boundaries

Decided on 2026-10-25 by the owner, in the questions before the [goal](../plans/goal-finish.md), and
built the same day ([web-app.md](../web-app.md)).

| Topic | Decision | Why |
| --- | --- | --- |
| Framework | **TanStack Start** in `apps/web` | The owner's choice; React and TypeScript like the rest; server functions keep the engine on the server |
| Production server | **Node's own** (`apps/web/server.ts`) over the built `fetch` handler, no Nitro | One small file does TLS, static files and the request conversion; nothing else to configure |
| Engine in the app | **External to the build**, run by Node's TypeScript support | The renderers are native and wasm; bundling them fails, and the CLI already runs the packages this way |
| Secrets | **The OS keychain** (`secret-tool`, `security`), `.env` as fallback | The owner's choice over an encrypted SQLite column or rewriting `.env`; no file Shipcast writes holds a token |
| Sign-in | **GitHub OAuth**, limited to allowed logins | The owner's choice over a shared token; serves phase 6 too |
| Sessions | **Signed cookies**, no session table | Nothing to store or expire server-side; the key is in the keychain |
| Address | **A subdomain of the owner's domain on the tailnet address** | The owner's choice; OAuth providers need HTTPS callbacks, and Meta needs them listed |
| Certificate | **Let's Encrypt by DNS-01 on Cloudflare**, renewed in the app | Tailscale Serve only certifies `*.ts.net`; an HTTP challenge cannot reach a tailnet address |
| Port 443 | **Tailscale Serve TCP forward** to `127.0.0.1:8443` | No root and no capability on Node; TLS still ends in the app |
| Getting in without GitHub | **A single-use link printed by the app** | For the owner at their terminal, and for an agent the owner runs the app for |
| Design | **Cartel, as approved** | The owner counted Cartel as validated and reviews the app at the end |

**Rejected:** Next.js and a Vite SPA (the owner chose Start); Caddy in front (one more service for
what Node's `https` and `setSecureContext` do); a CLI-only dashboard (forms and OAuth need pages);
a dynamic loopback trust for development (Tailscale's TCP forward makes every request arrive from
`127.0.0.1`, so loopback proves nothing).

## Related

[[web-app.md]] · [[accounts.md]] · [[plans/goal-finish.md]] · [[plans/stack.md]] · [[plans/design-system.md]]
