---
created_at: 2026-10-26T07:46:15.924148029Z
updated_at: 2026-10-26T07:46:15.924148029Z
tags:
    - decision
    - web-app
    - onboarding
    - tour
    - phase-7
---
# The onboarding and the tour

Built on 2026-10-26 for milestone 3 of the [goal after the MVP](../plans/goal-after-mvp.md), in the
direction the owner approved ([decisions/app-design-direction.md](app-design-direction.md)):
**full-screen steps** on the first sign-in, one illustration each, skippable and resumable; and an
**optional tour** offered when the onboarding ends. It is the setup wizard the old phase 6 called for:
what `.env` used to hold beyond the bootstrap ([decisions/github-app.md](github-app.md)) is set here.

## Five steps

| Step | What it sets | Done when |
| --- | --- | --- |
| Brand and blog | The launches repo, chosen from the GitHub App installation's repos (with a search), and its `brand.yml`: validated, or created minimal by a commit through the App, the file shown as a diff before anything is written | The repo's `brand.yml` is valid |
| AI provider | claudio's address and token, an Anthropic key or an OpenAI-compatible server, with a connection test | Every AI task's provider is ready |
| Channels | Links to each network's connect flow, showing which are connected | A publishing account is connected |
| Measurement | Search Console, Bing Webmaster Tools, Cloudflare Web Analytics | A measurement account is connected |
| Automation | The mode and interval of the rounds | A mode is saved, or the install has launched before |

Each step uses the existing flows (Settings, Channels, Automation), with its Onboard illustration and
a progress line; **Skip for now** on every step.

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
Write, Channels and Automation, on a Cartel card, crossing pages through a navigation adapter for
TanStack Router. It is offered when the onboarding ends (taken or declined, remembered), and can be
started again any time from the user menu or the command palette (**Take the tour**). Keyboard
accessible, and without motion for anyone who asks the system for reduced motion.

## Related

[[decisions/app-design-direction.md]] · [[decisions/github-app.md]] · [[decisions/component-layer.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[accounts.md]]
