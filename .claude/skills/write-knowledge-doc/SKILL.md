---
name: write-knowledge-doc
description: Write or update a document under docs/ in the format Shipcast's knowledge base expects: front matter, tags, a Related list of wiki links. Use for every feature and every decision.
---

# Writing a document for the knowledge base

CLAUDE.md asks that every feature and every decision becomes a document under `docs/` (plans in `docs/plans/`, decisions in `docs/decisions/`), in the same pull request that builds it. `docs/` is indexed for semantic search, so the format matters.

1. **Search first.** Run `kb_search_documents` (then Grep). Update the document that already covers the ground instead of adding one that disagrees with it.
2. **Format.**
   This is the file pando writes; you send everything below the front matter.
   ```markdown
   ---
   created_at: 2026-09-21T07:35:14Z
   updated_at: 2026-09-23T23:12:12Z
   tags:
       - deploy
       - operations
   ---
   # Title

   ...the document...

   ## Related

   [[desktop.md]] · [[status.md]] · [[plans/mobile.md]]
   ```
   Tags are lowercase and few. Prose links use ordinary markdown links so the document reads on GitHub; the `## Related` list at the end holds the `[[wiki links]]`, and only there.
3. **Write through pando, always.** New or existing, a document is written with `kb_add_document` (`file_path` relative to `docs/`, the whole body without front matter, tags); never with Write or Edit, which a hook blocks. On an existing path the tool keeps `created_at`, refreshes `updated_at` and merges the tags. To change one, read it, edit the body and send it whole.
4. **Say why.** Record what was decided, what was rejected and the reason, with the date, and the file paths it concerns.
5. **Status documents move too.** If the change alters where the project stands, update `docs/status.md` and the plan's Outcome in the same change.
6. **Language.** Documents are English; only the UI copy is translated.
