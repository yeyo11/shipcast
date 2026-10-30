---
created_at: 2026-10-30T07:54:54.962156958Z
updated_at: 2026-10-30T07:54:54.962156958Z
tags:
    - launches
    - launch-model
    - triggers
    - github
    - flags
---
# Trigger rules: which GitHub events create a launch

Part of the seventh phase of [decisions/launch-model.md](decisions/launch-model.md) (card SHP-15),
built on 2026-10-30 behind the `launch-triggers` flag (off by default, and in production until it is
verified). With the flag on, **the owner's trigger rules decide which GitHub events create a
launch**, and a repo's `.github/launch.yml` becomes optional input. Without it, each repo's
launch.yml decides alone, exactly as before. Deleting launches is the other half of the phase:
[launch-delete.md](launch-delete.md).

## The rules

The rules are a setting (`triggers` in the `settings` table, a list), edited on Settings →
Automation under "Triggers" and saved with the rest of that form. They are settings-shaped, so a
setting rather than a table, as the research recommended and the project convention says. Each rule
(`TriggerRule` in `packages/schema/src/triggers.ts`) has:

| Field | Meaning |
| --- | --- |
| `id` | Stable, lowercase; two rules cannot share one |
| `enabled` | A rule turned off matches nothing |
| `event` | `release` (a release is published) or `public` (a repo goes from private to public) |
| `repos` | `*`, `owner/*` or `owner/name`, compared case-insensitively |
| `prereleases` | Whether a pre-release triggers too; none did before the rules |
| `channels` | For a repo **without** launch.yml: `null` leaves it alone (as before), a list of channels launches it on them, each waiting for approval |

An event takes **the first enabled rule it matches**, in the owner's order (`matchingRule`); no
match creates nothing. Until the owner saves rules, the defaults (`DEFAULT_TRIGGER_RULES`) are one
rule for releases and one for repos made public, every repo, no channels for repos without a
launch.yml: what launch.yml alone decided, so turning the flag on changes no outcome. Saving an
empty list means no event creates a launch. A stored rule a later schema refuses is dropped on
reading rather than voiding the whole list.

## launch.yml as optional input

`claimEvent` (`packages/engine/src/detect.ts`) is still the one way an event becomes a launch,
whether it came by webhook (`claimFromWebhook`) or by the poll (`detect`). With the rules:

1. No matching rule: ignored ("no trigger rule matches", or for a pre-release "a pre-release, which
   no trigger rule takes").
2. A repo **with** a launch.yml keeps its own channels, brand and pack, and can still say no for
   itself: `enabled: false`, `triggers.release: false` or `triggers.public: false` are honoured
   whatever the rule takes. A brand mismatch is refused as always (brands never mix).
3. A repo **without** one is ignored unless its rule names channels. Then the launch is claimed and
   **keeps the rule's channels as its own**: a launch.yml text with those channels on `approval`
   and every other `off` (`ruleLaunchYml`), stored as the launch's channel rows and
   `launches.channels_source` (`TriggerService.keepChannels`). `draftLaunch` reads launch.yml at
   the ref first and, when there is none, those kept channels (`PipelineDeps.triggers.channelsText`),
   so the draft, the review and publishing read them as they read a repo's own.

Rejected: a rule overriding a repo's own "no" (the repo's owner said no for that repo; the rule is
the brand-wide default), and per-channel modes in a rule (every channel a rule names waits for
approval; `auto` stays something a repo's launch.yml says).

Manual launches (`claimManual`, "Launch a repo") are unchanged: they still need a launch.yml, and
Action mode stays on launch.yml alone ([decisions/action-mode.md](decisions/action-mode.md)).

## Dedupe keys: a launch happens once

Under the rules every claim carries its dedupe key (`launches.dedupe_key`, unique, from the first
phase), built by `dedupeKeyOf`: `github-release:<repo>@<tag>` for a release,
`github-public:<repo>` for a repo made public. `LaunchRepository.claim` with a key conflicts on
either unique key, `(repo, ref)` or the dedupe key, and answers the launch already there. So:

- a second event of the same release (a webhook and then the poll, a redelivery, the workflow run
  again) is `already-claimed`;
- **a repo made public is one launch**, where before the webhook (`webhook-public-<repo>`) and the
  poll (the event's numeric id) made two refs and two launches; a characterisation test pins the old
  behaviour beside the new one.

With `launch-delete` on too, a release whose launch the owner **removed** is never launched again:
the claim asks `launch_deletions` for the key first (see [launch-delete.md](launch-delete.md)).

## Where it lives

| Piece | Where |
| --- | --- |
| The rule schema, defaults and matching | `packages/schema/src/triggers.ts` |
| Reading, saving and the kept channels | `TriggerService`, `packages/engine/src/services/triggers.ts` |
| The claim | `claimEvent`, `packages/engine/src/detect.ts` (options `triggers` and `removed`) |
| The draft without launch.yml | `draftLaunch`, `packages/engine/src/pipeline.ts` |
| Wiring | `createRuntime` builds the service with the flag and puts it on `PipelineDeps`; the round's detection and the webhook delivery job pass it to the claim |
| The page | `TriggerRules` on Settings → Automation (`apps/web/src/components/TriggerRules.tsx`), shown only with the flag; `getAutomation` / `saveTriggers` |

## Tests

`packages/engine/test/launch-triggers.test.ts`: today's double launch of a repo made public, the
defaults deciding as launch.yml did, a second event and a re-run claiming nothing, one launch for a
repo made public by webhook and poll, rules by event, repo, order and pre-release, a repo's own
"no", a removed launch's release, a repo with no launch.yml drafted on its rule's channels, the same
repo failing as before without the rules, and saving and reading the rules.
`packages/schema/test/triggers.test.ts`: patterns, matching and the schema.
`packages/runtime/test/runtime.test.ts`: the flag builds the service, and nothing without it.

## Related

[[decisions/launch-model.md]] · [[launch-delete.md]] · [[launch-yml.md]] · [[app-review.md]] · [[engine.md]] · [[server.md]] · [[decisions/action-mode.md]] · [[github-app.md]]
