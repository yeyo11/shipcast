---
created_at: 2026-11-01T12:31:22.982046474Z
updated_at: 2026-11-01T12:31:22.982046474Z
tags:
    - decision
    - mcp
    - api
    - parity
---
# Decision: every API operation has an MCP tool, in the same change

Taken on 2026-11-01, when the MCP server caught up with the REST API. The server
([mcp.md](../mcp.md)) had 11 tools for the 39 operations of `/api/v1` ([api.md](../api.md)): the
routes for stats, scheduling, comments, profiles, sources and launch deletion had arrived one batch
after another, and nothing made their tools follow. An agent could read a launch but not its numbers,
schedule nothing and answer no comment, although the API already allowed all of it. The batch added
the 30 missing tools, two routes the Stats page needed (`GET /stats/search` and `GET /stats/accounts`,
[stats.md](../stats.md)) and the rule below. How the server itself is built is in
[decisions/mcp.md](mcp.md).

## The rule

- **A REST operation and its MCP tool ship together.** A feature that is reachable in the app gets a
  route under `/api/v1` and a tool in `packages/mcp/src/tools/<area>.ts` in the same change. The
  steps are in [mcp.md](../mcp.md#parity-and-adding-a-tool).
- **A test enforces it.** `apps/web/test/mcp-parity.test.ts` compares the API's route table (`ROUTES`
  in `apps/web/src/server/api.ts`, every route whether its flag is on or off) with the `operations`
  each tool declares, and fails on an operation no tool calls. It also fails on a tool that declares
  an operation the API does not serve, and on a read-only tool that calls a write.
- **Exceptions are written down.** An operation a model must not or cannot use goes in the test's
  `EXCLUDED` list with the reason, and the test fails on an entry without one. The list is empty: no
  operation of today is one a model should be kept from, since the token's scopes and the tools'
  `confirm: true` already guard what writes.

While the tools were being written, a temporary `PENDING` list let the missing operations through,
each area removing its own block with its tools. It was deleted when the last one landed, so an
uncovered operation now has only those two ways out: a tool, or a reason.

## Why

- **The agent is a client like the pages.** The owner works with Shipcast through an AI client as
  much as through the app; an action only the pages can do sends them back to the browser for it.
- **Drift is silent.** A missing tool breaks nothing and no one notices, which is how 28 operations
  fell behind. A failing test at the moment a route is added is the only reminder that costs nothing
  to keep.
- **The tool is cheap once the route exists.** Each tool is one REST call
  ([decisions/mcp.md](mcp.md)): the route already checks the input, the scope and the refusals, so
  the tool is a schema, a description and a test.

Rejected: generating the tools from the OpenAPI document (it lacks what a model needs: what a call
costs, when to ask the user, which tool comes next), and a checklist in the docs alone (it did not
hold).

## Known gaps: the app's server functions without a route

The parity test sees only `/api/v1`. Some of what the app does is still only a server function of
the pages (`apps/web/src/server/*.functions.ts`), so neither the API nor the MCP server can do it.
They are left for a later batch, each one route first, then its tool:

- the attention list and its dismissals (`getAttention`, `dismissAttention`, `clearAttention`);
- an account's re-check, sync now and primary choice (`recheckAccount`, `syncAccountNow`,
  `makePrimary`);
- a launch's drafts: reading them again from GitHub (`refreshDrafts`), editing one (`saveDraft`) and
  the site preview (`previewOnSite`);
- publishing a whole launch again (`publishAgain` without a channel; one channel is
  `retry_channel`);
- the repos and releases to launch from, and the pre-flight alone (`listRepos`, `listReleases`,
  `checkRepo`);
- the automation settings and a round run now (`getAutomation`, `saveAutomation`, `saveTriggers`,
  `runRoundNow`);
- the AI settings and prompts (`getAiSettings`, `saveAiSettings`, `saveAiPrompt`,
  `restoreAiPrompt`, `previewAiPrompt`);
- applying one profile proposal or the brand picture (`applyProfileProposal`,
  `applyBrandPictureNow`; `edit_profile` sets the fields directly).

Some server functions stay out on purpose: signing in, the API tokens, connecting and disconnecting
accounts (credentials go into the keychain through the app), onboarding and the WebMCP toggle.

## Related

[[mcp.md]] · [[decisions/mcp.md]] · [[api.md]] · [[stats.md]] · [[decisions/api-tokens.md]]
