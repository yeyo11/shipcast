---
created_at: 2026-11-01T20:37:27.411269979Z
updated_at: 2026-11-01T20:37:27.411269979Z
tags:
    - decision
    - web-app
    - editor
    - writing-assistant
    - channels
    - telegram
    - images
---
# The rich editor, and each channel's formatting

Decided on 2026-11-01, from the brief written from the owner's approved mockups (board "Shipcast ·
rediseño de pantallas", page *Editor de Write*) and the channel compatibility analysis behind them.
The board itself could not be read by the agent that built this, so its look is checked by the owner
on a live preview. The plain textarea of `AssistedEditor` (Write and the drafts) becomes an editor
with a **Markdown** mode, the default, and a **Visual** mode, a toolbar, and images by paste, drag and
a button. Each surface offers only the formatting its channel shows, and the writing assistant keeps
to the same rule.

Built in four phases: the formatting profile, the assistant and Telegram (no change in the page);
the editor on Write; images; the drafts.

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

## The editor

`AssistedEditor` (`apps/web/src/components/assistant/AssistedEditor.tsx`) takes the text's profile
and, for a Markdown or light one, shows the **Markdown | Visual** switch and a toolbar built from the
profile (`toolsFor` in `apps/web/src/components/editor/toolbar.ts`), wrapping to a second row rather
than scrolling; a plain profile has no bar at all, only the note that says so. Markdown is the
default mode, and the choice is not kept yet.

- **The Markdown mode is the textarea it always was.** CodeMirror 6 was the other choice; the
  textarea is lighter (no dependency, no second document model), and it keeps the writing
  assistant's selection and proposal offsets plain string offsets, as `protocol.ts` and `DiffView`
  already read them. A button wraps the selection (`**`, `*`, `~~`, `` ` ``, `<u>`, `||`) or marks
  the lines it touches (`## `, `> `, `- `, `1. `, `- [ ] `), and a second press takes it off.
- **The Visual mode is TipTap 3** (`@tiptap/react`, `@tiptap/starter-kit`, the MIT table, list and
  image extensions and `@tiptap/markdown`; no Pro extension, no TipTap cloud). Its schema is built
  from the profile (`extensionsFor`), so a mark or block the channel does not show does not exist in
  it: a paste or a shortcut cannot make it. Underline and spoilers are two small marks of our own,
  written `<u>…</u>` and `||…||`.
- **The string is the model.** The document is parsed from the Markdown and serialised back only when
  the owner edits in the Visual mode: switching modes without typing never changes the stored text.
  Syntax the profile does not show is taken out with `stripFormat` before parsing, so its words are
  kept rather than dropped by the parser.
- **A paste keeps what the channel shows**: in the Markdown mode the pasted text goes through
  `stripFormat` (a `**bold**` pasted into Bluesky arrives as its words); in the Visual mode the schema
  does the same.
- **Dialogs never submit the page.** The link and image dialogs are portals, but React bubbles their
  submit to Write's own form, which would start "Prepare the pieces": each stops it. The alt field
  under the bar is no form at all, for the same reason (a nested form is invalid HTML).
- **An image is never put in a table cell** in the Visual mode: a Markdown table's cell holds one line,
  so the image goes after the table.
- **Write's status line** says where the text goes as written, from the definitions whose edit
  carries the article: "Blog, dev.to and Hashnode; the other channels are written from it".

### The round trip and its normalisations

`roundTrip` (Markdown → the Visual mode's document → Markdown) is tested over real articles in the
launches repo's style (`apps/web/test/fixtures/articles/`: tables, images, code fences, links with
query strings, both languages) and a synthetic text with every block: they come back byte for byte.
TipTap's serialiser was changed in three places to get there, all in `extensions.ts`:

- **Escaping**: TipTap escapes every `_`, `~` and `*` and writes `&` as `&amp;`, which rewrote
  `x86_64`, `~40%` and `Q&A` on every edit (and a plain network would show the entity as typed).
  `escapeText` escapes a character only where it could read as syntax: `_` not inside a word, `~`
  when another follows, `*` not between spaces, `<` before a tag, `&` before an entity.
- **Tables** are written compact, `| a | b |` and `| --- |`, as the articles write them; TipTap pads
  every column to the widest cell and adds blank lines around the table.
- **The last line break** is kept as the text had it.

What a Visual edit still normalises: `_italics_` is written `*italics*`, list markers become `-` and
`1.`, a table loses its padding, and a heading deeper than the profile shows is brought up to the
deepest it does.

## The assistant in the Visual mode

The assistant keeps working on the Markdown string. A selection made in the Visual mode is
serialised to Markdown and found in the string (the occurrence nearest where it was in the document,
or its plain words when its Markdown is not there; failing both, the whole text), so the request's
`selection` and `range` are what they were. A proposal is shown **formatted**: the word diff of the
two Markdown strings is marked with private-use characters, rendered (raw HTML shown as text, only
safe links), and each text node split into its deleted and inserted runs, struck and marked as
`DiffView` draws them, with "Show as Markdown" falling back to `DiffView` itself. Accept applies the
string and the Visual mode parses it in again. `protocol.ts` gained only the `cleaned` event.

## Images

Only where the profile says `images: true`, and today only on Write (a held launch's drafts would
need their uploads attached to the launch's media; not built).

- **Upload**: the existing upload (`POST /api/v1/media`, the MCP tool `upload_media`, and the page's
  `POST /api/sources/media`), which takes PNG, JPEG, GIF and WebP up to 20 MB by their bytes, removes
  their metadata and stores them in the media store. Its answer now carries `articleName`, the
  image's name in an article's folder: the first 16 characters of its sha256 and its type. The page
  uploads through a route rather than a server function because those parse a multipart body whole
  before any check could refuse it.
- **Linking**: the body links it root-relative, `![what it shows](/articles/<slug>/<articleName>)`,
  as [article-images.md](article-images.md) says; `absoluteLinks` already fixes those for dev.to and
  Hashnode. The page links it under the slug its title has then; when the article is prepared the
  engine (`placeImages`, `packages/engine/src/article-images.ts`) points every link to an uploaded
  name at the article's real folder, so a title changed later costs nothing.
- **Committing**: `POST /articles` (and `write_article`) take `images: [{ sha256, name }]`; the
  engine reads the ones the body links back from the media store and adds them to the drafts as
  `public/articles/<slug>/<name>`, where the launch model keeps them as the article's own media and
  the site's commit carries them with the article.
- **Alt text is required**, at most 140 characters (the blog's `imageAlt`): `imageAltProblem` in
  `packages/schema` refuses "Prepare the pieces" and a draft's save with an image without it,
  naming the image. A pasted or dropped image is uploaded at once and inserted with no alt text; a
  field under the bar asks what it shows (`EditorImageInline`). The bar's Image button opens a
  480 px dialog with the file and its description together (`EditorImageDialog`).
- **Seeing it before the site has it**: the editor shows an uploaded image from `/uploads/<sha256>`,
  served from the media store behind the session, only for a recorded upload. A local preview with
  fake networks and no bucket keeps its uploads in memory, so this can be tried there.

## The drafts

Each draft's editor reads its channel's profile: Bluesky, Mastodon, Threads, LinkedIn and Instagram
have no bar and a paste that strips formatting; Telegram, Discord and the newsletter the reduced bar;
the article, dev.to, Hashnode, Reddit and GitHub Discussions the full one (no image button there).
The character counter stays as it was.

## Out of scope

Embeds (video, gist, posts): decided against for now, a bare link stays a link. A per-user saved
mode. Old Reddit's code indentation. The Threads hashtag rule (Threads takes one topic tag per post;
a separate fix).

## Related

[[decisions/writing-assistant.md]] · [[publishing.md]] · [[web-app.md]] · [[decisions/article-images.md]] · [[content-pack.md]] · [[media-store.md]]
