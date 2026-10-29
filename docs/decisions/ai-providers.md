---
created_at: 2026-10-25T16:02:37.786397876Z
updated_at: 2026-10-29T00:58:52.906982893Z
tags:
    - decision
    - ai
    - ai-provider
    - claudio
    - prompts
    - phase-8
    - superseded
---
# AI providers on the Vercel AI SDK, and editable prompts

Decided on 2026-10-25, as the first piece of milestone 4 ([plans/goal-after-mvp.md](../plans/goal-after-mvp.md),
phase 8 of [plans/after-mvp.md](../plans/after-mvp.md)).

## Status (2026-10-29)

**The provider layer below is superseded by [ai-layer.md](ai-layer.md)** (2026-10-28/29), built behind
the flag `ai-runner`. With the flag off, which is what production runs today, this document still
describes what runs; it is kept as the history of the first layer. With the flag on:

| Here (first layer) | Superseded by ([ai-layer.md](ai-layer.md)) |
| --- | --- |
| `AiProvider` with `generateObject` and `streamText`, one implementation per provider | `AiTaskRunner` (`packages/engine/src/ai/runner.ts`) runs every task on the AI SDK; a provider is only a model, defined by one module in `packages/engine/src/ai/providers/` and listed in its registry |
| claudio's `generateObject` on `POST /api/chats` in a clone under its `/workspace` | claudio as an AI SDK provider over its `/api/v1`, with ephemeral workspaces it downloads itself from a `codeload` URL ([claudio.md](../claudio.md)) |
| Four repo tools (`list_files`, `read_file`, `search`, `git_log`), 40 steps | Five (`repo_overview`, `read_files`, `search`, `list_files`, `git`) and a strict `submit_answer` tool; each task's limits in its definition (`packages/schema/src/ai/tasks.ts`) |
| Limits scattered per call site | One definition per task: output schema, whether it reads the repo, steps, output tokens, time, turns, budget |

The old layer is reachable only through `@shipcast/engine/legacy-ai`, kept there by a dependency
rule, and is deleted once the runner is verified in production. What stays valid either way: the AI
settings and the editable/locked prompts (below), and "AI cost is never shown".

Since this decision the AI settings gained two tasks, `replies` (the comment assistant) and `profile`
(account reviews): `pack`, `article`, `assistant`, `replies`, `profile`, each falling back on claudio.
The runner also has an `openai` provider (the OpenAI API's own SDK), not listed in the settings and
chosen only by Action mode.

## What was decided

**One interface, several providers.** `AiProvider` ([`packages/engine/src/ai.ts`](../../packages/engine/src/ai.ts))
has two methods, used everywhere:

- `generateObject(request)`: a prompt answered with JSON of a schema. The content pack and an
  article's distribution use it; the pack's JSON Schema (`contentPackJsonSchema()`) is the contract
  whatever the provider, and the answer is still validated by the pack's Zod schema and
  `missingPieces` before anything is drafted.
- `streamText(request)`: streamed text, for the writing assistant. A failed stream throws; the AI SDK
  would otherwise end it empty.

Three providers:

| Provider | How | Credentials |
| --- | --- | --- |
| `claudio` | claudio's REST API for `generateObject`; `@ai-sdk/openai-compatible` against claudio's `/api/v1` for `streamText` | claudio's URL and token in Settings (`.env`'s `SHIPCAST_CLAUDIO_URL` and `SHIPCAST_CLAUDIO_TOKEN` as a fallback) |
| `anthropic` | `@ai-sdk/anthropic`; default model `claude-opus-5-5` | an **Anthropic API** account on the Channels page (secret store) |
| `openaiCompatible` | `@ai-sdk/openai-compatible`, with `response_format` JSON Schema (`supportsStructuredOutputs`) | an **OpenAI-compatible server** account: base URL, model, optional key |

The AI SDK is `ai` 7, `@ai-sdk/anthropic` 4, `@ai-sdk/openai-compatible` 3. `generateObject` from the
SDK is deprecated in v7, so `SdkProvider` calls `generateText` with `output: Output.object({ schema:
jsonSchema(...) })`.

### What stays on claudio's REST API, and why (superseded)

The content pack is written by an agent that **reads the released code**: claudio starts a chat in the
clone under its `/workspace`, with read-only Claude Code tools (`ANALYSIS_TOOLS`) and `jsonSchema`, and
the answer is the input of Claude Code's `StructuredOutput` tool. On 2026-10-25 claudio's
OpenAI-compatible surface was designed but **not built**, and it selected the workspace through a
`cwd` header claudio had to see on its own disk. So **`generateObject` on claudio stayed on
`POST /api/chats`**. claudio shipped `/api/v1` in 0.10.0 (2026-10-27); [ai-layer.md](ai-layer.md)
moves every task onto it, with workspaces claudio downloads itself, because the shared-disk `cwd`
failed silently where Shipcast and claudio did not share a volume.

### SDK providers read the repo through read-only tools

The Anthropic API and an OpenAI-compatible model have no agent of their own. When a task has a repo,
`SdkProvider` gives the model four tools over the checkout on this machine (`repoTools`): `list_files`,
`read_file`, `search` and `git_log`. They never write or run code, and every path is resolved through
symlinks and refused when it leaves the checkout. A run is capped at 40 steps. (On the runner: five
tools, see the Status above.)

## AI settings

Stored in the registry's `settings` table, so no migration ([`packages/engine/src/ai-settings.ts`](../../packages/engine/src/ai-settings.ts)):

- **`ai`**: per task a provider and an optional model; and the brand's **tone override**, which
  replaces `brand.yml`'s tone in every prompt. Until set, claudio does every task.
- **`prompts`**: the versions of each edited prompt, oldest first, the last in use. The first save
  records the default as the first version, so it is always in the list; restoring a version (or the
  default) appends it as a new version, so the history only grows (50 kept per prompt).

The runtime reads both before every AI call (`aiSetup`, or `aiRunSetup` for the runner, in
[`packages/runtime/src/ai.ts`](../../packages/runtime/src/ai.ts)), so an edit applies to the next
draft. A task whose provider has no connected account fails with what to do, never silently on
another provider.

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
report its cost for the records; nothing in the UI or the CLI prints it.

## Rejected

- **Pack generation through claudio's OpenAI-compatible API** (on 2026-10-25: not built, and no way
  to hand Claude Code the workspace). Taken up once claudio offered both, in [ai-layer.md](ai-layer.md).
- **Giving the SDK providers a shell.** Read-only tools over the checkout are what the analysis needs;
  Bash would be code execution on the owner's machine. Still the rule on the runner.
- **AI keys in `.env`.** They are connected accounts in the secret store, like every network's.
- **A migration for the settings.** The `settings` table already holds what the owner chooses.

## Risks (2026-10-25)

- The Anthropic and OpenAI-compatible paths were tested with the AI SDK's mock models only; no
  Anthropic key was configured on 2026-10-25. Anthropic's structured outputs accept a subset of JSON
  Schema: the pack's schema may need adjusting the first time it runs there.
- A local model's quality with tools and a large schema varies a lot.

## Related

[[decisions/ai-layer.md]] · [[claudio.md]] · [[engine.md]] · [[web-app.md]] · [[content-pack.md]] · [[accounts.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[decisions/app-design-direction.md]]