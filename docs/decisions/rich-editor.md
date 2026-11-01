---
created_at: 2026-11-01T18:34:11.834167255Z
updated_at: 2026-11-01T18:34:11.834167255Z
tags:
    - decision
    - web-app
    - editor
    - writing-assistant
    - channels
    - telegram
---
# The rich editor, and each channel's formatting

Decided on 2026-11-01, from the owner's approved mockups (board "Shipcast · rediseño de pantallas",
page *Editor de Write*) and the channel compatibility analysis behind them. The plain textarea of
`AssistedEditor` (Write and the drafts) becomes an editor with a **Markdown** mode, the default, and a
**Visual** mode, a toolbar, and images by paste, drag and a button. Each surface offers only the
formatting its channel shows, and the writing assistant keeps to the same rule.

Built in four phases, each pushed on its own: the formatting profile, the assistant and Telegram (no
change in the page); the editor on Write; images; the drafts.

## Markdown stays the stored format

Nothing in the database, the drafts, the publishers or the content pack changes shape: the editor
reads and writes the same Markdown string the textarea did. Swapping the editor back would be one
component, not a data migration. The article reaches the blog, dev.to and Hashnode as written; every
other channel gets a piece the AI writes from it, edited in its draft with the same component.

## One profile per channel

Each channel's definition in `packages/schema/src/channels/<id>.ts` carries an `editor` profile, pure
data (`packages/schema/src/channels/format.ts`):

- `format`: `markdown` (the network renders Markdown), `light` (a handful of marks and blocks) or
  `plain` (none: every `*`, `#` or `[` shows as typed);
- `marks`: bold, italic, underline, strike, code, link, spoiler;
- `blocks`: heading (down to `maxHeading`), quote, bulletList, orderedList, taskList, codeBlock, table;
- `images`: whether an image goes in the text itself;
- `note`: what it shows, in words the page puts beside the editor.

`registry.ts` derives `EDITOR_PROFILES` from the definitions, as it derives `PIECE_LIMITS`, and
`editorProfile(channel)` answers a text of no channel (the article on Write) with the blog's. No
web, engine or assistant code asks which channel it is: they all read the profile.

| Channel | Profile |
| --- | --- |
| Blog, dev.to, Hashnode, GitHub Discussions | Markdown: bold, italics, strikethrough, code, links; headings, quotes, lists, task lists, code blocks, tables; images |
| Reddit | Markdown as above, without task lists and without images (a self post through the API takes none) |
| Discord | Light: bold, italics, strikethrough, code, links, spoilers; headings down to the third, quotes, lists, code blocks; no tables, no images |
| Telegram | Light: bold, italics, underline, strikethrough, spoilers, code, links; quotes |
| Newsletter | Light: bold, italics, links; lists (what the issue's HTML styles) |
| Bluesky, Mastodon, Threads, LinkedIn, Instagram | Plain text |
| YouTube | None: its scenes are not edited as a text |

Two syntaxes Markdown lacks are written as the networks that show them expect: underline as
`<u>…</u>`, a spoiler as `||…||` (Discord's and Telegram's own).

## The checks that read it

- **`checkFormat(text, profile)`** finds the syntax a profile does not show, each kind once, with a
  sample. It never looks into code spans or fences, never reads a bare URL's underscores as italics,
  nor `snake_case` or `5 * 3 * 2`. **Lists are never refused**: "- one" reads the same as typed on any
  network, so lists are only a toolbar's choice.
- **`stripFormat(text, profile)`** takes that syntax out and keeps the words: emphasis keeps its text,
  a heading its title (or is brought up to the deepest the profile shows), a quote its line, a link
  becomes "text (url)", a table rows of cells joined by " · ", an image its alt text, a fence its code.
  It answers what it removed.
- **Saving a draft**: `LaunchService.editDraft` refuses a draft with syntax its network does not show,
  as it refuses one over the cap, naming the network and the syntax: "Bluesky does not show bold
  (\*\*out\*\*): write it as plain text". The text checked is the post as the channel reads its draft
  (`draft.read`), so a discussion's title line or an issue's subject is not part of it.

## The writing assistant follows the profile

Every action used to say "Keep the Markdown", and the only per-channel rule was the character cap.
Now the system prompt carries an instruction built from the piece's profile (`formatInstruction`):
"plain text only, no Markdown at all…" for a plain network, "only this Markdown: …" and what never to
use for a light one, the list of what shows for a Markdown one. **Adapt to a network** is told the
target's profile, not the source's. Translate keeps "the formatting" rather than "the Markdown". The
locked truth rules are untouched; the common locked rule now keeps the author's voice and every link,
and leaves the formatting to the profile.

A proposal that slips anyway is cleaned **before the owner can accept it**: when the answer ends, the
endpoint runs `stripFormat` over it (a quick action's whole answer, a chat answer's `proposal` blocks
in place, never the prose around them, never the titles) and sends a `cleaned` event with the cleaned
text and a notice ("Took out bold: Bluesky does not show it"), shown beside the diff
(`EditorAssistPlain`). The saved chat keeps the cleaned answer.

The AI evaluation has a case for it: `claudio-v0.9.0-improve-bluesky` in `scripts/ai-eval.cases.json`
asks Improve on a Bluesky post and records any syntax Bluesky would not show as a problem.

## Telegram is sent formatted

Telegram's connector could take a `parseMode`, but nothing set it, so a draft's `**bold**` went out
with its asterisks. Its adapter (`packages/runtime/src/channels/telegram.ts`) now tags the draft's
links, then renders its light Markdown as Telegram's HTML (`telegramHtml` in `packages/schema`) and
sends it with `parse_mode: 'HTML'`, on publish and on edit. The rendering happens in the adapter, not
in `publish.ts`, because the links must be tagged on the Markdown first and the adapter is where the
tags are added. Telegram counts a post on what a reader sees, so the piece's length is the visible
text of that HTML: a link's label, not its address or the asterisks. See [publishing.md](../publishing.md).

## Out of scope

Embeds (video, gist, posts): decided against for now, a bare link stays a link. A per-user saved
mode. Old Reddit's code indentation. The Threads hashtag rule (Threads takes one topic tag per post;
a separate fix).

## Related

[[decisions/writing-assistant.md]] · [[publishing.md]] · [[web-app.md]] · [[decisions/article-images.md]] · [[content-pack.md]] · [[media-store.md]]
