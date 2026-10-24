---
created_at: 2026-10-24T19:13:49.217534335Z
updated_at: 2026-10-24T21:33:11.156661032Z
tags:
    - engine
    - registry
    - github
    - claudio
    - pipeline
    - cli
    - architecture
---
# The engine

`packages/engine` ([source](../packages/engine/src/)) decides what gets launched, asks the AI for the
content and opens the drafts pull request; `apps/cli` ([source](../apps/cli/src/)) is the `shipcast`
command around it. Written on 2026-10-24, each piece tested with fakes and checked against the real
service where it is safe to. It depends on `@shipcast/schema` ([launch-yml.md](launch-yml.md),
[content-pack.md](content-pack.md), [brands.md](brands.md)).

## The launch registry

`Registry` (`registry.ts`) is a `node:sqlite` database (`data/shipcast.db`, gitignored) with numbered
migrations (`PRAGMA user_version`; append only, never edit one). It is what makes "a launch happens
once" hold:

- **`claim(launch)`** inserts a row unique on `(repo, ref)` and reports whether this call made it. A
  launch is claimed *before* anything is generated, so a second poll, a re-run, a manual launch of
  the same release or a crash halfway through never starts the same campaign twice.
- **Statuses**: `detected`, `generating`, `drafted` (the detail is the pull request), `published`,
  `skipped`, `failed` (the detail says why). Skipped and failed launches keep their row.
- **`lastPublishedRef(repo)`** feeds the pack inference: only `published` launches count.
- **`recordPost`** is unique on `(launch, channel)`: the same piece is never published twice.
- **`recordMetrics`**, **`latestMetrics`** and **`metricHistory`** keep every metric reading
  ([publishing.md](publishing.md#metrics)).
- **`cursor` / `setCursor`** keep polling state; **`recent()`** lists launches for `shipcast status`.

## Detecting launches

`detect({ github, registry, brand })` (`detect.ts`) reads the brand's account's **public events**
(`GET /users/{login}/events/public`):

- **Conditional** requests (ETag): a `304` costs no rate limit. GitHub answers `x-poll-interval: 60`,
  so `shipcast watch` polls at most once a minute. A conditional request can still come back `200`
  when the timeline changed.
- Events newer than the last seen id, oldest first; the cursor advances per event.
- **Triggers**: `ReleaseEvent` with action `published`, and `PublicEvent` (a repo made public).
- `.github/launch.yml` is read **at that tag** (the default branch for a repo made public): no file,
  `enabled: false`, a pre-release, a trigger turned off, or another brand → ignored, no row; an
  invalid file → claimed and recorded `failed` with the line-numbered issues; otherwise **claimed**,
  with the pack from `resolvePack`.

## The AI provider: claudio

`Claudio` (`claudio.ts`) implements `AiProvider.generate()` against claudio's REST API
([claudio.md](claudio.md)): `POST /api/chats` with the prompt, the `cwd` (a path under claudio's
`/workspace`), `jsonSchema`, `allowedTools` and `permissionMode: 'dontAsk'` (tools not allowed are
denied, never asked about); poll until the main agent calls **`StructuredOutput`**, whose `input` is
the answer (verified on 2026-10-24); then **stop the chat**, since claudio keeps a finished chat alive
for a follow-up. Failures, a turn without `StructuredOutput` and the timeout raise `ClaudioError` with
the chat id.

## From a claimed launch to its pull request

`draftLaunch(launch, brand, deps)` (`pipeline.ts`) records each step in the registry:

1. **`launch.yml` at the ref**, validated, and its `brand` checked against the launches repo's.
2. **A fresh shallow clone** of the release (`workspace.ts`): `workspace/<owner>__<repo>@<ref>`, which
   claudio sees as `/workspace/...`; recreated every time so no run leaks into the next.
3. **The content pack** (`generate.ts`, `prompt.ts`): a system prompt with the brand's name and tone
   and the truth rule (only what the code implements is presented as working; no invented commands
   or numbers; a different text per channel), and a prompt with the pack's brief (`launch`, `major`,
   `minor`) and one brief per active channel, with its limits and links
   (`<site>/<lang>/<that language's slug>/?ref=<channel>`; none on Instagram). Tools are read-only
   (`Read`, `Grep`, `Glob`, `ls`, `git log/tag/show`). The answer is accepted only when it validates,
   matches the launch (kind, repo) and `missingPieces` is empty.
4. **The drafts** (`drafts.ts`): each article at `src/content/posts/<lang>/<slug>.md`, one slug per
   language ([content-pack.md](content-pack.md#one-slug-per-language)), with front matter the blog's
   content schema accepts (checked with a real build of the launches repo), a readable draft per
   channel at `launches/<project>/<ref>/<channel>.md` saying its mode (`approval`: merged = published;
   `manual`: the owner posts it), and `pack.json` to publish from after the merge. The launch image and
   the demo Reel go with them ([publishing.md](publishing.md#the-launchs-media)).
5. **The pull request** in the launches repo (`GitHubRest.openPullRequest`): branch
   `launch/<project>-<ref>` off `main`, one commit with every file through the Git data API (binary
   files as base64 blobs), a body with what the code analysis found and the channels' modes. An open
   pull request for the branch is returned instead of a second one; a leftover branch is moved.

`claimManual(repo, ref?)` starts a launch by hand: the given tag or the latest release, refused when
there is no release, no `launch.yml` at it, or `triggers.manual` is off.

`loadBrand` reads `brand.yml` from the launches repo's default branch, so the brand always comes from
where the blog reads it.

## The shipcast command

`pnpm shipcast <command>` from the repo root (`apps/cli`, run by Node's type stripping):

| Command | Does |
| --- | --- |
| `launch <owner/repo> [--ref <tag>]` | Claims and drafts the launch of a release (the latest without `--ref`) |
| `watch [--interval <s>]` | Polls the events (default every 300 s, never under 60), drafts each claimed launch, then publishes and reads the metrics ([publishing.md](publishing.md)) |
| `publish`, `metrics`, `dashboard` | Publishing, metrics and the dashboard, one at a time ([publishing.md](publishing.md)) |
| `status` | The latest launches, their pack and status, and which networks and sources are configured |

Configuration comes from `.env` (`GITHUB_TOKEN_PERSONAL`, `CLAUDIO_API_URL`, `CLAUDIO_API_TOKEN`,
`SHIPCAST_LAUNCHES_REPO`, optional `SHIPCAST_DATA_DIR` and `SHIPCAST_MAX_BUDGET_USD`); every missing
variable is reported at once. The networks' and the analytics' variables are optional: each one
without them is left out ([publishing.md](publishing.md)).

**`launch.yml` is read at the release's tag**, so a project's first launch needs a release made after
its `launch.yml` reached the default branch (or `--ref` to a tag that has it). On 2026-10-24 claudio's
latest release, `v0.8.1`, predates its `launch.yml` (claudio pull requests #60 and #62, the second
turning the newsletter on).

## After the drafts

The launch's media, publishing after the merge, the newsletter, metrics and the dashboard are in
[publishing.md](publishing.md).

## Related

[[launch-yml.md]] · [[content-pack.md]] · [[claudio.md]] · [[brands.md]] · [[launches-repo.md]] · [[plans/stack.md]] · [[decisions/mvp-scope.md]] · [[status.md]] · [[publishing.md]]
