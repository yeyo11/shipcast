---
created_at: 2026-10-29T00:07:08.379927468Z
updated_at: 2026-10-29T01:56:29.880217091Z
tags:
    - decision
    - ai
    - claudio
    - ai-sdk
    - providers
    - refactor
    - security
---
# The AI layer: one runner on the Vercel AI SDK, one module per provider, Claudio as a remote agent

Decided with the owner on 2026-10-28 and 2026-10-29, built behind the flag `ai-runner`. It replaces
the first AI layer of [ai-providers.md](ai-providers.md) once verified in production.

## Why

An audit of 2026-10-28 found Shipcast's AI layer was not agnostic and had a silent failure on the
server:
- every structured task went through Claudio's own REST API (a chat started, then polled every 3 s
  for up to 30 minutes), outside the AI SDK; only the writing assistant used the SDK;
- Claude Code explored the release in a `cwd` Claudio had to see on its own disk; on apps-1 Shipcast's
  clones and Claudio's `/workspace` were different volumes, and Claudio created a missing `cwd`
  instead of refusing it, so a content pack would have been written without reading any code;
- no timeouts or retries, errors outside `ShipcastError`, two ways to build Claudio, and its `/api/v1`
  calls counted as Mastodon by the measurement;
- Claude Code's prefix permission rules let compound read-only commands run beyond the declared ones
  (`ls && cat …`, `git ls-files | grep …`, `sed -n …`), seen in the transcripts of past packs.

## The design

- **One runner** (`AiTaskRunner`, packages/engine/src/ai/runner.ts) runs every task on the AI SDK:
  always streamed (long turns would hit Node's 300 s headers timeout), no SDK retries (the job queue
  retries a retryable `AiError`), the task's timeout with the caller's abort, Zod validation with one
  repair, usage and the provider's metadata returned, timed in the measurement.
- **One module per provider** (packages/engine/src/ai/providers/), listed in a registry: settings
  fields, capabilities, how to build its `LanguageModel`, and how it reaches a repository:
  - `local-tools` (the Anthropic API, OpenAI, OpenAI-compatible servers): Shipcast's own read-only
    tools over the job's clone — `repo_overview`, `read_files` (many files and ranges per call),
    `search` (ripgrep or a JS fallback, with context), `list_files`, `git` — confined to the clone,
    no shell; the answer arrives through a strict `submit_answer` tool. The call is never forced:
    current Claude models refuse a forced `tool_choice`, so the model is told to submit and `auto` is
    used. Prompt caching where the provider supports it;
  - `remote-workspace` (Claudio): Claude Code explores with its own tools in a workspace Claudio
    downloads itself.
- **One definition per task** (packages/schema/src/ai/tasks.ts): its output schema, whether it reads
  the repo, and its limits (steps, output tokens, time, turns, budget).
- **A spend limit per task** (2026-10-29): the defaults sit beside the definitions, in one place
  (`DEFAULT_AI_BUDGETS_USD`: pack 5, article 3, assistant-check 2, assistant 1, replies 1, profile
  0.5 USD), and the owner may override any of them by task id in the AI settings (`budgets`, above
  0 and at most 50 USD). The owner's limit for the task wins over the single global AI budget
  (`SHIPCAST_MAX_BUDGET_USD`, the `ai-budget-usd` setting, which the pack, the article and the check
  against the code pass), which wins over the default. Only Claudio is given it, as `maxBudgetUsd`;
  the Anthropic API, OpenAI and OpenAI-compatible servers bill per token and take no spend ceiling
  on a call, so they get nothing and are bounded by the steps, output tokens and timeout Shipcast
  enforces. The settings show it as a limit; no spent amount is shown.
- Adding a provider is one module and one registry line.

## Claudio, kept as a first-class provider

Shown as "Claude Code — your subscription (via Claudio)", built as an **AI SDK provider** over
Claudio's OpenAI-compatible `/api/v1`. Its own features are asked the SDK's way, through
`providerOptions.claudio` (workspace, allowed tools, max turns, max budget), and sent as Claudio's
headers. Agreed with Claudio's team for its first headless release, with no interim path:
- **Ephemeral workspaces**: Shipcast resolves GitHub's tarball redirect for the release tag with its
  own token and gives Claudio only the short-lived `codeload` URL; Claudio downloads and extracts it
  (`POST /api/workspaces`), names it by id, and Shipcast deletes it after the run. No shared
  filesystem; a GitHub token never reaches Claudio.
- **A strict guard**: only the declared rules run (Read, Grep, Glob and read-only forms of `ls`,
  `find`, `cat`, `head`, `tail`, `sed -n`, `grep`, `wc`, `cut`); reads stay inside the workspace.
- **Typed refusals** (`max_turns`, `max_budget`, `tool_blocked`, `no_structured_output`, workspace
  errors) map to `AiError`; usage limits stay a retryable 429 with `Retry-After`; the turn's cost comes
  in `usage.cost_usd`.
- **Readiness** (`/api/ready`) tells "Claude is not signed in" before a launch fails.

## What moved with it

- The assistant's check against the code runs as a `heavy` job, no longer inside a web request.
- The GitHub Action mode drafts on the same runner, configured from the environment alone.
- The old layer is reachable only through `@shipcast/engine/legacy-ai`, guarded by a dependency rule,
  and is deleted once the runner is verified in production.

## Related

[[decisions/ai-providers.md]] · [[decisions/architecture.md]] · [[claudio.md]] · [[decisions/youtube.md]] · [[plans/performance-refactor.md]]
