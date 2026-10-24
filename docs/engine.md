---
created_at: 2026-10-24T18:09:20.135462979Z
updated_at: 2026-10-24T18:09:20.135462979Z
tags:
    - engine
    - registry
    - github
    - claudio
    - architecture
---
# The engine

`packages/engine` ([source](../packages/engine/src/)) decides what gets launched and talks to the AI
provider. Written on 2026-10-24, in three pieces, each tested with fakes and checked once against the
real service. It depends on `@shipcast/schema` ([launch-yml.md](launch-yml.md),
[content-pack.md](content-pack.md)).

## The launch registry

`Registry` (`registry.ts`) is a `node:sqlite` database with numbered migrations (`PRAGMA
user_version`; append only, never edit one). It is what makes the plan's "a launch happens once"
hold:

- **`claim(launch)`** inserts a row unique on `(repo, ref)` and reports whether this call made it. A
  release is claimed *before* anything is generated, so a second poll, a re-run or a crash halfway
  through never starts the same campaign twice; the first claim's kind and trigger are the ones that
  count.
- **Statuses**: `detected`, `generating`, `drafted`, `published`, `skipped`, `failed`. A skipped or
  failed launch keeps its row, so it is not picked up again.
- **`lastPublishedRef(repo)`** feeds the pack inference: only `published` launches count, so a
  project whose drafts were never merged still gets the `launch` pack.
- **`recordPost`** is unique on `(launch, channel)`: the same piece is never published twice.
- **`cursor` / `setCursor`** keep small polling state (the events ETag, the last event id).

## Detecting launches

`detect({ github, registry, brand })` (`detect.ts`) reads the brand's GitHub account's **public
events** (`GET /users/{login}/events/public`) instead of walking every repo:

- The request is **conditional**: it sends the last ETag, and a `304` costs no rate limit, so polling
  is free while nothing happens. GitHub answers `x-poll-interval: 60`, so `shipcast watch` polls at
  most once a minute. A conditional request can still come back `200` when the timeline changed.
- Events newer than the last seen id are considered oldest first; the cursor advances per event, so
  a crash resumes where it stopped.
- **Triggers read**: `ReleaseEvent` with action `published` (drafts never appear, and are dropped if
  they did) and `PublicEvent` (a repo made public).
- For each, `.github/launch.yml` is read **at that tag** (the default branch for a repo made public)
  and decides: no file, `enabled: false`, a pre-release, a trigger turned off, or another brand's
  `brand:` → ignored, with no row; an **invalid file** → claimed and recorded `failed` with the
  line-numbered issues, so the owner hears about it once; otherwise **claimed**, with the pack from
  `resolvePack` (a repo made public gets `launch`). A repo made public is keyed `public:<event id>`.

`GitHubRest` (`github.ts`) makes those two reads over `fetch` (events, and a file through the raw
media type). Octokit, in the [stack](plans/stack.md), comes with the drafts pull request, where its
tree and commit helpers pay off; two reads did not need it.

## The AI provider: claudio

`Claudio` (`claudio.ts`) implements `AiProvider.generate({ prompt, cwd, jsonSchema, allowedTools,
… })` against claudio's REST API ([claudio.md](claudio.md)):

1. `POST /api/chats` with the prompt, the working directory (a path under claudio's `/workspace`),
   `jsonSchema`, `allowedTools`, and `permissionMode: 'dontAsk'`, which denies any tool not allowed
   instead of waiting for a person who is not there.
2. Poll `GET /api/chats/:id` until the chat is idle and the main agent (not a subagent) has called
   **`StructuredOutput`**: Claude Code returns the schema's answer as that tool call's `input`, which
   is where claudio exposes it (verified on 2026-10-24).
3. **Stop the chat** (`POST /api/chats/:id/stop`) in every case: claudio keeps a finished chat's
   process alive for a follow-up, and a launch never has one.

A failed or interrupted execution, a turn that ends without `StructuredOutput`, or the timeout (30
minutes by default) raises `ClaudioError` with the chat id, so the conversation can be read in
claudio. The answer comes back unvalidated: the caller checks it against `ContentPack`.

## Next

The pipeline that ties these together: clone the claimed release into `workspace/`, build the prompt
from the brand, the `launch.yml` and the pack's JSON Schema, generate, validate, check
`missingPieces`, and write the drafts pull request in the launches repo; then the CLI
(`shipcast launch`, `shipcast watch`).

## Related

[[launch-yml.md]] · [[content-pack.md]] · [[claudio.md]] · [[brands.md]] · [[plans/stack.md]] · [[decisions/mvp-scope.md]] · [[status.md]]
