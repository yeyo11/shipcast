---
created_at: 2026-10-25T16:31:21.19467279Z
updated_at: 2026-10-25T16:31:21.19467279Z
tags:
    - decision
    - web-app
    - design-system
    - cartel
    - base-ui
    - accessibility
    - mobile
---
# The component layer: Base UI wearing Cartel

Decided on 2026-10-25, in the first part of milestone 3 (the interface) of the
[goal after the MVP](../plans/goal-after-mvp.md), on the
[approved design direction](app-design-direction.md). The web app's interactive pieces (dialogs,
lists to pick from, menus, tabs, tooltips, popovers, the phone's drawer, toasts and the command
palette) are built on [Base UI](https://base-ui.com) (`@base-ui/react` 1.x) and dressed in
[Cartel](../plans/design-system.md) only.

## What was decided

- **Base UI for behaviour, Cartel for looks.** Base UI is unstyled: it brings the focus management,
  keyboard handling, ARIA roles, typeahead, swipe gestures and positioning, and nothing visual. No
  library theme is installed. Every part is styled in `apps/web/src/styles/components.css` with
  Cartel's role tokens (`--sc-ground`, `--sc-raised`, `--sc-text`, `--sc-rail`, `--sc-yellow`,
  `--sc-failure`, the stamp shadows), so the day theme keeps working with one attribute.
- **State comes from Base UI's data attributes**, never from classes the app toggles:
  `data-open`, `data-highlighted` (an option or menu item under the keyboard or pointer, filled in the
  text colour like the active section), `data-selected`, `data-active` (a tab), `data-popup-open`
  (a trigger), `data-starting-style` and `data-ending-style` for the way in and out. Transitions use
  a 180 ms `--ui-move` that drops to zero under `prefers-reduced-motion: reduce`, as Cartel's own
  `--sc-press` and `--sc-fade` do.
- **Typed wrappers, one per component**, in `apps/web/src/components/ui/`, so pages never assemble
  Base UI's parts themselves:
  - `Dialog` (title, description, body, footer, optional trigger; `DialogClose`).
  - `ConfirmButton`: a button that asks first, on AlertDialog. It replaces every `window.confirm`
    (disconnecting an account, rotating the webhook secret, revoking an API token). The question is a
    title, the consequence a sentence, Cancel is the first focusable, the confirming button repeats
    the verb, red for what cannot be undone, yellow for a change that only needs care.
  - `Combobox` (a list with a search, for the owner's repos), `Select` (a short list, for a release or
    a brand). Both take `{ value, label, hint }` options and give back the string id, so pages keep
    plain strings in state.
  - `Menu` (secondary actions behind one button: an account's Check, Publish with this one, Rename;
    the signed-in user's Sign out), `Tabs`, `Tooltip` (with one app-wide `TooltipProvider`),
    `Popover`, `Drawer` (a bottom sheet, swiped down to close).
  - `CommandPalette`: a Dialog around an inline Autocomplete, after Linear's. ⌘K or Ctrl+K anywhere,
    or Search in the top bar, or the phone's More; it filters the sections and the main actions
    (launch a repo, write, connect an account, run an automation round, create a token, sign out).
  - `icons.tsx`: the few interface glyphs, in `currentColor`, always decorative.
- **The toast API is kept.** `components/Toasts.tsx` is re-implemented on Base UI's Toast with the
  same `useToast().show/done/fail` the pages already call, and the same Cartel look (the outlined
  card with the small stamp, the state pill first, the failed card in red, waiting on yellow,
  Details folded in the mono face). Successes leave after six seconds, failures stay until closed.
  Base UI adds what the hand-rolled version lacked: the viewport is a landmark F6 reaches, timers
  pause while the pointer or the focus is on a toast, a toast can be swiped right or down, and it
  animates out before it is removed. A failure is announced with high priority. Each provider makes
  its own manager once, so the API's identity never changes and an effect that lists it does not run
  twice.
- **Native where native is enough.** The drafts on a launch's page stay native `<details>` (with a
  drawn marker), and the segmented controls (`.seg`) stay radio buttons that stack on narrow screens:
  neither needed a component.

## Why Base UI

The roadmap named it ([plans/after-mvp.md](../plans/after-mvp.md)): it is headless, so it cannot
fight Cartel's outlines and stamps the way a themed kit would; it ships the components the interface
milestone needs, including Drawer, Autocomplete and Toast; and its states are data attributes, which
CSS can style without JavaScript. Its documentation ships inside the package
(`node_modules/@base-ui/react/docs`), which is what the wrappers were written against.

## Consequences

- In development, Vite's dependency discovery is off for the client (see
  [web-app.md](../web-app.md)), so each Base UI entry point the app imports is listed in
  `apps/web/vite.config.ts` (`BASE_UI`) to be pre-bundled; a new component needs a line there.
- Portals render at the end of the body; the app root is `isolation: isolate` so they always sit
  above it.
- The components are reviewed running at the hidden route `/design/components`, next to
  `/design/illustrations`.

## Related

[[decisions/app-design-direction.md]] · [[plans/design-system.md]] · [[web-app.md]] · [[plans/goal-after-mvp.md]] · [[plans/after-mvp.md]]
