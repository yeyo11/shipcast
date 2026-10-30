---
created_at: 2026-10-26T21:05:17.808588978Z
updated_at: 2026-10-30T00:52:47.399299093Z
tags:
    - schema
    - content-pack
    - ai
    - decision
    - seo
    - channels
    - youtube
---
# The content pack

Everything one launch publishes, as one JSON object that the AI returns: the analysis of the code and
a piece per channel. The schema is `ContentPack` in
[`packages/schema/src/content-pack.ts`](../packages/schema/src/content-pack.ts), written on
2026-10-24. `contentPackJsonSchema()` exports it as JSON Schema (draft-07: Claude Code's
`--json-schema` refused draft 2020-12 on the first launch) to hand to the AI, so the pack comes back in
shape; the field descriptions travel with it and act as part of the prompt.

## Built from the channel definitions

Since 2026-10-28 the pack is assembled from the channels ([decisions/architecture.md](decisions/architecture.md)):
each channel's definition (`packages/schema/src/channels/<id>.ts`) holds its piece of the pack
(`pack.key` and `pack.piece`, a Zod schema built from a shared kit), its prompt brief and its limits.
`ContentPack` is the fixed fields below plus every definition's piece; `LIMITS` and `PIECE_LIMITS`
are the definitions' limits gathered; `PACK_KEYS` maps a channel to its key. `contentPackFor(definitions)`
builds the schema for another list of definitions, which is how the contract tests show that a new
channel's piece reaches the pack, the prompt and the drafts from its module alone.

The AI tasks that answer with a pack (`pack`, `article`; `packages/schema/src/ai/tasks.ts`) name
`AiContentPack` as their output: the AI task runner validates the answer against it and asks for one
repair before giving up ([decisions/ai-layer.md](decisions/ai-layer.md)). `AiContentPack` is
`ContentPack` with the project as it was before the launch model: `repo` required and no `repos`.
It is also what `contentPackJsonSchema()` hands to Claude, so what the AI is asked for did not change
when `ContentPack` was widened (below), and every pack it accepts is a `ContentPack`.

## Shape

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `launch`, `major` or `minor` ([launch-yml.md](launch-yml.md)) |
| `project` | `name`; `repo`, the primary repo's URL (the one whose release triggered the launch), optional; `repos`, the URLs of further repos the launch is also about, optional; optional `version` (the release tag) |
| `analysis` | `summary`, `implemented` (at least one), `planned`, `documentedOnly`, `limitations` |
| `article` | `tags`, and an `en` and/or `es` version, each with its own `slug`, `title`, `description` (≤ 200), `markdown` and an optional `imageAlt` (≤ 140) |
| `devto` | `tags` (1–4, lowercase letters and digits); dev.to republishes the English article with the blog as canonical URL |
| `hashnode` | `tags` (1–5); Hashnode republishes the English article with the blog as its original URL |
| `bluesky` | `lang`, `text` (≤ 300 graphemes) |
| `mastodon` | `lang`, `text` (≤ 500 characters) |
| `instagram` | `caption` (≤ 5 hashtags, no links), `summary` (≤ 140) for the cover, `slides`: 2–3 features, each a `title` (≤ 40) and a `text` (≤ 140) ([publishing.md](publishing.md#the-launchs-media)) |
| `telegram` | `text` (≤ 900, so it fits a photo caption), ending with the article's link |
| `discord` | `text` (≤ 1,800), ending with the article's link |
| `githubDiscussions` | `title` (≤ 120) and a Markdown `body` (≤ 4,000) for the launched repo's Discussions |
| `threads` | `text` (≤ 500, an emoji counting as its UTF-8 bytes) |
| `linkedin` | `text` (≤ 1,300); the post shares the article as its link card |
| `reddit` | One post per subreddit: `subreddit` (required, without `r/`), `title` (≤ 300), a Markdown `body` that links the article |
| `newsletter` | An `en` and/or `es` issue: `subject` (≤ 90), `previewText` (≤ 140), `markdown` ([publishing.md](publishing.md#the-newsletter)) |
| `youtube` | A `short` (6 to 59 s of scenes) and a `video` (60 to 180 s), each with a `title` (≤ 100), a `description` (the article link and the chapters are added around it, within YouTube's 5,000), up to 15 `tags`, a `lang`, and its `scenes`: at least two, each a `kind` (`card`, `demo`, `screenshot`, `cover`), a `subtitle` (≤ 120, the narration, since there is no voice), `seconds` (2 to 30), an optional card `title` and `text`, and for the horizontal video an optional `chapter` |
| `releaseNotes` | Improved release notes, for the minor pack |

Hashnode, Telegram and Discord were added on 2026-10-25; GitHub Discussions, Threads and LinkedIn on
2026-10-26 ([decisions/new-networks.md](decisions/new-networks.md)); YouTube on 2026-10-28, the first
channel added as a module ([decisions/youtube.md](decisions/youtube.md)). Every piece is published by
Shipcast ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)). A YouTube
script that cannot fit its format is refused by the schema, before anything is rendered; its draft
shows the title, tags, description and the script scene by scene for the owner to read.

## A pack about no repo, or several

Since 2026-10-30, the first phase of the launch model
([decisions/launch-model.md](decisions/launch-model.md)): a launch can be about anything, so
`project.repo` is optional (a product with no repo, a talk, an opinion article) and `project.repos`
lists further repos besides the primary one. A release's pack still names its repo: `generatePack`
refuses a pack whose `project.repo` is missing or is not the launch's repo, and further repos never
stand in for the primary one. The blog front matter gets `repo:` only when the pack has one. Until the
sources phase gives a launch something other than a repo to be about, the AI is still asked for the
old shape (`AiContentPack`, above).

## One slug per language

Decided on 2026-10-24, before the first article was published: **each language version of the
article has its own slug, in its own words** (`claudio-claude-code-as-a-service`,
`claudio-claude-code-como-servicio`), and lives at `<site>/<lang>/<its slug>/`. Google's guidance for
multilingual sites is one URL per language, with the words of the reader's language in it, linked
with `hreflang`, and never two languages on one page.

The blog pairs the two versions by `translationKey`, which Shipcast sets to the English slug (the
Spanish one when there is no English version). `articleUrl(pack, site, lang)` builds a version's URL;
every channel links the URL of its language. Once published, the registry keeps one `article:<lang>`
piece per language with its own URL ([decisions/post-model.md](decisions/post-model.md)), so the
metrics and the index status read each article by its own path.

## Written for search engines and assistants

Added on 2026-10-25 ([plans/goal-after-mvp.md](plans/goal-after-mvp.md), milestone 4), from the
blog's SEO and AI-readiness review ([launches-repo.md](launches-repo.md)):

- **An opening that answers**: the article's first paragraph says in one or two plain sentences what
  the project is and does: the passage a search engine shows and an assistant quotes.
- **Headings as questions** where that reads naturally ("How do I install it?").
- **The launch image's alt text** per language (`imageAlt`), set in the article's front matter, where
  the blog uses it for `og:image:alt` and the image's `alt`; without one, the project's name and the
  title.
- **The project inside the article**: when `launch.yml` names the deployed project
  ([launch-yml.md](launch-yml.md)), its first desktop screenshot goes after the opening paragraph,
  with alt text in the article's language.
- **`updatedDate`** is set when an article is edited after publishing
  ([decisions/edit-delete.md](decisions/edit-delete.md)).

The first three are part of the blog's brief, an editable prompt in the AI settings
([decisions/ai-providers.md](decisions/ai-providers.md)), and of the schema's field descriptions.

## The analysis comes first

The plan's first principle — *the code is the source of truth, not the README* — is in the shape:
before any piece, the pack states what the code implements, what is only planned, and what the docs
claim without the code backing it (`documentedOnly`). The schema refuses an analysis with no
implemented feature, and only the `implemented` list may be presented as working; limitations are
for the owner reviewing the drafts and never go into a piece. For an article written in the app the
analysis is a one-line summary and the article is the source of truth
([engine.md](engine.md#articles-written-in-the-app)).

## Valid is not complete

Every piece is optional, so one schema serves every `launch.yml`. Whether a pack has what *this*
launch needs is `missingPieces(pack, config, brand)`, which lists, in plain sentences:

- a channel turned on in `launch.yml` whose piece is missing (by `PACK_KEYS`, so a new channel is
  covered by its definition);
- an article missing one of the languages of the brand's blog;
- dev.to or Hashnode turned on without the English article they republish, and LinkedIn without the
  article it shares;
- a subreddit listed in `launch.yml` without its post;
- the newsletter turned on without a `newsletter` block in `brand.yml`, or without an issue for each
  of its lists.

## Limits come from the networks

The limits are the networks' own, on each channel's definition, checked here so a pack that would be
rejected never reaches review; each definition also says how its text is counted. Bluesky counts
graphemes (`Intl.Segmenter`), so `👩‍💻` is one, as a reader sees it. Instagram captions carry no URL
because links there are not clickable. Telegram's text is kept under a photo caption's 1,024
characters; Discord's under a message's 2,000; a Reddit title under its 300; a YouTube title under
its 100.

## Related

[[launch-yml.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/architecture.md]] · [[decisions/ai-layer.md]] · [[decisions/youtube.md]] · [[decisions/mvp-scope.md]] · [[decisions/automatic-channels-only.md]] · [[decisions/new-networks.md]] · [[plans/shipcast.md]] · [[plans/stack.md]] · [[publishing.md]] · [[engine.md]] · [[decisions/post-model.md]] · [[decisions/ai-providers.md]] · [[decisions/edit-delete.md]] · [[plans/goal-after-mvp.md]] · [[decisions/launch-model.md]] · [[media-store.md]]
