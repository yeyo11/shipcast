---
created_at: 2026-10-25T00:01:50.934646193Z
updated_at: 2026-10-25T01:38:56.388809955Z
tags:
    - schema
    - content-pack
    - ai
    - decision
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
| `article` | `tags`, and an `en` and/or `es` version, each with its own `slug`, `title`, `description` (≤ 200) and `markdown` |
| `devto` | `tags` (1–4, lowercase letters and digits); dev.to republishes the English article with the blog as canonical URL |
| `hashnode` | `tags` (1–5); Hashnode republishes the English article with the blog as its original URL |
| `bluesky` | `lang`, `text` (≤ 300 graphemes) |
| `mastodon` | `lang`, `text` (≤ 500 characters) |
| `instagram` | `caption` (≤ 5 hashtags, no links), `summary` (≤ 140) for the cover, `slides`: 2–3 features, each a `title` (≤ 40) and a `text` (≤ 140) ([publishing.md](publishing.md#the-launchs-media)) |
| `telegram` | `text` (≤ 900, so it fits a photo caption), ending with the article's link |
| `discord` | `text` (≤ 1,800), ending with the article's link |
| `hackerNews` | Show HN draft: `title` (starts with `Show HN: `, ≤ 80) and the author's `firstComment` (≤ 2,000); the URL submitted is the repo |
| `productHunt` | Launch kit: `tagline` (≤ 60), `description` (≤ 260), the maker's `firstComment` (≤ 1,000) |
| `reddit` | Drafts: `subreddit` (optional, without `r/`), `title` (≤ 300), `body`; Reddit is off by default since 2026-10-25 |
| `newsletter` | An `en` and/or `es` issue: `subject` (≤ 90), `previewText` (≤ 140), `markdown` ([publishing.md](publishing.md#the-newsletter)) |
| `releaseNotes` | Improved release notes, for the minor pack |

Hashnode, Telegram, Discord, Show HN and Product Hunt were added on 2026-10-25 (phase 5). Hacker News,
Product Hunt and Reddit are drafts only: Shipcast never posts them.

## One slug per language

Decided on 2026-10-24, before the first article was published: **each language version of the
article has its own slug, in its own words** (`claudio-claude-code-as-a-service`,
`claudio-claude-code-como-servicio`), and lives at `<site>/<lang>/<its slug>/`. Google's guidance for
multilingual sites is one URL per language, with the words of the reader's language in it, linked
with `hreflang`, and never two languages on one page.

The blog pairs the two versions by `translationKey`, which Shipcast sets to the English slug (the
Spanish one when there is no English version). `articleUrl(pack, site, lang)` builds a version's URL;
every channel links the URL of its language. The blog post in the registry records both slugs
(`en:<slug>,es:<slug>`) so the metrics read each article by its own path.

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
- a channel turned on that has no connector yet (`x: no connector yet; set it to off in launch.yml`);
- an article missing one of the languages of the brand's blog;
- dev.to or Hashnode turned on without the English article they republish;
- a configured subreddit without its draft;
- the newsletter turned on without a `newsletter` block in `brand.yml`, or without an issue for each
  of its lists.

## Limits come from the networks

The limits in `LIMITS` are the networks' own, checked here so a pack that would be rejected never
reaches review. Bluesky counts graphemes (`Intl.Segmenter`), so `👩‍💻` is one, as a reader sees it.
Instagram captions carry no URL because links there are not clickable. Telegram's text is kept under
a photo caption's 1,024 characters; Discord's under a message's 2,000; Show HN's title under Hacker
News's 80.

## Related

[[launch-yml.md]] · [[brands.md]] · [[launches-repo.md]] · [[decisions/mvp-scope.md]] · [[plans/shipcast.md]] · [[plans/stack.md]] · [[publishing.md]] · [[engine.md]]
