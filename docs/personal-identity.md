---
created_at: 2026-10-24T19:19:56.414684498Z
updated_at: 2026-10-24T19:32:59.258990289Z
tags:
    - brands
    - design-system
    - identity
    - decision
---
# The personal brand's visual identity

**The editorial identity**, live on <https://josegarrido.dev> since 2026-10-24 (launches repo,
`9c09046` and `6157092`, merged after the owner tried it running locally). It replaces the
"blackboard", rejected the same day and kept below as history.

The blog is the owner's personal home, where each open-source project is announced the day it
ships. It reads like a small magazine: the projects are its issues. It must never look like Shipcast
(the Cartel system, [plans/design-system.md](plans/design-system.md)) nor like claudio (dark navy,
Geist, blue-to-violet, cyan).

## The editorial magazine

- **Ground:** pure black (`#000`) by default, white in the day theme.
- **Type:** Fraunces for headlines and reading, with the first letter of every headline word in its
  "wonky" italic (`WONK 1`, `SOFT 100`; `src/components/Headline.astro`); Instrument Sans for the
  interface; JetBrains Mono only in code blocks. Self-hosted through Fontsource.
- **One flat colour per project**, on its illustration and behind its article headline, always with
  black text on it: claudio `#2FD7A0`, Shipcast `#FFD43B` (Shipcast's own yellow). Unknown projects
  get one of `#FF6FAE #FF7A2F #7C8CFF #FF5A4A`, picked by a hash of the name (`src/projects.ts`). The
  home page's intro band is `#3B4BF0` with white text.
- **The house illustration** (`src/components/Illo.astro`): a CSS halftone composition — a flat
  colour field, a dot texture, one bold object with a hard black offset shadow. Motifs: phone,
  terminal, label, wave, orb, stack; the project keeps its colour, the motif varies per article.
- **Pages:** the home page is a front page (the newest launch as the lead, two side stories, recent
  launches, more launches, "The workshop" with one card per project, the first-person intro band with
  the author's photo, an empty state); the article carries the illustration, the headline on a slab
  of the project's colour, a byline with the author's photo, reading time and a serif body.
- **The author's photo** (`public/author.jpg`, added on 2026-10-24): round in the byline; in the
  intro band, with the house's black outline and hard offset shadow.
- **Sharing:** each article's `og:image` is its launch image, from the post's optional `image` field,
  which Shipcast writes; the image itself is drawn in this identity by Shipcast
  ([publishing.md](publishing.md#the-launchs-media)).
- **Contrast:** `scripts/contrast.mjs` in the launches repo checks 23 pairs; all pass AA.

Routes and URLs, RSS, the sitemap and `brand.yml` were left unchanged by the redesign.

### Next for it

- **Real covers.** Shipcast should generate one image per launch with a fixed prompt in this style,
  replacing the CSS illustrations. It needs an optional `cover` field in the blog's post schema and in
  Shipcast's drafts. The prompt: "Editorial illustration for a developer blog. One everyday object
  that stands for the project: {object}. Bold flat graphic with thick black outlines and a hard black
  offset shadow, parts in coarse black halftone dots like an old engraving, on a single flat
  background of {project colour}. Off-white and black only besides that colour. Slight playful tilt,
  generous empty space, no text, no logos, no faces, no gradients, no glow. Wide 3:2."
- **One source for the project colours.** They live in the blog's `src/projects.ts` and are copied
  into Shipcast's `packages/assets/src/og.ts`; both could read them from `brand.yml`.

## What stays, whatever the design

Not visual, and kept from the first identity on: the page titles (the home page is the owner's name,
other pages `<page> | José Antonio Garrido`); the first-person intro, built from `brand.yml` facts;
the footer built from `brand.yml`, with `rel="me"` profiles and the support link on its own line; the
analytics beacon only in production; the dark default with a remembered light theme and no flash;
AA contrast in both themes; self-hosted fonts.

## Rejected: the blackboard

Merged and deployed on 2026-10-24 after the owner answered "fine" to screenshots, then rejected once
they saw it live. Lesson: a redesign is merged only after the owner has tried it running, not from
screenshots. Kept so no later design repeats it.

A developer who teaches what they build: a green slate board (`#17211D`, day `#F1F4F0`) with chalk
text (`#ECEAE2`) and one yellow chalk stroke (`#F2D46B`) as the accent; Recursive for headings and
interface, Literata for reading; a lowercase `jg` mark in chalk strokes whose g-tail became a yellow
underline, which drew itself on load. Every text pair passed AA; it was rejected on taste, not on
accessibility.

## Related

[[brands.md]] · [[launches-repo.md]] · [[plans/design-system.md]] · [[decisions/mvp-scope.md]] · [[publishing.md]] · [[status.md]]
