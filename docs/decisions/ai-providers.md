---
created_at: 2026-10-25T15:51:20.192968783Z
updated_at: 2026-10-25T15:51:20.192968783Z
tags:
    - decision
    - ai
    - ai-provider
    - claudio
    - prompts
    - phase-8
---
# AI providers on the Vercel AI SDK, and editable prompts

Decided on 2026-10-25, as the first piece of milestone 4 ([plans/goal-after-mvp.md](../plans/goal-after-mvp.md),
phase 8 of [plans/after-mvp.md](../plans/after-mvp.md)).

## What was decided

**One interface, several providers.** `AiProvider` ([`packages/engine/src/ai.ts`](../../packages/engine/src/ai.ts))
has two methods, used everywhere:

- `generateObject(request)`: a prompt answered with JSON of a schema. The content pack and an
  article's distribution use it; the pack's JSON Schema (`contentPackJsonSchema()`) is the contract
  whatever the provider, and the answer is still validated by the pack's Zod schema and
  `missingPieces` before anything is drafted.
- `streamText(request)`: streamed text, for the writing assistant (exposed now, used by the assistant
  later). A failed stream throws; the AI SDK would otherwise end it empty.

Three providers:

| Provider | How | Credentials |
| --- | --- | --- |
| `claudio` | claudio's REST API for `generateObject`; `@ai-sdk/openai-compatible` against claudio's `/api/v1` for `streamText` | `SHIPCAST_CLAUDIO_URL` and `SHIPCAST_CLAUDIO_TOKEN` in `.env`, for now |
| `anthropic` | `@ai-sdk/anthropic`; default model `claude-opus-5-5` | an **Anthropic API** account on the Channels page (keychain) |
| `openaiCompatible` | `@ai-sdk/openai-compatible`, with `response_format` JSON Schema (`supportsStructuredOutputs`) | an **OpenAI-compatible server** account: base URL, model, optional key |

The AI SDK is `ai` 7, `@ai-sdk/anthropic` 4, `@ai-sdk/openai-compatible` 3. `generateObject` from the
SDK is deprecated in v7, so `SdkProvider` calls `generateText` with `output: Output.object({ schema:
jsonSchema(...) })`.

### What stays on claudio's REST API, and why

The content pack is written by an agent that **reads the released code**: claudio starts a chat in the
clone under its `/workspace`, with read-only Claude Code tools (`ANALYSIS_TOOLS`) and `jsonSchema`, and
the answer is the input of Claude Code's `StructuredOutput` tool. claudio's OpenAI-compatible surface
cannot do that today: on 2026-10-25 it is designed but **not built** (claudio's
`docs/plans/openai-compatible-api.md`; the running instance answers 404 on `/api/v1/chat/completions`),
and even when built it selects the workspace through `X-Claudio-Cwd` headers and returns client tool
calls instead of running Claude Code's own tools for a schema-bound answer. So **`generateObject` on
claudio stays on `POST /api/chats`**, for the pack and the article alike. Only `streamText`, which needs
no workspace, goes through `/api/v1`; it works once claudio ships that surface.

### SDK providers read the repo through read-only tools

The Anthropic API and an OpenAI-compatible model have no agent of their own. When a task has a repo,
`SdkProvider` gives the model four tools over the checkout on this machine (`repoTools`): `list_files`,
`read_file`, `search` and `git_log`. They never write or run code, and every path is resolved through
symlinks and refused when it leaves the checkout. A run is capped at 40 steps.

## AI settings

Stored in the registry's `settings` table, so no migration ([`packages/engine/src/ai-settings.ts`](../../packages/engine/src/ai-settings.ts)):

- **`ai`**: per task (`pack`, `article`, `assistant`) a provider and an optional model; and the brand's
  **tone override**, which replaces `brand.yml`'s tone in every prompt. Until set, claudio does every task.
- **`prompts`**: the versions of each edited prompt, oldest first, the last in use. The first save
  records the default as the first version, so it is always in the list; restoring a version (or the
  default) appends it as a new version, so the history only grows (50 kept per prompt).

The runtime reads both before every AI call (`aiSetup` in [`packages/runtime/src/ai.ts`](../../packages/runtime/src/ai.ts),
passed to the pipeline as `PipelineDeps.aiSetup`), so an edit applies to the next draft. A task whose
provider has no connected account fails with what to do, never silently on another provider.

### Editable and locked

| Editable (defaults in code, `DEFAULT_PROMPTS` in [`prompt.ts`](../../packages/engine/src/prompt.ts)) | Locked |
| --- | --- |
| Each channel's brief (`channel.<channel>`) | The rules that keep a launch's text true to the code (`LOCKED_LAUNCH_RULES`) |
| Each kind of pack's brief (`pack.launch`, `pack.major`, `pack.minor`) | The article rules: the article is the truth (`LOCKED_ARTICLE_RULES`) |
| The article's translation instruction (`article`) | The content pack's JSON Schema, and the lines binding the answer to it |

Editable prompts are templates: `{{site}}`, `{{blogLanguages}}`, `{{limit.blueskyGraphemes}}` and the
rest of `PROMPT_VARIABLES`; a save with an unknown variable or empty text is refused. Locked parts have
no id in the store (`rules.*`, `schema`, `system` are refused), a stored key the code does not know is
never read back, and the locked rules are always the **last lines of the system prompt**, after the
voice and tone, whatever an edited brief says. The settings page shows them read-only.

**Preview** renders the final system prompt and prompt a past launch would get with the saved prompts
and tone, without calling an AI: a release reads its `launch.yml` at the ref; an article, the
`launch.yml` its drafts committed, with a stand-in for the owner's text.

## AI cost is never shown

The CLI's "AI cost" line is gone, and `DraftResult` no longer carries a cost. A provider may still
report `costUsd` in its result for the records; nothing in the UI or the CLI prints it.

## Rejected

- **Pack generation through claudio's OpenAI-compatible API.** Not built, and it would not give
  Claude Code the workspace with a schema-bound answer (above).
- **Giving the SDK providers a shell.** Read-only tools over the checkout are what the analysis needs;
  Bash would be code execution on the owner's machine.
- **AI keys in `.env`.** They are connected accounts in the keychain, like every network's. claudio's
  URL and token stay in `.env` until the configuration split.
- **A migration for the settings.** The `settings` table already holds what the owner chooses.

## Risks

- The Anthropic and OpenAI-compatible paths are tested with the AI SDK's `MockLanguageModelV4` only;
  no Anthropic key was configured on 2026-10-25, so they have not run live. Anthropic's structured
  outputs accept a subset of JSON Schema: the pack's schema may need adjusting the first time it runs there.
- A local model's quality with tools and a large schema varies a lot.

## Related

[[claudio.md]] · [[engine.md]] · [[web-app.md]] · [[content-pack.md]] · [[accounts.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[decisions/app-design-direction.md]]
