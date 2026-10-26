---
created_at: 2026-10-26T16:39:51.199517003Z
updated_at: 2026-10-26T20:53:07.603648976Z
tags:
    - plan
    - design-system
    - brand
    - decision
    - illustrations
    - base-ui
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
  Draft (dotted marker), Quiet — not launched, deleted, dismissed (dashed; it was "Manual, post it
  yourself" until the drafts for the owner to post were removed on 2026-10-26), Failed (red outline,
  diamond marker).
- **Mark:** a yellow rounded square with a black outline, a black dot inside and an offset shadow.

It was chosen over three other directions explored at the same time (Departures, Manifest, Console).

## Illustrations

Drawn for the [design direction after the MVP](../decisions/app-design-direction.md): **postal, with
humour**, in the Gumroad-like language of flat shapes, a thick black outline and an offset shadow.
They live in `apps/web/src/components/illustrations/`, one React component per scene, exported with a
typed `Illustration` name union and an `ILLUSTRATIONS` map (component and what it is for).

- **Tokens only.** Every colour is a Cartel role through a CSS variable (`--sc-black` for ink,
  `--sc-cream` and `--sc-on-black` for paper, `--sc-yellow`, `--sc-stamp` for the shadow,
  `--sc-rail` for a wall behind) or `currentColor` for what is drawn straight on the page (floors,
  cords, motion marks). So the day theme works with no second drawing. `--sc-failure` appears only
  in the failure scenes (ServerError, PublishFailed), always with its word ("Damaged"); print on a
  red seal is in `--sc-ground`, the one colour that passes on both themes' reds.
- **The stamp shadow** is a duplicate of the shape offset down and right in `--sc-stamp`, like
  `--sc-stamp-sm/lg`: no filters, no blur, no gradients. Texture is a halftone `<pattern>` (ink dots
  on a box's shaded side, page-colour dots for the disc behind a subject), with ids from `useId` so
  copies on one page never clash.
- **Humour:** each scene carries one wink — "Return to sender" with tracking No. 404, "this side up"
  arrows upside down on the 500 parcel, a dozing mailbox, a moth leaving the empty box, a megaphone
  that only puffs dots, "Reward: stars" on the Wanted poster, a stamp with a face for the AI, a
  moustache on the top parcel of the Launches stack, a sweating parcel on the scale, a screw left
  over beside the toolbox, a pigeon that took the post literally.
- **Frame and sizes:** a 320 × 240 (4:3) `viewBox`, scaled by `width`; drawn to read from 120 to
  320 px. The outline is 4 units (2 px at 160 px). Lettering only in Phudu (uppercase) or the mono,
  and short.
- **Accessibility:** decorative (`aria-hidden`) by default; a `title` prop makes it an image with a
  name, for when the drawing says something the page does not. The one motion (the desk bell's
  wobble in WaitingForYou) runs only under `prefers-reduced-motion: no-preference`.
- **Never** generated images, **no rockets** (another brand's), no colour outside the palette.

The set: NotFound, ServerError, Offline, EmptyLaunches, EmptyDrafts, NoAccounts, WaitingForYou,
Shipped, PublishFailed, SignIn, Automation, the onboarding steps OnboardBrand, OnboardAI,
OnboardChannels, OnboardMeasure, OnboardAutomation, and the **page-banner scenes**: Parcels, Sealing,
Typewriter, Pigeonholes, Mailbox, Scale, Toolbox. They are reviewed running at the hidden app route
`/design/illustrations` (both themes, 320 and 160 px) and copied into `design/specimen.html` as static
SVG by `pnpm illustrations:specimen`, so the specimen still opens from disk. Since 2026-10-25 the app
uses NotFound (404), ServerError (the error boundary), EmptyLaunches, EmptyDrafts and NoAccounts (empty
states), SignIn and OnboardMeasure (the Stats placeholder); the rest wait for their screens.

### Page banners

Every section's banner carries one scene beside its title, through `PageHead`'s `art` prop (and
`SectionHead`'s, for a Settings sub-page): about 200 px wide, so at most 150 px tall, and hidden under
760 px where it only pushes the title down. The scenes are decoration (`aria-hidden`).

| Page | Scene | What it shows |
| --- | --- | --- |
| Launches | Parcels | Stamped parcels on a sack truck, the top one with a moustache, a rubber stamp waiting |
| Launch a repo | Sealing | A parcel taped shut and labelled "To: The world", the tape dispenser beside it |
| Write | Typewriter | A typewriter whose page starts "Dear world,", the bell about to ding |
| Channels | Pigeonholes | The pigeonhole wall, a few holes tagged, a pigeon with a letter in its beak |
| Comments | Mailbox | A smiling mailbox, letters arriving, a reply slip |
| Stats | Scale | A platform scale weighing a parcel with a bar chart on its label |
| Settings | Toolbox | A toolbox on a parcel, a wrench, a stamp and a spare screw |
| Settings › Automation | Automation | The sorting machine, back in its header |

## The component layer

The app's interactive pieces are [Base UI](https://base-ui.com) wearing Cartel only, decided in
[decisions/component-layer.md](../decisions/component-layer.md) (2026-10-25). No library theme: typed
wrappers in `apps/web/src/components/ui/` (Dialog, ConfirmButton on AlertDialog, Combobox, Select,
Menu, Tabs, Tooltip, Popover, Drawer, the command palette) and the toasts are styled in
`apps/web/src/styles/components.css` with the role tokens, each state read from Base UI's data
attributes (`data-open`, `data-highlighted`, `data-selected`, `data-active`, `data-starting-style`,
`data-ending-style`).

- **Popups** (lists, menus, popovers) are the page colour with a 2 px text-colour outline, 18 px
  corners and the small stamp; a highlighted option is filled in the text colour, like the active
  section in the navigation; every option is 44 px tall.
- **Dialogs** carry the card's 2.5 px outline and the large stamp over a flat black dim (no blur); an
  alert for something that cannot be undone has a red edge and a red confirming button that repeats
  the verb. The drawer is a bottom sheet with the same outline.
- **Tooltips** are small black labels with the rail as edge, for the full text of something clamped
  or a shortcut, never the only place information lives.
- **Motion** is a 180 ms slide or fade (`--ui-move`), zero under `prefers-reduced-motion`.

They are reviewed running at the hidden app route `/design/components`. Section headers are the
neutral band with the huge title and the yellow main action, the work area below calmer, as the
[design direction](../decisions/app-design-direction.md) asks.

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
  usable at 320 px (WCAG 2.2 reflow, checked by `apps/web/scripts/reflow-check.ts`).

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

[[plans/shipcast.md]] · [[status.md]] · [[personal-identity.md]] · [[brands.md]] · [[publishing.md]] · [[decisions/app-design-direction.md]] · [[decisions/component-layer.md]] · [[decisions/automatic-channels-only.md]] · [[plans/goal-after-mvp.md]]
