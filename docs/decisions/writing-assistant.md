---
created_at: 2026-10-26T16:39:23.13001651Z
updated_at: 2026-10-28T07:49:25.301811959Z
tags:
    - decision
    - web-app
    - ai
    - writing-assistant
    - phase-8
    - limits
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

## A network's cap

Added on 2026-10-28. A draft of a network with one capped text (Bluesky, Mastodon, Threads, Telegram,
Discord, LinkedIn) carries its cap into every quick action and chat turn: the system prompt says the
post itself, not the draft's heading and approval note, must stay within that many characters,
counted as the network counts them (`PIECE_LIMITS` in `packages/schema`: graphemes on Bluesky, an
emoji as its UTF-8 bytes on Threads), and to shorten what would not fit. Before this, **Improve** on
the REA article's Bluesky post proposed 305 characters, link included, which Bluesky refuses.

Saving is the net under it: `editDraft` refuses a channel draft past its network's cap with the
network, the cap and the length ("Bluesky takes at most 300 characters (the link included); this is
305"), so a post the network would refuse is caught before the merge instead of failing at
publishing time.

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

## Sessions and the history

Added on 2026-10-26. A chat is kept so it can be found and taken up again.

- **Saved as it streams, by the server.** The endpoint saves the owner's question before asking the
  model (so a session exists even if the answer fails), then the assistant's final text with its
  proposals (each `open`, `accepted` or `rejected`) when the stream ends, is stopped or fails (a failed
  one with why it stopped). A `saved` event hands the page the session and the answer's row. Saving
  never breaks the chat: a database that fails costs the history, not the answer. Quick actions are
  not saved; only chat turns.
- **Tables** `assistant_sessions` and `assistant_messages` (migration 0007, additive), with registry
  methods tested on PGlite. A session records the launch and draft file (none for an article on Write)
  and the draft's name as it was called; its title is the first question in a line, or the draft's name
  when the first turn had no words. A message keeps the selected passage the question was about, so
  its proposals can be applied again.
- **The history** is a button in the chat's header, beside **New session**. It lists sessions, the most
  recently talked in first, with title, draft and date, a page at a time by a keyset cursor (so new
  messages never shift a page): the next page loads when the end of the list scrolls into view, with a
  **Load more** button for anyone who cannot scroll. Choosing one restores the conversation with what
  was done with each proposal. Server functions check their inputs (`server/assistant.functions.ts`).
- **The Send button** is as wide as the form.

## On phones

At 760 px and under the chat is a **floating bubble** (bottom right, above the bottom bar, safe-area
aware) that opens the chat as a **full-screen sheet** (a Base UI dialog: focus kept inside, Escape and
the close button return to the bubble). The selection made in the text stays, so the chat still works
on it. New messages scroll into view **smoothly, only when the reader is already at the bottom** (the
owner's own question always does); Lenis drives only the page's scroller, so the chat's own scroller
scrolls natively, never animated under reduced motion. Messages carry avatars: the signed-in user's
GitHub picture on theirs, the Shipcast mark on the assistant's.

## Related

[[decisions/ai-providers.md]] · [[decisions/app-design-direction.md]] · [[content-pack.md]] · [[plans/goal-after-mvp.md]] · [[web-app.md]] · [[claudio.md]]
