---
created_at: 2026-10-24T13:30:35.39622807Z
updated_at: 2026-10-24T13:30:35.39622807Z
tags:
    - claudio
    - ai-provider
    - docker
    - operations
---
# claudio, the AI provider

Shipcast analyses repositories and writes content through [claudio](https://github.com/yeyo11/claudio),
which runs Claude Code as a service with a REST API. Shipcast runs **an instance of its own**, from
[`docker-compose.yml`](../docker-compose.yml) in this repo, instead of sharing the owner's desktop app
or another project's container: its data, sign-in and workspace stay separate, and the version it
runs is the one the engine was written against. Decided on 2026-10-24 by the owner, who configures
the instance.

## Setting it up

1. Make a token and put it in `.env` as `CLAUDIO_API_TOKEN` (copy `.env.example` first):

   ```bash
   openssl rand -hex 32
   ```

   The same value is the instance's owner token (`CLAUDIO_AUTH_TOKEN` inside the container) and the
   bearer token the engine sends, so there is one secret, not two that can drift.
2. Start it:

   ```bash
   docker compose up -d
   ```

3. Open <http://localhost:8798>, sign in with that token, and sign in to Claude in the setup
   assistant (a Claude account, or a pay-per-use API key).

## How the compose file is built, and why

- **Image pinned to `ghcr.io/yeyo11/claudio:0.8.1`.** The engine depends on claudio's API; moving the
  version is a deliberate change, made together with whatever the engine needs for it.
- **Port `127.0.0.1:8798`**, not claudio's usual 8797, so it can run beside the desktop app or a dev
  server. Loopback only: nothing outside the laptop reaches it. `CLAUDIO_PORT` changes it.
- **`environment:` instead of `env_file: .env`.** Shipcast's `.env` also holds the GitHub and network
  tokens; claudio receives only its auth mode and token.
- **`name: shipcast`** fixes the Compose project name, so the volumes are `shipcast_claude-config` and
  `shipcast_claudio-data` whatever folder the command runs from.
- **`./workspace` is shared.** The engine clones the repository being launched into `workspace/` on
  the host; claudio sees it under `/workspace` and runs Claude Code there. The folder is gitignored.

## Related

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[status.md]]
