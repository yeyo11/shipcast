---
created_at: 2026-10-27T22:30:22.320530369Z
updated_at: 2026-10-27T22:30:22.320530369Z
tags:
    - server
    - deploy
    - docker
    - secrets
    - tls
    - proxy
---
# Running Shipcast on a server

Built on 2026-10-27 to move the owner's install off the laptop onto `apps-1`
(yeyo11/infra, `stacks/shipcast`), reachable at `https://shipcast.int.josegarrido.dev` over the
tailnet only. The desktop install (`pnpm app`, the keychain, the app's own certificate) does not
change; a server differs in three places, each switched by the environment.

## What changes on a server

| On a desktop | On a server | Switch |
|---|---|---|
| Secrets in the OS keychain (`secret-tool`, `security`) | **An encrypted file**, `<data dir>/secrets.enc`: AES-256-GCM, the key in the environment only, written atomically, mode 600 | `SHIPCAST_SECRET_STORE=file`, `SHIPCAST_SECRETS_KEY` |
| The app does TLS itself (Let's Encrypt over Cloudflare DNS) and asks Tailscale Serve for port 443 | **A reverse proxy does TLS** (Traefik); the app serves plain HTTP inside its container, with `SHIPCAST_PUBLIC_URL` as its origin, so links point where the browser is and cookies keep `Secure` | `SHIPCAST_APP_TLS=proxy`, `SHIPCAST_APP_HOST=0.0.0.0` |
| Node, pnpm and Chromium installed by hand | **The container image** (`Dockerfile`): Node 24.22.1, pnpm, git, Playwright's Chromium with its libraries, run as `node`; published to `ghcr.io/yeyo11/shipcast` (`sha-<12>`, `latest`) by `.github/workflows/image.yml` on every push to main | — |

`secretStoreFor` (`packages/runtime/src/secrets.ts`) picks the store for the web app, the runtime and
the certificate script. `FileStore` reads the file on every call and serialises its own writes, so a
CLI and the app on the same machine see each other's changes.

## Moving an install's secrets

On the machine that holds the keychain:

```bash
SHIPCAST_SECRETS_KEY=$(openssl rand -base64 32) node scripts/keychain-to-file.ts /tmp/secrets.enc
```

It lists the install's entries with `secret-tool search`, reads each value as stored with
`secret-tool lookup`, and writes them with the same `FileStore` the server opens; only the keys'
names are printed. The file goes to the server's data volume; the key goes to the server's `.env`,
apart from it.

## Not on a server (yet)

- **Webhooks**: the server is tailnet-only, so GitHub cannot reach it; the engine polls, as it does
  without a public address.
- **claudio**: not run beside the server's install (owner, 2026-10-27); the AI provider is set to the
  Anthropic API or an OpenAI-compatible server in the app's AI settings.

## Related

[[install.md]] · [[web-app.md]] · [[accounts.md]] · [[engine.md]] · [[claudio.md]] · [[decisions/web-app-stack.md]]
