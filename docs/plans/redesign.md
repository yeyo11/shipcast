---
created_at: 2026-10-31T12:04:51.33781303Z
updated_at: 2026-11-01T18:03:51.77824269Z
tags:
    - web-app
    - design
    - redesign
    - plan
---
# The redesign

Done on 2026-10-31 on the branch `feat/redesign`: every screen of the web app (`apps/web`) rebuilt to
the owner's design board, 76 screens plus the two bars, pixel by pixel. The board is a Design
artifact on claude.ai (private to the owner); this document records what was built from it, how it
was checked and what the backend could not back.

## Product decisions the board carries

- **Mostly a phone app.** Every screen is drawn at 390 px; nine have their own 1440 px board. Below
  960 px the phone layout, from 960 px the desktop one. A screen with no desktop board shows its
  phone content in the desktop page column.
- **What needs you first.** The Launches page opens on the yellow approval card and the rows of what
  waits on the owner (comments, failures, reconnections), then all launches.
- **Comments are read and answered in place** (`/comments?reply=<id>`), not on the network.
- **Five places on a phone**: Launches, Write, Comments, Stats and More. Channels, Launch a repo,
  Settings and the tour live in More, a bottom sheet over the bar.
- **Art only where it helps**: top-level sections and the empty and error states, never in the work.
- **One yellow primary action per view**, and every state is a word and a shape (Cartel,
  `design/README.md`).

## The kit

`apps/web/src/styles/kit.css` is the board's shared stylesheet with every class prefixed `k-`
(`btn sm pri` → `k-btn k-sm k-pri`) and its colours as Cartel's role tokens, so a screen reads like
its board and matches it. It loads after the older stylesheets. Next to it:

- `components/kit/Icon.tsx`: the board's line icons by name; `glyphs.ts`: the networks' glyphs inline,
  so they take the text colour.
- `components/kit/Bars.tsx`: the phone `TopBar` (each screen renders its own: the mark, or a way
  back), the `BottomBar` and the `DesktopHeader`.
- `components/kit/Overlay.tsx`: every overlay, the bottom sheet on a phone and its kind's shape on a
  desktop (below). `MoreSheet.tsx`: More. `Picker.tsx`: the pickers in place of native selects.
- `components/kit/shell.tsx`: one read of what needs the owner for the bell, Comments' badge and
  More's failing accounts, and the state of the palette, the bell's sheet and More.

Each section keeps its own stylesheet (`home.css`, `approve.css`, `published.css`, `write.css`,
`comments.css`, `channels.css`, `stats.css`, `settings.css`, `access.css`). The rules of the old
stylesheets that no screen uses any more were deleted.

## How it was checked

- **A seeded preview.** `apps/web/scripts/seed-preview.ts` fills a `…_preview` database (it refuses
  any other) with launches in every state, six accounts, comments and numbers; `--empty` keeps only a
  finished onboarding. The preview runs with fake networks and TLS off ([web-app.md](../web-app.md)),
  GitHub reads from fixtures.
- **A pixel comparison per screen.** Each board was rendered with Playwright at its own size, the app
  route at the same size and state, and the two compared pixel by pixel (board, app and a diff in
  red side by side). A screen passed when the only differences left were real data: other names,
  numbers, text lengths or row counts. Every screen was checked twice: in its section, and again
  after all sections were merged.

## Results

All 78 entries pass (76 screens, the top bar and the bottom bar). The table is the second check, on
the merged branch; the percentage is the share of pixels that differ, almost all of it real data.

| Screen | Route or state | Result | Diff % | What the rest is |
|---|---|---|---|---|
| LaunchDetail | /launches/2 | PASS | 3.68 | real numbers, chart shape, likes as the lead figure where a network has no views |
| LaunchMenu | /launches/2, ⋯ | PASS | 3.60 | the page behind the scrim |
| PostEdit | Mastodon edited | PASS | 30.12 | Bluesky cannot be edited, so Mastodon (longer real text); "what changes" is a word count |
| Unpublish | menu → Unpublish everything | PASS | 13.88 | real per-network notes shift rows |
| LaunchSearch | ?tab=search | PASS | 7.37 | one Google row in the seed; no canonical data |
| LaunchDetails | ?tab=details | PASS | 4.77 | real sources and jobs |
| DeleteLaunch | menu → Delete | PASS | 16.39 | real deletion plan adds Blog and dev.to rows |
| LaunchDrafting | /launches/5 | PASS | 3.31 | one real job instead of three stages (no stage data) |
| LaunchFailed | /launches/3 | PASS | 6.33 | real problem text one line shorter |
| Main | / | PASS | 13.16 | 5 attention items in the seed (extra row), real card order and times |
| TopBar | /, top 64 px | PASS | 0.21 | badge count |
| BottomBar | /, bottom 76 px | PASS | 0.00 | — |
| LaunchesEmpty | / (empty seed) | PASS | 0.20 | anti-aliasing |
| LaunchFilters | Filters sheet | PASS | 18.62 | the real facets have more chips |
| ChannelPeek | a card's Bluesky mark | PASS | 36.73 | board's page behind is another scroll state; one post in the seed; number families only |
| Notifications | bell | PASS | 14.56 | extra real row; "in 1 h" instead of a weekday time |
| SearchPalette | search | PASS | 19.35 | the board's three chips are the prototype's demo state switchers, not product UI |
| Toasts | three toasts raised | PASS | 1.83 | anti-aliasing |
| Tour | first stop | PASS | 18.20 | the ring wraps the real card, so the tour card sits lower |
| DesktopHome | / at 1440 | PASS | 6.27 | extra real row in Also needs you |
| Channels | /channels | PASS | 4.78 | real accounts, numbers and problem text |
| ChannelsEmpty | /channels (empty seed) | PASS | 2.04 | no .env credentials, so no import notice (checked separately) |
| AddNetwork | Connect | PASS | 20.33 | real network order; kind chips added so the sheet doesn't overflow |
| ChannelConnect | /channels/hashnode | PASS | 16.32 | another network's real how-to and fields |
| ChannelNetwork | /channels/linkedin | PASS | 16.49 | real problem text; no LinkedIn app configured → notice instead of Continue (matches with an app) |
| ProfileReview | /channels/linkedin?review=3 | PASS (backend limits) | 7.15 | no Dismiss (no backend), LinkedIn cannot be edited → Copy instead of Apply |
| AccountMenu | ⋯ on Bluesky | PASS | 4.24 | the real list behind the sheet |
| Disconnect | menu → Disconnect | PASS | 7.19 | the real list behind the sheet |
| DesktopChannels | /channels at 1440 | PASS | 3.47 | 5 real accounts |
| Comments | /comments | PASS | 0.61 | ages; "Automation is off." |
| CommentReply | /comments?reply=1 | PASS | 2.27 | real post text, the AI's note on the comment |
| SendConfirm | Send → sheet | PASS | 10.45 | the reply behind the sheet instead of the inbox |
| CommentsEmpty | /comments, nothing waiting | PASS | 0.14 | tab counts |
| CommentFilters | Filters sheet | PASS | 1.69 | count of the current tab |
| ReplySettings | Replies per channel sheet | PASS | 34.51 | a fourth real channel (Threads) and a Telegram note make the sheet taller |
| DesktopComments | /comments at 1440 | PASS | 6.34 | longer real text; a Filters button (the desktop board has no way to filter) |
| LaunchReview | /launches/4 | PASS | 8.32 | no time set in the seed, real reasons |
| LaunchContent | /launches/4?tab=content, two approved | PASS | 8.55 | seed texts; no media in the seed |
| LaunchSchedule | Another day sheet | PASS | 19.28 | November 2026 has a sixth week |
| LaunchPreview | /launches/4/preview | PASS | 12.40 | real article; no launch image or site preview in the seed |
| DraftEditor | /launches/4/edit?draft=linkedin | PASS | 3.12 | real cap and text |
| CodeCheck | …&check=1 | PASS | 0.15 | anti-aliasing (AI answer stubbed: no AI in the preview) |
| DesktopLaunchReview | /launches/4 at 1440 | PASS | 3.87 | as LaunchReview |
| DesktopDraftEditor | edit at 1440 | PASS | 9.10 | real text; the shared chat card adds close, an about line and the Enter hint |
| SettingsGeneral | /settings (+ an edit) | PASS | 7.11 / 8.26 | real unset app fields; the file secret store's name |
| SettingsAI | /settings/ai | PASS | 12.53 | a third real provider, 20 prompts, Profile review keeps its controls |
| DesktopSettings | /settings/ai at 1440 | PASS | 4.31 | real prompt rows; the save bar sticks to the window bottom |
| PromptEditor | /settings/ai/prompts | PASS | 9.45 | real prompt names and versions |
| SettingsAutomation | /settings/automation (+ toggle) | PASS | 6.73 / 8.18 | 2 real rules, no rounds yet |
| Webhooks | /settings/automation/webhooks | PASS | 4.94 | one stored delivery; the mode/interval card kept below |
| RotateSecret | Webhooks → Rotate | PASS | 8.67 | Webhooks behind the sheet |
| SettingsAPI | /settings/api | PASS | 4.20 | one real token, WebMCP off |
| TokenCreated | create a token | PASS | 10.43 | the real token is longer |
| MoreSheet | / → More | PASS | 20.90 | the real page behind the scrim; the owner's photo instead of an initial |
| Login | /login signed out | PASS | 0.03 | anti-aliasing |
| LoginExpired | /login?next=…&was=… | PASS | 0.19 | the real page name |
| DesktopLogin | /login at 1440 | PASS | 0.00 | — |
| Onboarding | ?step=brand/ai/channels/measure/automation | PASS | 12.3 / 5.5 / 7.3 / 6.1 / 6.7 | real networks, accounts and settings; a preview-only GitHub 401 notice |
| OnboardingBrandYml | "Show it" sheet | PASS | 20.0 | the real page behind the sheet; real YAML |
| OnboardingDone | ?step=end | PASS | 0.14 | anti-aliasing |
| NotFound | /nothing-here | PASS | 0.20 | badge counts |
| ErrorState | forced loader failure | PASS | 0.69 | badges (the bell's request fails too) |
| Offline | browser offline / server unreachable | PASS | 1.09 / 1.84 | lead text: nothing saves on its own, so it says the text is kept here |
| StatsOverview | /stats (+ 7 days/Reactions, + by channel) | PASS | 11.95 / 14.94 / 12.01 | real KPIs ("new": no earlier period in the seed); a filters chip added to reach filters on a phone |
| StatsRanking | ?tab=ranking | PASS | 5.74 | real titles; the score is the engine's ratio, not 0–100 |
| StatsAccounts | ?tab=accounts | PASS | 7.11 | real accounts |
| StatsSearch | ?tab=search | PASS | 5.67 | no Search Console numbers in the seed |
| StatsEmpty | /stats (empty seed) | PASS | 0.31 | badge counts |
| StatsFilters | sheet, Custom | PASS | 5.38 | real channel list |
| DesktopStats | /stats at 1440 | PASS | 3.46 | real data; a "More numbers" card below |
| LaunchRepo | /launch?repo=yeyo11/pando | PASS | 8.4 | the engine's real check wording |
| LaunchRepoBlocked | /launch?repo=yeyo11/pando-ui | PASS | 6.1 | the engine's real check wording |
| LaunchSources | /sources, two sources added | PASS | 3.1 | real connected channels |
| Write | /write filled | PASS | 1.8 | real word count |
| AssistMenu | selection → Assist | PASS | 8.7 | real page behind; "Check against the repo's code" disabled (an article has no repo) |
| AssistProposal | Improve | PASS | 3.3 | the real word diff |
| AssistChat | chat, a message sent | PASS (one behaviour) | 5.7 | while an answer streams the send button is Stop (it cancels); the board draws the idle Send |
| DesktopWrite | /write at 1440 | PASS | 6.0 | real chips and word count |

## What the board shows that the backend does not back

Built against what exists, never faked:

- A drafting launch has no progress fraction or stages: the bar is indeterminate and the line is the
  draft job's last log line. Jobs have no steps or durations.
- The launch filters' "Kind" (release or article) and "Started by" do not exist; the sheet offers the
  real facets (pack kinds, triggers).
- A card's channel peek has number families (views, reactions, comments, clicks), not each network's
  own names.
- The bell's scheduled line says "in N h", not a weekday and time: attention has no timezone.
- Search engine results carry no canonical address.
- Posts held up by a broken account are not counted; a profile proposal cannot be dismissed;
  LinkedIn has no follower count and no profile edits (the review offers Copy).
- Stats' score is the engine's ratio (1 is a typical piece), not 0 to 100.
- Only the last webhook delivery is stored; claudio has no reachability probe.
- The engine approves a whole launch: the per-piece ticks are kept in the browser until "Approve"
  approves it. The last check against the code is not stored.
- Offline, nothing saves on its own: the offline page says the text is kept on the page until the
  connection is back, not that it saves.
- An article written on Write has no repo, so "Check against the repo's code" is off there.

## Deliberate differences

- The search palette leaves out the board's three chips ("Everything", "Type la", "Type set"): they
  switch the prototype's demo state.
- While the assistant's answer streams, the chat's send button is Stop.
- A few additions the board has no place for but the behaviour needs: a filters chip on the phone
  Stats overview, a Filters button on desktop Comments, the network kinds in Connect, the mode and
  interval card on Webhooks, "Also change the link and image" when editing a post.

## Changes in behaviour

- A launch that fails before anything goes out is now a line in what needs the owner.
- A launch Shipcast holds no longer says its drafts are in a pull request.
- New routes: `/launches/<id>/preview`, `/settings/ai/prompts`, `/settings/automation/webhooks`, and a
  not-found page inside the shell.

## After the first look in production (2026-11-01)

The owner found the Launches grid noisy: cards of very different heights, and launches that never
went out shown like the ones that did. Changed:

- **Cards** only for launches that are drafting, have a piece out (live, edited or scheduled) or
  have numbers. Their channel marks stay on one row, at most six (fewer when the card is narrower),
  problems first and the rest behind "+N", which opens one sheet listing them; the cards of a grid
  row are the same height, numbers and marks on their bottom edge.
- **Not published**: launches never launched, or with nothing out and no numbers, are one-line rows
  (title, version, repo or "Article", date, state) under the cards, three shown and the rest behind
  "Show all N"; search and filters apply to both groups. Articles show their stored title, read for
  the whole page in one query, the slug only when there is none.
- **A failure shows once**: a launch that failed before anything went out is a card only when what
  needs the owner does not already list it.
- **A row's ⋯ menu**: "Launch it again" for a release that failed before anything went out, and
  "Delete" (the launch page's delete sheet) with `launch-delete` on. A failed line in what needs the
  owner offers Delete only when nothing of that launch went out, so deleting from a warning never
  hides a published launch.
- **Network marks drawn whole**: the glyph table kept one path per icon and every screen filled it,
  so the newsletter showed as a chevron and Threads as a blob. It now keeps each icon's shapes and
  whether it is a line, and one component (`components/kit/NetworkGlyph.tsx`) draws every mark.

## Overlays on a desktop

Until 2026-11-01 every overlay was the phone's bottom sheet at every width, full width or a 560 px
column on a desktop; the owner found it ugly. Now one component, `components/kit/Overlay.tsx`, has a
`kind`, and the shape follows the window's width (`usePhone`, `matchMedia('(max-width: 959px)')`,
never the kind of pointer):

| Kind | Below 960 px | From 960 px (boards) | Used for |
|---|---|---|---|
| `menu` | bottom sheet | a 280 px menu card hung from its button, right-aligned (DesktopLaunchMenu); arrows, Home and End move between items | the launch's ⋯, "Edit what went out", a launch row's ⋯, an account's ⋯ |
| `drawer` | bottom sheet | a 440 px panel from the right, full height, scrim, its own title and round close, the body scrolling between a fixed header and footer (DesktopDrawer); `wide` makes it 720 px (never closer than 240 px to the left edge) | filters (Launches, Stats, Comments), replies per channel, connect a network, claudio, spend limits, rule editor; wide: edit a post, edit several, prompt preview, locked rules, last round, work in progress, add brand.yml |
| `dialog` | bottom sheet | a 480 px card, 200 px from the top, answers on the right (DesktopConfirm); never wider | delete a launch, unpublish, disconnect and rename an account, send a reply, the settings' confirmations and the secret shown once, a profile change |
| `popover` | bottom sheet | a 420 px card hung from what it is about | the bell, a channel's mark and "+N", the schedule and Move picker, the onboarding's languages, the day picker |

The content is the same in every shape: `heading` is the sheet's and the dialog's big title, the
drawer's header; `footer` holds the closing actions; what only the sheet needs (its own heading in a
menu, a Close button) carries `k-sheet-only`. A menu or popover opened from code hangs from the
element given as `anchor`, or from what had the focus when it opened, and gives the focus back to
it. Full-page editors (the drafts, the prompts, Write) stay pages.

The launch page's menu (`components/launch/launch-menu.ts`) offers "Launch it again" whenever
`canRelaunch` holds, on any tab, "The job's log" and "Copy the error" for a failed launch, and Delete
behind `launch-delete`; with nothing to offer there is no ⋯. On a desktop "Launch it again" is the
yellow button beside the ⋯ (unless the failed card already shows it) and the menu leaves it out.

No native control is left: the selects are the kit's `PickerSelect` / `PickerCombobox` (a chip on
the Launches desktop filters), the days `ui/DatePicker` and the times `ui/TimeField`, both in the
kit's look; the older `ui/Menu` wears the kit's menu card. `color-scheme` follows the theme for
whatever the browser still draws.

## One column and no vertical scrollbars (2026-11-01)

- **One page column on a desktop.** The header and every page share a 1200 px column with 32 px
  sides, so the logo and each page's title start at the same left edge on every screen (`.k-page`).
  Narrow content (a form, the article preview) caps its own width but stays left-aligned in that
  column, never a smaller centred one. The launch page follows the board: "All launches", the title
  at 96 px with its version, its actions on the right. In the header the search field gives way first
  (down to an icon below 1120 px) so a section never slides under it.
- **Scrollbars.** No vertical scrollbar is drawn anywhere, in the page or inside a panel, menu or
  list; the wheel, touch and the keyboard still scroll. A horizontal one is hidden on a touch screen
  and kept on a desktop, thin, in the rail colour, with no arrow buttons. Chromium and Safari take it
  per axis through `::-webkit-scrollbar` (so no `scrollbar-width` is set there, which would switch the
  pseudo-elements off); Firefox has no per-axis control, so it hides both and a `.k-hscroll` row opts
  back in on a desktop. The rules are in `kit.css`, once.

## Related

[[web-app.md]] · [[plans/design-system.md]] · [[decisions/app-design-direction.md]] · [[status.md]]
