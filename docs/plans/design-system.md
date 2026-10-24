---
created_at: 2026-10-24T19:20:12.447836117Z
updated_at: 2026-10-24T19:20:33.000715612Z
tags:
    - plan
    - design-system
    - brand
    - decision
---
# Design system: Cartel

**Outcome (2026-10-24):** Shipcast's design system is **Cartel**, a poster system, approved by the
owner and merged into `main` from `design/system-cartel` (`ce92bfa`). Its source of truth is
[`design/README.md`](../../design/README.md), with the tokens, fonts, logo, channel icons, social
preview and a living specimen (`design/specimen.html`, opens from disk; `#day` for the light theme).
The first direction, the "signal path", was rejected and is recorded below.

## Cartel in short

- **Look:** a dark page (`#141413`) broken by yellow bands (`#FFD43B`) and a closing black band with
  a yellow headline. Phudu 900 uppercase for display only (150 · 96 · 48 · 30 px, tracking −0.035em,
  line height 0.9), Inter Tight for everything people read, JetBrains Mono only for commands,
  versions and `launch.yml`.
- **Shape:** pills for buttons, tags and states; 24 px cards, 30 px bands; 2.5 px black outlines;
  depth is a hard offset "stamp" shadow, never a blur. The primary yellow button presses into its
  stamp.
- **Colour means one thing each:** yellow is "this needs you" (the primary action, waiting for
  approval); black carries the structure; red (`#FF6B5B` night, `#B42318` day) only for failure.
  `node design/scripts/contrast.mjs` checks the CSS against the JSON and 24 pairs, all AA.
- **States, word plus shape:** Published (filled pill), Waiting for you (yellow with a black edge),
  Draft (dotted marker), Manual — post it yourself (dashed), Failed (red outline, diamond marker).
  Reddit and Hacker News are always Manual.
- **Mark:** a yellow rounded square with a black outline, a black dot inside and an offset shadow.

It was chosen over three other directions explored at the same time (Departures, Manifest, Console).

## Principles kept from the first plan

- **Two layers.** Shipcast's own identity is one layer. What it generates for a launched project (OG
  image, cover, article page) is filled with *that brand's* identity: the personal brand's is the
  editorial one ([personal-identity.md](../personal-identity.md)), and the company brand will have its
  own. A company asset never carries the personal look; Shipcast's mark appears on generated assets
  only when the brand opts in.
- **Sibling, not clone.** claudio has its own system (dark navy, Geist, a blue-to-violet surface
  gradient, cyan for live work); Shipcast must be told apart from it at a glance, and from the
  personal site.
- **State is never colour alone**, AA contrast in both themes, control borders at 3:1, visible focus,
  usable at 360 px.

## Surfaces, in the order they are needed

1. Logo, favicon, README header and the GitHub social preview (`design/social-preview.png`, to be
   uploaded by the owner).
2. The dashboard (`apps/cli/src/dashboard.ts`, plain for now), built from the specimen.
3. CLI output: an ANSI mapping of the palette, honouring `NO_COLOR`.

## Rejected: the signal path

Proposed on 2026-10-24 from the first social preview ([docs/assets/social-preview.jpg](../assets/social-preview.jpg)):
a release node fanning out into one branch per channel, warm (orange, coral) for the release and what
needs the owner, cool (cyan) for channels reached; navy `#02142C`, Saira, Atkinson Hyperlegible Next
and Commit Mono; a branch's state as its shape. Assets were built on a branch and never merged: the
owner was not convinced after a second opinion, and it was dropped for Cartel. Its designer and
Claude Design briefs are withdrawn.

## Related

[[plans/shipcast.md]] · [[status.md]] · [[personal-identity.md]] · [[brands.md]] · [[publishing.md]]
