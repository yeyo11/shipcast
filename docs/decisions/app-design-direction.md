---
created_at: 2026-10-25T14:49:04.049764608Z
updated_at: 2026-10-25T14:49:04.049764608Z
tags:
    - decision
    - design
    - web-app
    - cartel
    - mobile
    - charts
    - illustrations
    - blog
---
# The design direction after the MVP

Approved by the owner on 2026-10-25, in the design round of the
[goal after the MVP](../plans/goal-after-mvp.md) (milestone 2), from two rounds of questions and real
reference sites studied from screenshots. It sets how the app's next screens look and behave; every
screen is built on it and shown to the owner as a live preview before it merges. Cartel stays the
design system ([plans/design-system.md](../plans/design-system.md)): yellow still means "this needs
you", black outlines and the offset stamp shadow stay, Phudu for headlines.

## The owner's answers

| Question | Answer |
| --- | --- |
| Navigation on phones | A **bottom bar** with the four main sections and a "More" that opens a panel |
| How much poster | **Poster in the headers, calm in the data**: section headers, bands and calls to action at full Cartel strength; tables, charts, forms and the editor quieter and denser, for working |
| Product references | Left to the agent: the ones that fit Cartel best (below) |
| Charts | **Rich and analytical**: several series, period comparisons, zoom |
| Chart library | **visx** (primitives over d3), for full control of the look in Cartel's tokens |
| AI assistant | **Both**: quick actions on the selected text, and a chat panel beside the editor for open requests; every proposal arrives as a diff to accept or reject |
| Onboarding | **Full-screen steps** on the first sign-in, one illustration per step, skippable and resumable |
| Illustrations | **Postal, with humour**: parcels, stamps, postmarks, mailboxes, with a wink ("Return to sender", "Damaged"), flat, with the stamp shadow |
| Blog project pages | A project card, the history of its launches, its demo, and an index of projects and articles |

## What each reference gives

| Reference | Taken from it |
| --- | --- |
| Linear (the app and its changelog) | Dense lists with filters on top and keyboard shortcuts; the **command palette**; the properties column on the right of a detail page; the changelog's **timeline**, for a project's launches on the blog |
| PostHog (product analytics) | **Rich charts**: a control bar (period, grouping, chart type, compare), one series per channel, a ranking under the chart; and an illustrated humour that suits "postal, with humour" |
| Typefully | The **editor**: drafts on the left, the text in the middle, one tab per network with its preview, Schedule and Publish on top; plus the AI selection actions and the side chat |
| Gumroad | The **illustration** language: flat shapes, a thick black outline, an offset shadow, flat colours, close to Cartel's stamp |
| Raycast (an extension's page) | The blog's **project card**: a header with icon, description and figures (stars, version), tabs for overview and versions, a gallery of screenshots or the demo, a side column |
| Bluesky and iOS apps | The **bottom bar** on phones: four sections and "More", always in reach of the thumb |

## How a screen is built

- **A section header is a Cartel band**: the huge uppercase title and the section's main action in
  yellow.
- **Below it, the work area is calm**: tables, charts and forms on `--sc-raised` with `--sc-rail`
  borders, Inter Tight at working sizes, the stamp shadow only on what is pressed or what needs the
  owner.
- **On phones** the bottom bar holds Launches, Write, Channels and Stats, and "More" opens a panel
  (Base UI Drawer) with the rest; on wider screens the navigation stays at the top.
- **Charts** in visx: series per channel in each network's own colour where it passes contrast, the
  comparison period dashed, a tooltip and a crosshair, zoom by brushing, the ranking table under the
  chart.
- **The editor**: drafts list, text, per-network tabs with previews, the selection menu (improve,
  shorten, translate, titles, adapt to a network, check against the code) and the chat panel, which
  closes to an icon.
- **Onboarding**: full-screen steps (brand and blog, AI provider, channels, measurement, automation),
  one illustration each, a progress line, "Skip for now" on every step, resumable from Settings.
- **Illustrations**: drawn SVG as React components on Cartel's role tokens, so the day theme works for
  free; never generated images; no rockets.
- **The blog's project pages** stay in the blog's editorial identity
  ([personal-identity.md](../personal-identity.md)), not in Cartel: a project card, the launches as a
  timeline, the demo, and `/<lang>/projects/` with an article index filterable by project and topic.

## Related

[[plans/goal-after-mvp.md]] · [[plans/after-mvp.md]] · [[plans/design-system.md]] · [[web-app.md]] · [[personal-identity.md]] · [[plans/search-presence.md]]
