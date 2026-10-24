---
created_at: 2026-10-24T16:41:34.394215265Z
updated_at: 2026-10-24T21:21:34.901350299Z
tags:
    - content-pack
    - schema
    - claude
---
# The content pack

Everything one launch publishes, as one JSON object that the AI returns: the analysis of the code and
a piece per channel. The schema is `ContentPack` in
[`packages/schema/src/content-pack.ts`](../packages/schema/src/content-pack.ts), written on
2026-10-24. `contentPackJsonSchema()` exports it as JSON Schema (draft 2020-12) to hand to Claude, so
the pack comes back in shape; the field descriptions travel with it and act as part of the prompt.

## Shape

| Field | What it holds |
| --- | --- |
| `schemaVersion` | `1` |
| `kind` | `launch`, `major` or `minor` ([launch-yml.md](launch-yml.md)) |
| `project` | `name`, `repo` URL, optional `version` (the release tag) |
| `analysis` | `summary`, `implemented` (at least one), `planned`, `documentedOnly`, `limitations` |
| `article` | `tags`, and an `en` and/or `es` version, each with its own `slug`, `title`, `description` (≤ 200) and `markdown` |
| `devto` | `tags` (1–4, lowercase letters and digits); dev.to republishes the English article with the blog as canonical URL |
| `bluesky` | `lang`, `text` (≤ 300 graphemes) |
| `mastodon` | `lang`, `text` (≤ 500 characters) |
| `instagram` | `caption` (≤ 2,200 characters, ≤ 30 hashtags, no links), `media`: `og-image` or `demo-video` |
| `reddit` | Drafts: `subreddit` (optional, without `r/`), `title` (≤ 300), `body` |
| `newsletter` | An `en` and/or `es` issue: `subject` (≤ 90), `previewText` (≤ 140), `markdown` ([publishing.md](publishing.md#the-newsletter)) |
| `releaseNotes` | Improved release notes, for the minor pack |

## One slug per language

Decided on 2026-10-24, before the first article was published: **each language version of the
article has its own slug, in its own words** (`claudio-claude-code-as-a-service`,
`claudio-claude-code-como-servicio`), and lives at `<site>/<lang>/<its slug>/`. Google's guidance for
multilingual sites is one URL per language, with the words of the reader's language in it, linked
with `hreflang`, and never two languages on one page; the blog already had the `/en/` and `/es/`
folders and `hreflang`, and only the shared slug went against it. Published URLs never change, so it
had to be settled before claudio's launch.

The blog pairs the two versions by `translationKey`, which Shipcast sets to the English slug (the
Spanish one when there is no English version). `articleUrl(pack, site, lang)` builds a version's URL;
every channel links the URL of its language (the English one for Bluesky, Mastodon and dev.to's
canonical; each language's for its newsletter issue). The blog post in the registry records both
slugs (`en:<slug>,es:<slug>`) so the metrics read each article by its own path. The blog's own pages
follow the same rule: `/en/privacy/` and `/es/privacidad/` ([launches-repo.md](launches-repo.md)).

## The analysis comes first

The plan's first principle — *the code is the source of truth, not the README* — is in the shape:
before any piece, the pack states what the code implements, what is only planned, and what the docs
claim without the code backing it (`documentedOnly`). The schema refuses an analysis with no
implemented feature, and the descriptions tell the model that only the `implemented` list may be
presented as working.

## Valid is not complete

Every piece is optional, so one schema serves every `launch.yml`. Whether a pack has what *this*
launch needs is `missingPieces(pack, config, brand)`, which lists, in plain sentences:

- a channel turned on in `launch.yml` whose piece is missing;
- a channel turned on that has no connector yet (`x: no connector yet; set it to off in launch.yml`);
- an article missing one of the languages of the brand's blog;
- dev.to turned on without the English article it republishes;
- a configured subreddit without its draft;
- the newsletter turned on without a `newsletter` block in `brand.yml`, or without an issue for each
  of its lists.

## Limits come from the networks

The limits in `LIMITS` are the networks' own, checked here so a pack that would be rejected never
reaches review. Bluesky counts graphemes (`Intl.Segmenter`), so `👩‍💻` is one, as a reader sees it.
Instagram captions carry no URL because links there are not clickable, and Instagram posts need
media, which is why the pack names one ([decisions/mvp-scope.md](decisions/mvp-scope.md)).

## Related

[[launch-yml.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[plans/shipcast.md]] · [[plans/stack.md]] · [[publishing.md]]
