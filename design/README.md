# Shipcast design system

Shipcast looks like a poster: a dark page broken by yellow bands, heavy uppercase headlines,
chunky pills, and hard black outlines with offset "stamp" shadows instead of soft ones. One yellow
does all the brand work and always means the same thing: **this needs you**. Black carries the
structure, and red appears only when something failed.

Open [`specimen.html`](specimen.html) in a browser (no build, no server) to see everything at once.
Add `#day` to the URL, or use the switch, for the day theme.

## Files

| Path | What it is |
| --- | --- |
| `tokens.css` | CSS custom properties. Night on `:root`, day on `[data-theme="day"]`; also the `@font-face` rules |
| `tokens.json` | The same values, for tools and other platforms |
| `scripts/contrast.mjs` | Checks that the CSS matches the JSON and that every pair passes WCAG AA |
| `fonts/` | Phudu, Inter Tight (roman and italic) and JetBrains Mono, variable, latin, woff2, with their OFL licences |
| `logo/mark.svg`, `logo/mark-day.svg` | The mark on dark and on light grounds |
| `logo/mark-mono.svg` | One-colour mark in `currentColor` (inline it) |
| `logo/favicon.svg` | The mark without its shadow, for 16–32 px |
| `logo/wordmark.svg`, `logo/lockup.svg`, `logo/lockup-day.svg` | Wordmark and lockups; Phudu is embedded, so they render without the font installed |
| `icons/*.svg` | Channel glyphs in `currentColor`: the networks' own marks from [Simple Icons](https://simpleicons.org) (CC0), plus Blog, LinkedIn and Newsletter drawn here |
| `social-preview.svg`, `social-preview.png` | GitHub social preview, 1280 × 640 |
| `specimen.html` | The living specimen, with the illustrations copied in as static SVG |

## Colour

Components use the role names, never raw hex values, so the theme is one attribute.

| Token | Night | Day | Use |
| --- | --- | --- | --- |
| `--sc-ground` | `#141413` | `#FFFFFF` | Page |
| `--sc-raised` | `#1F1F1D` | `#EDEEF0` | Neutral cards and bands |
| `--sc-black` | `#000000` | `#000000` | The closing band, the launch card |
| `--sc-on-black` | `#F4F2EC` | `#F4F2EC` | Text on black |
| `--sc-hairline` | `#33322F` | `#D6D5D1` | Dividers, decorative only |
| `--sc-rail` | `#76746D` | `#7A7872` | Control borders (3:1) |
| `--sc-text` | `#F4F2EC` | `#0D0D0D` | Text |
| `--sc-muted` | `#A9A69E` | `#5A5852` | Secondary text |
| `--sc-yellow` | `#FFD43B` | `#FFD43B` | The brand: primary action, waiting for you, bands |
| `--sc-on-yellow` | `#000000` | `#000000` | Text on yellow |
| `--sc-cream` | `#FFF8DC` | `#FFF8DC` | Cards sitting on a yellow band |
| `--sc-failure` | `#FF6B5B` | `#B42318` | Failure only, always with its word |
| `--sc-success` | `#6FD58E` | `#157A3E` | Published / done, always with a word or a shape (the filled state dot); 10.2:1 and 5.4:1 on the ground |

Run `node design/scripts/contrast.mjs` after any colour change; it prints the full table. Every text
pair passes AA in both themes, and control borders pass 3:1.

## Type

- **Phudu** 700–900, uppercase, tracking −0.035em, line height 0.9, for display only (24 px and
  up): 150 · 96 · 48 · 30 px.
- **Inter Tight** for everything people read: 20 px lead, 16 px body (line height 1.5), 14 px
  labels at 600.
- **JetBrains Mono** only for what a machine reads: commands, versions (`v0.9.0`), `launch.yml`.

## Shape and depth

- Pills (`--sc-radius-pill`) for every button, tag and state; 24 px for cards, 30 px for bands.
- Cards carry a 2.5 px outline. Depth is a hard offset "stamp" shadow (`--sc-stamp-sm`,
  `--sc-stamp-lg`) in the stamp colour, never a blur. The primary button presses into its stamp.
- Pages alternate bands: neutral, yellow, black. A page closes on the black band with a yellow
  headline.

## States

A state is always a word and a shape; colour repeats what the shape says.

| State | Pill | Card |
| --- | --- | --- |
| Published | Filled in the text colour | Neutral |
| Waiting for you | Yellow with a black edge | Yellow with a stamp shadow |
| Draft | Outlined, dotted marker | Neutral |
| Manual (post it yourself) | Dashed outline | Dashed, transparent |
| Failed | Red outline, diamond marker | Red outline, with what happened and the fix |

Reddit and Hacker News are always Manual.

**State dots** mark a channel where a pill would not fit (a launch card's channel marks, the launch
page's channel chips): a filled `--sc-success` circle for published, a yellow ring for scheduled, a
`--sc-failure` diamond for failed, a dotted `--sc-muted` ring for not launched. The dot never stands
alone: its word is beside it or in the mark's accessible name.

**Toasts** carry an action's outcome in the app: a card with the 2.5 px outline and the small stamp,
its state pill first (Done, Failed, Waiting for you), a short title, what to do, and any technical
text folded under Details in the mono face. A failure is the failed card (red outline, diamond);
waiting is the yellow card. Successes leave after six seconds; failures stay until closed.

## Illustrations

Postal, with humour: parcels, stamps, postmarks and mailboxes, each with a wink ("Return to
sender", "Damaged"), flat, with the black outline and the stamp shadow. They are React components in
[`apps/web/src/components/illustrations/`](../apps/web/src/components/illustrations/), one per scene,
drawn on a 320 × 240 frame for 160–320 px.

- Colours are role tokens only (`--sc-black` ink, `--sc-cream` and `--sc-on-black` paper,
  `--sc-yellow`, `--sc-stamp` for the shadow) and `currentColor` for lines on the page, so the day
  theme needs nothing; `--sc-failure` only in the failure scenes, with its word.
- The shadow is the same shape offset in `--sc-stamp`, never a filter or a blur; texture is a halftone
  pattern.
- Decorative by default; pass `title` when the drawing says something the page does not. Motion, if
  any, only without `prefers-reduced-motion`.
- No generated images, no rockets.

Review them running at `/design/illustrations` in the app (both themes, two sizes) or in the
specimen. After changing a scene, run `pnpm illustrations:specimen` to refresh the specimen's copy.

## Rules

Do: one yellow primary action per view; display type uppercase and heavy, everything else in
sentence case; buttons named by what happens ("Approve 2 posts") and the result echoing the verb.

Don't: soft shadows, gradients or glow; yellow text on a light ground (yellow is a fill there);
Phudu for running text; any colour outside the palette; rockets, navy or cyan, which belong to
other brands.

On assets generated for someone else's launch (OG images, covers), the launched brand's identity
leads; Shipcast's mark appears only when that brand opts in.
