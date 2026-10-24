---
created_at: 2026-10-24T17:09:20.150181559Z
updated_at: 2026-10-24T17:19:31.127760046Z
tags:
    - brands
    - design-system
    - identity
    - decision
    - rejected
---
# The personal brand's visual identity

**Rejected.** Merged and deployed on <https://josegarrido.dev> on 2026-10-24 after the owner answered
"fine" to screenshots, then rejected by the owner once they saw it live: they do not like it at all,
and a new identity is being designed by another agent. It stays live until the replacement is
validated. Kept here as a record of what was tried, so the next design does not repeat it. Lesson: a
redesign is merged only after the owner has tried it running, not from screenshots.

Before it, the site wore Shipcast's tokens ([plans/design-system.md](plans/design-system.md)); once
the blog became the owner's personal home, at the root of their own domain, it needed an identity of
its own, distinct from Shipcast (navy, orange, coral, cyan, Saira) and from claudio (navy, Geist,
blue-to-violet, cyan). An agent proposed this one on a branch.

## What was tried: the blackboard

A developer who teaches what they build. A green slate board carried chalk-white text and one yellow
chalk stroke as the accent; no navy, blue, violet, cyan or orange, and no gradients. Dark by default,
the owner's preference; the day theme a paper page.

| Token | Night (default) | Day | Role |
| --- | --- | --- | --- |
| `board` | `#17211D` | `#F1F4F0` | Background |
| `tray` | `#1F2C26` | `#E2E8E2` | Code blocks, inline code |
| `rule` | `#5E7268` | `#7C8B82` | Lines that carry meaning (3:1) |
| `chalk` | `#ECEAE2` | `#17211D` | Text |
| `dust` | `#A7B2AB` | `#4C5A53` | Secondary text |
| `accent` | `#F2D46B` | `#7A5C00` | Links in text, focus, selection |
| `stroke` | `#F2D46B` | `#E9B824` | The underline and the mark's tail; decoration only |

Every text pair passed AA in both themes. Type: **Recursive** (casual axis for headings, linear for
interface, mono for code) and **Literata** for reading, on a 14 · 18 · 21 · 24 · 36 · 48 · 60 px scale.
Mark: a lowercase `jg` in round chalk strokes whose g-tail became a yellow underline, also drawn under
the owner's name on the home page; favicon and a 400 × 400 avatar (never uploaded to the networks).
One motion moment: the underline drawing itself on load.

## What stays from it, whatever the next design

These are not visual, and the next design keeps them: the page titles (the home page is the owner's
name, other pages `<page> | José Antonio Garrido`); the first-person intro, built from `brand.yml`
facts; the footer built from `brand.yml`, with the support link on its own line; the dark default with
a remembered light theme; AA contrast in both themes; self-hosted fonts.

The two refinement briefs written for this identity are withdrawn. The brief for its replacement is
kept with the owner's local notes, since it names private references.

## Related

[[brands.md]] · [[launches-repo.md]] · [[plans/design-system.md]] · [[decisions/mvp-scope.md]]
