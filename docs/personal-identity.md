---
created_at: 2026-10-24T17:09:15.117121151Z
updated_at: 2026-10-24T17:09:15.117121151Z
tags:
    - brands
    - design-system
    - identity
    - decision
---
# The personal brand's visual identity

Approved by the owner on 2026-10-24 and live on <https://josegarrido.dev> the same day. Until then
the site wore Shipcast's tokens ([plans/design-system.md](plans/design-system.md)); once the blog
became the owner's personal home, at the root of their own domain, it needed an identity of its own,
distinct from Shipcast (navy, orange, coral, cyan, Saira) and from claudio (navy, Geist,
blue-to-violet, cyan). It was proposed on a branch by an agent and merged only after the owner
validated it, as every design decision is.

## The idea: the blackboard

A developer who teaches what they build. A green slate board carries chalk-white text and one yellow
chalk stroke as the accent. No navy, blue, violet, cyan or orange, and no gradients. Dark by default,
the owner's preference; the day theme is a paper page, not cream.

## Tokens

| Token | Night (default) | Day | Role |
| --- | --- | --- | --- |
| `board` | `#17211D` | `#F1F4F0` | Background |
| `tray` | `#1F2C26` | `#E2E8E2` | Code blocks, inline code |
| `rule` | `#5E7268` | `#7C8B82` | Lines that carry meaning (3:1) |
| `chalk` | `#ECEAE2` | `#17211D` | Text |
| `dust` | `#A7B2AB` | `#4C5A53` | Secondary text |
| `accent` | `#F2D46B` | `#7A5C00` | Links in text, focus, selection |
| `stroke` | `#F2D46B` | `#E9B824` | The underline and the mark's tail; decoration only, never text |

Contrast, measured: chalk on board 13.71 (night) / 14.89 (day); dust on board 7.55 / 6.54; accent on
board 11.33 / 5.64; accent on tray 9.96 / 5.02; rule on board 3.21 / 3.23. Every text pair passes AA
in both themes. The tokens live in `src/styles/global.css` of the launches repo.

## Type

- **Recursive**, one family for three jobs: headings on its casual (handwritten) axis, interface
  text (dates, navigation, meta) on its linear axis, code on its mono cut. Loaded as two named faces
  (sans with the casual axis, and mono), about 180 kB instead of the 305 kB file with every axis.
- **Literata**, with optical sizes, for reading: articles and the intro.
- Scale 14 · 18 · 21 · 24 · 36 · 48 · 60 px from an 18 px body, line height 1.65, a column of about
  66 characters, sentence case. Monospace only for code and versions, never for labels or dates.

## Mark and layout

- **Mark:** a lowercase `jg` drawn in round chalk strokes, the g's tail running on as the yellow
  underline; it reads at 16 px. `src/components/Mark.astro` (follows the theme), `public/favicon.svg`,
  and `public/avatar.svg` (400 × 400, safe inside a circular crop) for profile pictures — to be
  uploaded to the networks only when the owner decides.
- **Home:** the owner's name in large casual Recursive with a hand-drawn yellow underline, a two-line
  intro in first person (written from `brand.yml` and approved by the owner), the GitHub handle, then
  the launches with their dates hanging in the left margin on wide screens. The page title is the
  owner's name; other pages are titled `<page> | José Antonio Garrido`.
- **One motion moment:** the underline drawing itself on load, skipped under reduced motion.
- **Header** with the mark and the name (only the mark on phones; screen readers still get the name),
  a quiet navigation, and a footer in three lines built from `brand.yml`.

Rejected while designing: a terminal-style hero (the standard developer-site trope), monospace labels,
all-caps labels, cards, arrows on links, and yellow navigation links (yellow stays special).

## Refining it

Still open: the OG image template for launch articles (1200 × 630), which the MVP needs for
Instagram, and a refined mark and avatar. Two briefs to hand on:

```text
BRIEF FOR A DESIGNER
José Antonio Garrido (yeyo11) is a Spanish developer who builds open-source tools and announces each
one on josegarrido.dev, in English and Spanish. The writing is first person, teaching, direct and
honest about limits, with no hype: problem first, then the exact command, config or output. The site
needs a personal identity separate from the tools' own brands (avoid navy, cyan, blue-to-violet,
orange or coral; avoid Saira, Geist, Atkinson and Inter).

A first version exists and is live: a blackboard. Green slate #17211D, chalk text #ECEAE2, secondary
#A7B2AB, one yellow chalk accent #F2D46B, and a paper day theme with an ochre accent #7A5C00 and a
highlighter stroke #E9B824. Recursive (casual for headings, linear for interface, mono for code) is
paired with Literata for reading. The mark is a lowercase "jg" in round chalk strokes whose g-tail
becomes a yellow underline; the same underline sits under the name on the home page.

Please refine:
1. The monogram: optical balance, stroke weight at 16 px and 400 px, and a version with the name.
2. The avatar, safe inside a circular crop.
3. An OG image template, 1200x630, for launch articles: project name, one-line pitch, version, a demo
   frame (terminal or screenshot), and the mark and name.
4. The day theme's character, which should stay paper, not cream.
5. The type scale, and the casual-axis value used for headings.

Keep it calm and restrained: one bold element per surface, AA contrast in both themes, no gradients,
no glow, no all-caps labels. The accent stays special and the board reads as green, not black.
Deliver SVG/Figma sources and a token file.
```

```text
PROMPT FOR CLAUDE DESIGN'S DESIGN-SYSTEM AGENT
Build a design system for the personal brand of José Antonio Garrido (GitHub yeyo11), a Spanish
developer who builds open-source tools and announces each one, the day it ships, on the bilingual
site josegarrido.dev. The voice is first person, teaching, direct, evidence first (commands, config,
output), honest about what does not work, never hype.

Concept: a teaching blackboard, restrained and modern, never kitsch: no chalk textures, no
skeuomorphism.

Night tokens (default): board #17211D (background), tray #1F2C26 (raised surfaces), rule #5E7268
(meaningful lines, 3:1), chalk #ECEAE2 (text), dust #A7B2AB (secondary), accent #F2D46B (links,
focus, selection), stroke #F2D46B (decorative underline). Day tokens (a paper page, not cream):
#F1F4F0, #E2E8E2, #7C8B82, #17211D, #4C5A53, accent #7A5C00, stroke #E9B824.

Type: Recursive for headings (CASL 1, weight 750-850), interface text (CASL 0) and code (MONO 1);
Literata for reading. Scale 14/18/21/24/36/48/60 px, 18 px body, about a 66-character column,
sentence case.

Mark: lowercase "jg" built from round strokes, the g's tail sweeping left as a yellow underline.

Produce: (1) logo: the mark alone, mark with name, one-colour version; (2) avatar, 400x400, safe in a
circle; (3) OG image template, 1200x630, for launch articles, with slots for project name, one-line
pitch, version and a demo frame, the mark and name, the yellow underline once under the project
name; (4) tokens as CSS custom properties and JSON, both themes; (5) components: site header, footer
of profile links, launch list item (date, title, pitch, project and version), article header, code
block, inline code, blockquote for "what does not work yet", link, focus ring, theme toggle, empty
state.

Rules: WCAG AA for every text pair in both themes, no gradients, no glow, no cards with shadows, no
all-caps or labels above headings, monospace only for machine text. One motion moment per page, none
under prefers-reduced-motion. Clearly distinct from navy and cyan, orange and coral, and
blue-to-violet palettes.
```

## Related

[[brands.md]] · [[launches-repo.md]] · [[plans/design-system.md]] · [[decisions/mvp-scope.md]]
