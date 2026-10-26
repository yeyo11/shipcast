---
created_at: 2026-10-26T14:46:24.725757502Z
updated_at: 2026-10-26T14:46:24.725757502Z
tags:
    - plan
    - ideas
    - web-app
    - design
---
# Ideas on hold

Ideas that were weighed and are **not** being built now. Each says what it is, why it waits and what
it would take, so that picking one up later starts from the reasoning and not from zero. The roadmap
is in [after-mvp.md](after-mvp.md); what is being built is in [goal-after-mvp.md](goal-after-mvp.md).

## Start the page banner collapsed when the browser asks to save data

Raised on 2026-10-26, while the page banners of [the web app](../web-app.md) gained a button that
collapses them to a slim title strip (a global preference, kept in a cookie the server reads, so the
page is drawn in the right state with no flash). The idea: also start collapsed when the connection
is slow or unstable.

**Not now, by the owner's decision: not a priority.**

What was found when weighing it:

- **The saving is close to nothing.** The banners' illustrations are SVG inside the code, not files
  fetched apart; collapsing the banner removes a few KB of markup, not requests. The weight that
  would matter on a slow connection is elsewhere: the avatar images, the animated charts and the
  size of the JavaScript.
- **Detecting the speed is unreliable.** `navigator.connection` (`effectiveType`, `downlink`) exists
  in Chromium browsers only; Safari and Firefox expose nothing, so the behaviour would differ by
  browser. And a flaky connection goes up and down during a session, so a banner that folds and
  unfolds on its own would move the page under the reader, which is exactly the jump the collapsing
  animation avoids.
- **It surprises.** A layout change nobody asked for, caused by a signal the user cannot see.

The small version worth building if it is ever wanted: honour only the data saver the **user turns
on**, which Chromium sends as the `Save-Data: on` request header (a deliberate setting on phones).
The server reads it with the cookie when it draws the page:

1. no banner cookie and `Save-Data: on` → the banner starts collapsed;
2. as soon as the owner presses `−` or `+`, the cookie decides and the header is ignored;
3. no speed measuring and no reaction to changes while the page is open, so nothing moves.

It is a few lines where the banner state is read (`useBannerState` and its server side). If the
real goal is speed on slow connections, the better work is a separate review of avatar images,
chart animation and bundle size.

## Related

[[after-mvp.md]] · [[goal-after-mvp.md]] · [[web-app.md]] · [[design-system.md]]
