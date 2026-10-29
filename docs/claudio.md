---
created_at: 2026-10-28T08:00:40.756364133Z
updated_at: 2026-10-29T11:05:48.37363703Z
tags:
    - claudio
    - ai-provider
    - docker
    - operations
    - errors
    - ai-sdk
    - workspaces
---
# claudio, the AI provider

[claudio](https://github.com/yeyo11/claudio) runs Claude Code as a service, on the owner's Claude
subscription. It is one of Shipcast's AI providers, listed in the AI settings as "Claude Code — your
subscription (via Claudio)". Shipcast always talks to **an instance of its own**, never the owner's
desktop app or another project's container: its data, sign-in and workspaces stay separate, and the
version it runs is the one the engine was written against. Decided on 2026-10-24 by the owner, who
configures the instance.

- **A local install** runs it from [`docker-compose.yml`](../docker-compose.yml) in this repo.
- **Production** (`apps-1`, since 2026-10-29) runs Shipcast's own headless claudio,
  `ghcr.io/yeyo11/claudio:0.11.0-headless`, in Shipcast's stack (yeyo11/infra#18): its own volumes, a
  daily spend cap of 100 USD (`CLAUDIO_DAILY_SPEND_CAP_USD`), its token in a file of its own on the
  server, reached inside the stack at `http://claudio:8797`. Shipcast's `claudio-url` setting and its
  `app:claudio-token` secret point at it ([server.md](server.md#what-production-runs-2026-10-29)).

Since 2026-10-25 claudio is one of several providers chosen per task in the AI settings
([decisions/ai-providers.md](decisions/ai-providers.md)). Since 2026-10-28 there are two ways
Shipcast talks to it, chosen by the `ai-runner` flag ([decisions/ai-layer.md](decisions/ai-layer.md)):
the AI task runner (flag on, what production runs since 2026-10-29) and the first AI layer (flag off,
the legacy path). The first real article through the runner on production's claudio, the Sluice
article (yeyo11/launches#13), took two `/v1` chat completions and about 3.5 minutes.

## Setting it up

1. Make a token (`openssl rand -hex 32`) and put it in `.env` as `SHIPCAST_CLAUDIO_TOKEN` (copy
   `.env.example` first). Compose starts claudio with it as the instance's owner token
   (`CLAUDIO_AUTH_TOKEN` inside the container), and Shipcast sends the same value as its bearer token.
2. Start it:

   ```bash
   docker compose up -d
   ```

3. Sign in to Claude once, from the command line, since the headless image has no web UI:

   ```bash
   docker compose exec claudio claudio login
   ```

4. In Shipcast's Settings, set claudio's URL (`http://localhost:8798`) and token. Both are settings
   (`claudio-url`, the token in the secret store as `app:claudio-token`); `SHIPCAST_CLAUDIO_URL` and
   `SHIPCAST_CLAUDIO_TOKEN` in `.env` are copied into them once and stay a fallback.

## With `ai-runner`: an AI SDK provider over `/api/v1`

The provider module is `packages/engine/src/ai/providers/claudio/`. Shipcast's `AiTaskRunner` runs
every task; claudio only answers model calls, and is itself an agent for the tasks that read code.

- **The model** is the AI SDK's OpenAI-compatible chat model on `<claudio>/api/v1`, wrapped
  (`createClaudio`, `model.ts`) so claudio's own features are asked the SDK's way, as
  `providerOptions.claudio` (`workspace`, `allowedTools` or `toolPreset`, `maxTurns`,
  `maxBudgetUsd`), and sent as its headers (`X-Claudio-Workspace`, `X-Claudio-Allowed-Tools`,
  `X-Claudio-Max-Turns`, `X-Claudio-Max-Budget-Usd`). The chat id and the turn's cost come back as
  `providerMetadata.claudio`. Every call carries the task's turn and budget ceilings, since claudio
  applies its own 1 USD default otherwise. The budget is the owner's spend limit for the task in the
  AI settings, else the global AI budget (for the pack, the article and the check), else the task's
  default (`DEFAULT_AI_BUDGETS_USD`: pack 5, article 3, assistant-check 2, assistant 1, replies 1,
  profile 0.5 USD). Claudio is the only provider given one. The instance's daily spend cap sits above
  all of them.
- **Workspaces, no shared folder** (`workspaces.ts`). For a task that reads the repo (`repoAccess:
  'remote-workspace'`), the runner resolves GitHub's tarball redirect for the release tag with
  Shipcast's own token and gives claudio only the short-lived `codeload` URL; claudio downloads and
  unpacks it read-only (`POST /api/workspaces`), names it by id, and Shipcast deletes it at the end of
  the run, whatever the end (`DELETE /api/workspaces/<id>`). A GitHub token never reaches claudio.
- **What Claude Code may run** there is `ANALYSIS_RULES` (`packages/schema/src/ai/tasks.ts`): Read,
  Grep, Glob and read-only forms of `ls`, `find`, `cat`, `head`, `tail`, `sed -n`, `grep`, `wc`,
  `cut`, `sort`, `uniq`, `tr` and `rg`. claudio's guard lets a Bash call through only when every
  subcommand matches one.
- **The answer** comes in the response format; claudio refuses client tools beside one, so the runner
  passes none.
- **Errors** are one table (`errors.ts`), mapped to `AiError`: a usage limit (`rate_limit_exceeded`)
  is retryable after `Retry-After`; `max_turns`, `max_budget` and `no_structured_output` say the task
  stopped without an answer; `tool_blocked` and the workspace refusals (host not allowed, too large,
  bad archive) are refused; a gone or expired workspace is retried with a new one.
- **Readiness**: `/api/ready` (no token) says "not signed in to Claude" or "still starting" before a
  launch fails; onboarding and the AI settings' test use it.

## Without `ai-runner`: the first layer (legacy)

Reachable only through `@shipcast/engine/legacy-ai` (`packages/engine/src/claudio.ts`), and removed
once the runner is verified in production.

- **Structured work on claudio's REST API.** The content pack and an article (`generateObject`) start
  a chat with `POST /api/chats`: the prompt, the `cwd` of the clone under `/workspace`, `jsonSchema`,
  read-only `allowedTools` and `permissionMode: 'dontAsk'`; the answer is the input of Claude Code's
  `StructuredOutput` tool, and the chat is stopped after it. This path needs claudio to see the
  engine's clones on its own disk: compose mounts `./workspace` for it.
- **Streamed text** for the writing assistant through `@ai-sdk/openai-compatible` on `<claudio>/api/v1`.
- **A chat that ends without an answer** says why, in words the owner can act on (`noAnswer`): a
  usage limit ("You've hit your session limit · resets 7:30pm (UTC)") is read from Claude Code's
  synthetic line, and the launch fails with "Claude's usage limit was reached (…): launch it again
  once it resets", offering **Launch it again**. Added on 2026-10-28, after Shipcast v0.2.0's
  drafting failed that way and only said "ended without a structured answer".
- **Models.** A model chosen in the AI settings is passed as claudio's own value (`default`, `opus`,
  `sonnet`…); without one, claudio's default.

## How the compose file is built, and why

- **Image pinned to `ghcr.io/yeyo11/claudio:0.11.0-headless`** (since 2026-10-29, `0.8.1` before).
  The engine depends on claudio's API; moving the version is a deliberate change. 0.11.0 is the first
  release with what the runner needs: the workspaces API, the `/v1` policy headers and `/api/ready`
  (`/api/v1` itself arrived in 0.10.0). The headless image has no web UI.
- **`CLAUDIO_DAILY_SPEND_CAP_USD`**, 100 by default: the headless profile refuses to start without a
  daily ceiling.
- **Port `127.0.0.1:8798`**, not claudio's usual 8797, so it can run beside the desktop app or a dev
  server. Loopback only. `CLAUDIO_PORT` changes it.
- **`environment:` instead of `env_file: .env`.** Shipcast's `.env` also holds the GitHub and network
  tokens; claudio receives only its auth mode, token and spend cap.
- **`name: shipcast`** fixes the Compose project name, so the volumes are `shipcast_claude-config` and
  `shipcast_claudio-data` whatever folder the command runs from.
- **`./workspace` is shared**, for the legacy path only: the engine clones the repository into
  `workspace/` on the host and claudio reads it under `/workspace`. The folder is gitignored. The
  runner's workspaces make the mount unnecessary.

## Related

[[plans/shipcast.md]] · [[decisions/mvp-scope.md]] · [[decisions/ai-providers.md]] · [[decisions/ai-layer.md]] · [[engine.md]] · [[server.md]] · [[status.md]] · [[decisions/writing-assistant.md]]