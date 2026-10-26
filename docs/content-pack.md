---
created_at: 2026-10-25T19:02:51.559002284Z
updated_at: 2026-10-26T20:51:03.908955017Z
tags:
    - schema
    - content-pack
    - ai
    - decision
    - seo
---
# The content pack

Everything one launch publishes, as one JSON object that the AI returns: the analysis of the code and
a piece per channel. The schema is `ContentPack` in
[`packages/schema/src/content-pack.ts`](../packages/schema/src/content-pack.ts), written on
2026-10-24. `contentPackJsonSchema()` exports it as JSON Schema to hand to Claude, so the pack comes
back in shape; the field descriptions travel with it and act as part of the prompt. It is draft-07:
Claude Code's `--json-schema` refused draft 2020-12 on the first launch.

## Shape

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `launch`, `major` or `minor` ([launch-yml.md](launch-yml.md)) |
| `project` | `name`, `repo` URL, optional `version` (the release tag) |
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
| `releaseNotes` | Improved release notes, for the minor pack |

Hashnode, Telegram and Discord were added on 2026-10-25 (phase 5); GitHub Discussions, Threads and
LinkedIn on 2026-10-26 ([decisions/new-networks.md](decisions/new-networks.md)). Every piece is
published by Shipcast: the Show HN draft and the Product Hunt kit were removed on 2026-10-26, and
Reddit's drafts became posts ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).

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
- **The launch image's alt text** per language (`imageAlt`), written by the AI and set in the
  article's front matter, where the blog uses it for `og:image:alt` and the image's `alt`; without one
  from the AI, the project's name and the title.
- **The project inside the article**: when `launch.yml` names the deployed project
  ([launch-yml.md](launch-yml.md)), its first desktop screenshot (the home page first) goes after the
  opening paragraph, with alt text in the article's language, so the article shows what it talks about.
- **`updatedDate`** is set when an article is edited after publishing
  ([decisions/edit-delete.md](decisions/edit-delete.md)).

The first three are part of the blog's brief, an editable prompt in the AI settings
([decisions/ai-providers.md](decisions/ai-providers.md)), and of the schema's field descriptions,
which travel with the pack's schema.

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

- a channel turned on in `launch.yml` whose piece is missing;
- an article missing one of the languages of the brand's blog;
- dev.to or Hashnode turned on without the English article they republish, and LinkedIn without the
  article it shares;
- a subreddit listed in `launch.yml` without its post;
- the newsletter turned on without a `newsletter` block in `brand.yml`, or without an issue for each
  of its lists.

## Limits come from the networks

The limits in `LIMITS` are the networks' own, checked here so a pack that would be rejected never
reaches review. Bluesky counts graphemes (`Intl.Segmenter`), so `👩‍💻` is one, as a reader sees it.
Instagram captions carry no URL because links there are not clickable. Telegram's text is kept under
a photo caption's 1,024 characters; Discord's under a message's 2,000; a Reddit title under its 300.

## Related

[[launch-yml.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[decisions/automatic-channels-only.md]] · [[decisions/new-networks.md]] · [[plans/shipcast.md]] · [[plans/stack.md]] · [[publishing.md]] · [[engine.md]] · [[decisions/post-model.md]] · [[decisions/ai-providers.md]] · [[decisions/edit-delete.md]] · [[plans/goal-after-mvp.md]]
