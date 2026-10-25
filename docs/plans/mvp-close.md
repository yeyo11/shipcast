---
created_at: 2026-10-25T09:38:38.404911126Z
updated_at: 2026-10-25T09:38:38.404911126Z
tags:
    - plan
    - mvp
    - roadmap
    - automation
    - webhooks
    - assets
    - playwright
---
# Closing the MVP

Decided on 2026-10-25 by the owner, after the [goal](goal-finish.md) and its checkpoint
([status.md](../status.md)). Three pieces of work close the MVP; then work moves to pull requests
([decisions/main-until-mvp.md](../decisions/main-until-mvp.md)).

## Decisions

| Topic | Decision |
| --- | --- |
| The brand | One: the owner, **josegarridodev** (José Antonio Garrido), already complete: the blog at josegarrido.dev, `yeyo11/launches`, its `brand.yml`, the Brevo newsletter and the connected accounts. The company brand of the founding plan (josegarridodigio) is dropped; accounts per brand stay, for whoever wants a second one |
| Automation | **Configurable in the app**: rounds on a timer, or GitHub webhooks secured by their HMAC secret; metrics and token refreshes keep their own periodic round either way |
| Where the app runs | A VPS or server, later; until then it runs on the owner's machine. Webhooks need the app reachable from GitHub, so they work once it is on the VPS |
| Phase 3 assets | **Playwright**: a demo GIF recorded from the deployed project, and screenshots of it |
| Phase 6 | **After the MVP**, as a step of a setup wizard: other AI providers through the Vercel AI SDK (claudio reached through its OpenAI-compatible API by the SDK's adapter, which claudio is building), the GitHub Action mode, documentation, a blog template and a one-command install. To iterate on later |

## 1. Rounds and webhooks in the app

- **One round, shared by the CLI and the app** (`@shipcast/runtime`): detect releases (when polling),
  publish what is ready, refresh every Instagram account's token when due (each account, not only the
  primary), read the metrics every 6 hours. `shipcast watch` and the app both run it.
- **The app runs it on its own**, from its start, so nothing depends on a terminal running `watch`.
- **Settings, in the app** (an Automation section): the mode (`poll`, `webhook` or `off`), the polling
  interval (at least 60 seconds, GitHub's own ask), and for webhooks the payload URL, the secret
  (generated, kept in the keychain, shown once, rotatable), the events to subscribe (`release`,
  `pull_request`) and the last delivery received.
- **The webhook endpoint** (`POST /api/github/webhook`): outside the session and same-origin checks,
  but every delivery must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the body with the
  secret, compared in constant time); `ping` answers, `release` with action `published` is claimed
  exactly as a detected release, `pull_request` closed and merged on the launches repo publishes its
  launch. Deliveries are idempotent through the registry, so a redelivery never posts twice.

## 2. Phase 3: assets from the deployed project, with Playwright

- `launch.yml` names the deployed project (`assets.site`) and, optionally, a short tour (scroll,
  click, wait) to record.
- Shipcast opens it in headless Chromium, takes **screenshots** (desktop and mobile) and **records the
  tour**, which ffmpeg turns into the **demo GIF** when the repo has none. Both go into the drafts pull
  request with the other media; the pre-flight check accepts a site in place of a committed demo.

## 3. Housekeeping before the switch

- `status.md`, the roadmap and the goal's outcome brought up to date.
- The rule to work on `main` ends; pull requests, squash-merged, come back.

## Related

[[plans/goal-finish.md]] · [[status.md]] · [[plans/shipcast.md]] · [[decisions/main-until-mvp.md]] · [[web-app.md]] · [[engine.md]] · [[publishing.md]] · [[launch-yml.md]]
