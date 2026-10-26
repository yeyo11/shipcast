---
created_at: 2026-10-26T07:46:24.02456459Z
updated_at: 2026-10-26T07:46:24.02456459Z
tags:
    - decision
    - web-app
    - ai
    - writing-assistant
    - phase-8
---
# The writing assistant

Built on 2026-10-26 for milestones 3 and 4 of the [goal after the MVP](../plans/goal-after-mvp.md), in
the direction the owner approved ([decisions/app-design-direction.md](app-design-direction.md)):
**both** quick actions on the selected text and a side chat for open requests, every proposal a diff
to accept or reject.

## Where it is

On **Write** and in each draft's editor (a launch's draft opens in its own page, beside the launch's,
so the editing surface stays apart from the launch's numbers and actions).

- **Selecting text** shows a small menu: improve, shorten, translate (English ↔ Spanish), propose
  titles (five), adapt to a network (with what that network's post may hold), and **check against the
  code**.
- **The chat panel** on the side (it closes to an icon) takes open requests about the text and the
  selection; a rewrite it proposes comes back marked as a proposal.
- **Every proposal is a diff**, word by word, with Accept and Reject. Insertions and deletions are told
  apart by more than colour, so the diff reads without seeing colour.

## What it may say

The same rule as the content pack: **the code is the source of truth**. Every assistant call ends with
locked rules ([decisions/ai-providers.md](ai-providers.md)): for a launch's draft, the text may only
claim what the launch's analysis found implemented; for an article written in the app, the article is
the source of truth and nothing is added to it. **Check against the code** reads the launch's repo
through the same grounding the pack uses; for a free article it is disabled, with the reason. The
brand's tone applies. AI cost is never shown.

## Streaming, and claudio today

The answers stream through the AI SDK's `streamText` for the `assistant` task, so a provider that
streams (the Anthropic API, an OpenAI-compatible server) shows text as it comes. claudio streams once
its OpenAI-compatible API exists; until then the assistant reaches claudio through its existing REST
chat API, where the whole answer arrives at once, and the page says so quietly. It works with the
owner's claudio today.

## Related

[[decisions/ai-providers.md]] · [[decisions/app-design-direction.md]] · [[content-pack.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[claudio.md]]
