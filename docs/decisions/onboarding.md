---
created_at: 2026-10-26T09:21:40.555762039Z
updated_at: 2026-10-26T09:21:40.555762039Z
tags:
    - decision
    - web-app
    - onboarding
    - tour
    - phase-7
---
# The onboarding and the tour

Built on 2026-10-26 for milestone 3 of the [goal after the MVP](../plans/goal-after-mvp.md), in the
direction the owner approved ([decisions/app-design-direction.md](app-design-direction.md)): a
**centred wizard** on the first sign-in, one step per screen, and an **optional tour** offered when
the onboarding ends. It is the setup wizard the old phase 6 called for: what `.env` used to hold beyond
the bootstrap ([decisions/github-app.md](github-app.md)) is set here.

## Five steps

| Step | What it sets | Done when |
| --- | --- | --- |
| Brand and blog | The launches repo, chosen from the GitHub App installation's repos (with a search), and its `brand.yml`: validated, or created minimal by a commit through the App, the file shown as a diff before anything is written | The repo's `brand.yml` is valid |
| AI provider | claudio's address and token, an Anthropic key or an OpenAI-compatible server, with a connection test | Every AI task's provider is ready |
| Channels (optional) | Links to each network's connect flow, showing which are connected | A publishing account is connected |
| Measurement (optional) | Search Console, Bing Webmaster Tools, Cloudflare Web Analytics | A measurement account is connected |
| Automation | The mode and interval of the rounds | A mode is saved, or the install has launched before |

Each step uses the existing flows (Settings, Channels, Automation) and server functions.

## The centred wizard

Chosen on 2026-10-26 by the owner from three mock-ups (steps down the left, centred wizard, a checklist
inside the app), over the first version's two-column screens with a five-label stepper, which were
cramped and floated the form mid-page.

- **One step per screen** in a centred column (about 560 px): the step's Onboard illustration, small,
  "Step n of 5", the poster title, a one-sentence lead, the step's form. The form starts near the top
  of the screen, never centred in empty height.
- **A thin yellow progress bar** in the top bar (`role="progressbar"` with its values) replaces the
  stepper. On a phone it takes a row of its own under the lockup.
- **One primary button**: **Continue**, **Finish** on the last step. It runs the step's own save (the
  launches repo and its `brand.yml` check, claudio's address and token or the provider picked, the
  automation mode), then reads what is configured fresh: the step is done when it is detected;
  an optional step left empty is skipped; a required step that is still missing stays, saying what is
  missing. Each step is one form, so Enter in a field is Continue. A provider chosen here takes every
  AI task; a per-task choice that already works is left alone.
- **Back** as a secondary button from step 2; **Skip this step** as a quiet text link only on the
  optional steps; **Finish later** as a text link in the top bar sets the onboarding aside.
- Works at 320 px, keyboard focus visible, the bar's movement off under reduced motion.

## A state that never gets in the way

- The state lives in the `settings` table (`onboarding:state`): each step pending, done or skipped.
- On every sign-in **what is configured is detected and marked done**. An install set up before the
  onboarding existed (the owner's) has its steps done already and is never walked through, blocked or
  reset.
- It **opens by itself only for a new install** (no launch yet and no brand). Anyone else opens it from
  Settings, under **Finish setting up**, which lists what is left.
- A stored state is read defensively, so an older or broken row never breaks the app.

## The tour

[NextStep](https://nextstepjs.com) drives a tour of a few steps across Launches, a launch's page,
Write and its assistant, Channels and Automation, on a Cartel card, crossing pages through a
navigation adapter for TanStack Router. It is offered when the onboarding ends (taken or declined,
remembered), and can be started again any time from the user menu or the command palette (**Take the
tour**). Keyboard accessible, and without motion for anyone who asks the system for reduced motion.

### The card

- **The pointer is part of the card**: a notch on the card edge facing the target, in the card's own
  fill and outline, drawn by Shipcast from the side NextStep resolves (`notchFor` in
  `components/tour/steps.ts`, tested for every side). NextStep's own caret is not used: it centres on
  the target, which for a full-width page title put it at the card's far corner, over the text. For a
  card aligned to the target's left the notch sits near the card's left end, over the target's start.
- Targets stay small enough for the card to fit on screen: the Write step points at the page title,
  not the form, and the assistant step at the chat's header, not the whole panel. A target hidden
  under the phone's bottom bar is scrolled into view, since NextStep counts it as visible.
- **Skip the tour** is a plain underlined text link: text buttons (`.btn-link`) have no background
  anywhere in the app, without which the browser paints a grey box.

## Related

[[decisions/app-design-direction.md]] · [[decisions/github-app.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[accounts.md]]
