---
created_at: 2026-10-24T13:00:11.035124737Z
updated_at: 2026-10-24T13:02:35.845564852Z
tags:
    - plan
    - design-system
    - brand
    - decision
---
# Design system: direction and briefs

Proposed on 2026-10-24, before any UI exists, so that the first surfaces — the README and social
preview, the Astro blog, and later the OG images, the dashboard and the CLI — share one identity.
This document is the direction and the two briefs that hand it on: one for a designer, one for
Claude Design's design-system agent. What they produce becomes `docs/design-system.md` and the token
files; this plan then records the outcome.

## The reference image

The direction starts from the social preview the owner chose
([docs/assets/social-preview.jpg](assets/social-preview.jpg), 1280 × 640, cropped from a
2752 × 1536 Gemini render). It tells the whole product in one figure: a single line runs along the
baseline, rises, reaches one node and **fans out** into many lines, each ending at a channel. The line
turns from warm to cool on the way: warm is the project being released, cool is the audience it
reaches.

That figure is the system. Everything below derives from it.

## The idea: the signal path

- **A launch is a signal path.** One release node; one branch per channel. The launch view, the OG
  images and the logo are all drawings of the same fan-out.
- **Warm is the source, cool is the destination.** Orange and coral belong to the release and to what
  needs the owner (approval); cyan belongs to channels the launch has reached. The gradient exists only
  along a line, where it means that direction, never as a fill.
- **A branch's state is its shape**, plus a word, never colour alone:
  - *Draft*: dashed branch.
  - *Awaiting approval*: solid branch to a hollow node, in ignition orange (it needs you).
  - *Published*: solid branch to a lit cyan node.
  - *Manual*: the branch stops short of its channel, as two lines do in the image, with a *Copy draft*
    action — Reddit and Hacker News always look like this.
  - *Failed*: a broken branch in flare, with the error and how to fix it.
- **The node, not the rocket, is the mark.** The rocket in the image is stock iconography and reads
  as any startup; the logo is the release node with its fan, which no one else owns.

## Palette

Sampled from the image and adjusted to pass WCAG 2.x AA; checked on 2026-10-24.

**Night (default for brand surfaces and the dashboard)**

| Token | Hex | Role | Contrast |
| --- | --- | --- | --- |
| `abyss` | `#02142C` | Background (the image's navy) | — |
| `deck` | `#0A2142` | Raised surfaces | ice 15.7 on it |
| `grid` | `#173A66` | The faint grid, decorative only | 1.6, never for text or control borders |
| `ice` | `#F2FFFF` | Text, the wordmark | 18.0 on abyss |
| `mist` | `#9DB2C9` | Secondary text | 8.5 on abyss, 7.4 on deck |
| `ignition` | `#F88E55` | The release, the primary action (abyss text on it: 7.9), awaiting approval | 7.9 on abyss |
| `flare` | `#E75D6E` | Middle of the line gradient; failure, always with a broken line and the word | 5.4 on abyss, 4.7 on deck |
| `signal` | `#49DBE9` | Reached channels, links | 11.1 on abyss |

**Day (the blog's reading theme, and an option everywhere)**: `paper` `#F4F7FA`, `shoal` `#E3EBF2`
surfaces, `ink` `#02142C` text (17.2), `slate` `#4D6078` (6.0), `ignition-day` `#B4501A` (4.8; paper
text on it 4.8), `flare-day` `#B83048` (5.5), `signal-day` `#0B7380` (5.2).

Rules:

- Ignition on the one primary action of a view and the release node; signal on what was reached and
  on links; flare only inside the gradient and for failure.
- The gradient `ignition → flare → signal` is drawn only along a signal line.
- Glow (the bloom around lines and icons in the image) is for marketing art only — social preview,
  OG images, the README hero — never on UI text, controls or data.
- Borders that identify a control need 3:1 against their background; `grid` never does that job.

## Type

- **Saira** (variable, OFL, width axis 50–125), close to the image's squared geometric wordmark:
  semi-expanded heavy weights for the wordmark and display, normal width for headings and UI.
- **Atkinson Hyperlegible Next** (variable, OFL) for running text: articles, drafts, descriptions.
  Clearly distinct from Saira, built for legibility.
- **Commit Mono** (OFL) only for what the machine reads: commands, `launch.yml`, paths, versions.
  Never for labels, counts or dates.
- Scale on a major third from 16 px: 13 · 16 · 20 · 25 · 31 · 39 · 49. Text line height 1.5, display
  1.05, measure 60–72 characters. Sentence case; no all-caps labels.

## Shape, space, motion

- Lines are the main graphic element: 2 px branches, round caps, nodes as 10 px rings. Radius has a
  hierarchy: 3 px on controls, 8 px on panels, full on nodes. 4 px spacing grid. Surfaces are told
  apart by `deck` and borders, not shadows.
- One motion moment: when a launch publishes, the signal travels from the release node along each
  branch and lights its node, branch after branch. It plays once, only for a live change, and becomes
  an instant state change under `prefers-reduced-motion`. Nothing else moves on its own.

## Layout concept

```
 claudio v0.9.0                                              [Approve 2]

                       ╭────────────────●  Blog       Published
                       ├────────────────●  dev.to     Published
 ◉ release ────────────┼────────────────○  X          Awaiting approval   [Review]
                       ├────────────────○  LinkedIn   Awaiting approval   [Review]
                       ╰──────────         Show HN    Manual              [Copy draft]
```

The launch view is the fan itself, left to right; the rows on the right are the channels, left-aligned.
On a phone the fan turns vertical: the release on top, one branch per row below. The blog article is
a single column of 66 characters.

## Surfaces, in the order they are needed

1. Logo, favicon, README header and the GitHub social preview — now.
2. The Astro blog in the launches repo — phase 0; offered as a template to others in phase 6.
3. CLI output: an ANSI mapping of the palette, honouring `NO_COLOR` — phase 1.
4. OG image (1200 × 630) and cover templates — phase 3.
5. The dashboard — phase 4.

**Two layers.** Shipcast's own identity is the layer above. The assets it generates for a launched
project (OG image, cover, article page) are a template filled with *that brand's* tokens: the
personal brand (yeyo11) and the company brand (josegarridodigio) each define a logo, an accent and
a type pairing, and a company asset never carries the personal look. Shipcast's mark appears on
generated assets only when the brand opts in.

**Sibling, not clone.** claudio has its own system, Night Shift: a dark navy too, but Geist, a
blue-to-violet gradient on surfaces and cyan for live work. Shipcast differs in type (Saira and
Atkinson), in its warm-to-cool line instead of a surface gradient, and in what cyan means (reached,
not working now).

## What was revised

1. The first social preview prompt asked for a dark banner with a warm gradient and cyan endpoints;
   the first draft of this plan rejected that as the generic developer-tool look and proposed a
   signal-flag system on light chart paper (the Blue Peter as logo, channels as code flags).
2. The owner liked the render of that first prompt. Looking at it again, it is specific where it
   counts: the fan-out *is* the product, and the warm-to-cool line carries meaning. The direction now
   starts from it, and keeps the discipline of the first draft where the image is generic: no rocket,
   glow only in marketing art, gradient only along lines, state by shape and word.

## Brief for a designer

```text
You are designing the visual identity and design system for Shipcast, an open-source developer tool
(MIT, github.com/yeyo11/shipcast). Shipcast automates the launch of GitHub projects: when a developer
publishes a release, it reads the project's code with Claude, writes a launch post tailored to every
channel (their own blog, dev.to, Hashnode, X, LinkedIn, Bluesky, Mastodon, plus Show HN and Reddit
drafts to paste by hand), and publishes each one only after the developer approves it, according to
a per-channel mode: auto, approval or manual. Approval happens by merging a pull request of drafts.
It also generates a demo GIF and an OG image for each launch, and measures which channel worked.
The name is ship + broadcast; the tagline is "Release once. Launch everywhere." Audience: indie and
open-source developers who hate marketing their own work: technical, allergic to hype, and they
judge a tool by its README.

Starting point: the approved social preview (attached). A line runs along the baseline, rises to one
node and fans out into many lines, each ending at a channel icon; the line goes from warm
(orange, coral) to cool (cyan). Build the identity from that figure:
- A launch is a signal path: one release node, one branch per channel. Warm = the release and what
  needs the owner; cool = channels reached. The gradient only ever runs along a line, never as a fill.
- A branch's state is its shape plus a word: Draft (dashed), Awaiting approval (solid to a hollow
  node, orange), Published (solid to a lit cyan node), Manual (the branch stops short of its channel,
  with a Copy draft action), Failed (broken branch in coral, with the error and the fix).
- The logo is the release node with its fan, not the rocket: the rocket is stock imagery.
- Glow belongs to marketing art only (social preview, OG images, README hero), never to UI.

Palette (WCAG AA verified):
- Night, default: abyss #02142C background, deck #0A2142 surfaces, grid #173A66 (decorative only),
  ice #F2FFFF text, mist #9DB2C9 secondary, ignition #F88E55 (primary action, release, awaiting),
  flare #E75D6E (gradient middle, failure only), signal #49DBE9 (reached, links).
- Day, for reading the blog: paper #F4F7FA, shoal #E3EBF2, ink #02142C, slate #4D6078,
  ignition #B4501A, flare #B83048, signal #0B7380.
Type: Saira (variable, width axis) for the wordmark, display and UI, close to the wordmark in the
image; Atkinson Hyperlegible Next for running text; Commit Mono only for commands and launch.yml.
Major-third scale from 16 px (13/16/20/25/31/39/49), sentence case, no all-caps labels.
Shape: 2 px lines with round caps, 10 px ring nodes, radius 3 px on controls and 8 px on panels,
4 px grid, borders rather than shadows. One motion moment: the signal travelling along each branch
when a launch publishes; nothing else animates on its own; reduced motion respected.

Avoid: generic startup iconography (rockets, sparkles), glow on interface elements, gradient fills,
identical rounded cards with soft shadows, all-caps eyebrows, monospace labels. Shipcast is a sibling
of claudio, whose system is dark navy with Geist, a blue-to-violet surface gradient and cyan for
live work: Shipcast must be told apart at a glance.

Two layers: Shipcast's own identity, and a themable template for the assets it generates for other
people's projects (OG image 1200x630, cover, blog article page), filled with each brand's own logo,
accent and type. The owner has two brands that must never mix: a personal one and a company one.

Deliverables:
1. Logo (node-and-fan mark + Saira wordmark), favicon, and a refined social preview (1280x640, key
   content inside 80 px margins) without the rocket.
2. Channel icon set in the image's line style, recognisable without colour.
3. Tokens for both themes (colour, type, space, radius, line, motion) as CSS custom properties and
   JSON.
4. Specimens: a blog article page (day), an OG image template with brand slots, the dashboard launch
   view (a launch with five channels in different states, desktop and phone), and the CLI colour
   mapping.
5. A short usage guide: where ignition, signal and flare go, how branch states work, what never to
   do.
Accessibility: text contrast at least 4.5:1 in both themes, control borders 3:1, focus visible,
nothing conveyed by colour alone, usable at 360 px wide.
```

## Prompt for Claude Design's design-system agent

```text
Create the design system for Shipcast (github.com/yeyo11/shipcast), an open-source tool that
launches GitHub projects: on each release it reads the code with Claude, writes a post for every
channel (blog, dev.to, Hashnode, X, LinkedIn, Bluesky, Mastodon; Show HN and Reddit as drafts to
paste) and publishes each after the developer approves it. Tagline: "Release once. Launch
everywhere." Users are indie and open-source developers: technical, allergic to hype. Copy is plain,
sentence case, active voice; buttons say exactly what happens ("Approve", "Publish", "Copy draft"),
and the toast after Publish says "Published".

Use the attached social preview as the visual source: a line along the baseline rises to a node and
fans out into branches, each ending at a channel, going warm (orange, coral) to cool (cyan). Turn it
into a system:
- Signal path: one release node, one branch per channel. Warm = the release and anything that needs
  the owner; cool = channels reached. The gradient ignition -> flare -> signal is drawn only along
  lines, never as a surface, button or text fill.
- Branch states, always shape + word: Draft = dashed branch; Awaiting approval = solid branch to a
  hollow node in ignition; Published = solid branch to a filled signal node; Manual = branch stops
  short of the channel, with a "Copy draft" action; Failed = broken branch in flare with the error
  and the fix.
- Logo: the release node with its fan, plus the wordmark. No rocket.
- Glow only in marketing art (social preview, OG, README hero); the UI is flat and crisp.

Tokens (use exactly; AA contrast already verified):
- Night (default): abyss #02142C bg, deck #0A2142 surface, grid #173A66 decorative only,
  ice #F2FFFF text, mist #9DB2C9 secondary, ignition #F88E55 primary action (abyss text on it),
  flare #E75D6E failure + gradient middle, signal #49DBE9 reached + links.
- Day ([data-theme="day"], used for the blog): paper #F4F7FA, shoal #E3EBF2, ink #02142C,
  slate #4D6078, ignition #B4501A, flare #B83048, signal #0B7380.
- Type: Saira (variable) for wordmark (semi-expanded, 700-800), display and UI; Atkinson
  Hyperlegible Next for running text, line height 1.5, measure 60-72ch; Commit Mono only for
  commands, code, launch.yml, paths and versions. Scale 13, 16, 20, 25, 31, 39, 49 px. No all caps.
- Lines 2 px with round caps; nodes 10 px rings; radius 3 px controls, 8 px panels; 4 px spacing
  grid; borders instead of shadows; control borders at least 3:1.
- Motion: one signature animation, the signal travelling from the release node along each branch
  and lighting its node, branch after branch (about 700 ms total, ease-out); everything else instant
  or a short fade; all motion off under prefers-reduced-motion.

Build:
1. Token files: CSS custom properties for night and day, and a JSON export.
2. Components: button (primary, secondary, destructive, quiet), text input, select, checkbox,
   segmented control for channel mode (auto / approval / manual), channel icon set (line style,
   recognisable without colour), branch + node in every state, launch fan view, status label with
   word, toast, empty state, code block for launch.yml, before/after diff of an edited draft.
3. Reference screens: (a) dashboard launch view for "claudio v0.9.0": Blog and dev.to Published,
   X and LinkedIn Awaiting approval, Show HN Manual — desktop with the fan left to right, phone with
   the fan vertical; (b) a blog article page in day theme, one centred column; (c) an OG image
   template 1200x630 with slots for project name, one-line pitch, demo GIF frame, brand logo and
   brand accent; (d) a refined GitHub social preview 1280x640 for Shipcast, content inside 80 px
   margins, without the rocket; (e) the CLI colour mapping for `shipcast launch`, honouring NO_COLOR.
4. The OG and article templates must be themable per brand (logo, accent, type pairing) so a company
   launch never carries the personal look; Shipcast's mark appears there only on opt-in.
5. A usage page: do's and don'ts, branch state vocabulary, and the contrast of every text/background
   pair in both themes.

Quality bar: WCAG AA in both themes, visible keyboard focus, works at 360 px, 44 px touch targets on
mobile. Avoid: rockets and sparkles, glow on UI, gradient fills, identical rounded cards with soft
shadows, uppercase eyebrows, monospace labels, arrows appended to button text. It must be told apart
from claudio's Night Shift system (Geist, blue-to-violet surface gradient, cyan for live work).
```

## Related

[[plans/shipcast.md]] · [[status.md]] · [[design-system.md]] · [[brands]]
