---
created_at: 2026-11-01T12:31:22.982046474Z
updated_at: 2026-11-01T22:58:48.483898323Z
tags:
    - decision
    - mcp
    - api
    - parity
---
# Decision: every API operation has an MCP tool, and every page action a route, in the same change

Taken on 2026-11-01, when the MCP server caught up with the REST API. The server
([mcp.md](../mcp.md)) had 11 tools for the 39 operations of `/api/v1` ([api.md](../api.md)): the
routes for stats, scheduling, comments, profiles, sources and launch deletion had arrived one batch
after another, and nothing made their tools follow. An agent could read a launch but not its numbers,
schedule nothing and answer no comment, although the API already allowed all of it. The batch added
the 30 missing tools, two routes the Stats page needed (`GET /stats/search` and `GET /stats/accounts`,
[stats.md](../stats.md)) and the first rule below. How the server itself is built is in
[decisions/mcp.md](mcp.md).

The same day a second batch closed the gap one level up: what the app could do only through a page's
server function (`apps/web/src/server/*.functions.ts`), neither the API nor the MCP server could. It
added 28 routes and their 28 tools (the attention list, accounts, profile proposals, drafts, repos
and releases, automation, AI settings and prompts; [api.md](../api.md#routes)) and the second rule.
Since then there are 69 operations and 69 tools.

## The rules

- **A page's action has a route, and the route a tool, in the same change.** A feature reachable in
  the app gets a route under `/api/v1` and a tool in `packages/mcp/src/tools/<area>.ts`. The steps
  are in [mcp.md](../mcp.md#parity-and-adding-a-tool).
- **The route runs the server function's own service.** A route and the server function it mirrors
  call the same function of `apps/web/src/server/<area>.server.ts` (`attentionApi`, `draftsApi`,
  `reposApi`, `automationState`, `aiApi`…); only the input checking and the answer's shape differ.
  Copying the logic into the route would let the two disagree.
- **Two tests enforce it.**
  - `apps/web/test/mcp-parity.test.ts` compares the API's route table (`ROUTES` in
    `apps/web/src/server/api.ts`, with every area module spread in) with the `operations` each tool
    declares. It fails on an operation no tool calls, on a tool that declares an operation the API
    does not serve, and on a read-only tool that calls a write. An operation a model must not use
    goes in its `EXCLUDED` list with the reason; the list is empty, since the token's scopes and the
    tools' `confirm: true` already guard what writes.
  - `apps/web/test/app-parity.test.ts` reads every server function from the source of
    `src/server/*.functions.ts` (importing them would pull TanStack Start in) and fails on one that
    `apps/web/test/app-parity.ts` does not classify. It also fails on an entry for a function that is
    gone, on an `api` entry naming an operationId `/api/v1` does not serve or naming none, on an
    `appOnly` entry without its reason, and on a server function written in a shape it cannot read
    (anything but `export const name = createServerFn(`, or one outside a `*.functions.ts` file, or
    two of the same name).

## The map and how to classify a new server function

`SERVER_FUNCTIONS` in `apps/web/test/app-parity.ts` has one block per area, as the route modules are
split, and an entry per server function, either:

- `{ api: ['<operationId>', …] }`: the routes that together do what the function does. Several when
  the page does in one call what a client does in two: `saveDraft` is `getDraft` and `editDraft`
  (the page edits what it read with the launch), `publishAgain` is `retryChannel` with a channel and
  `publishLaunchAgain` without, `getAiSettings` is `getAiSettings`, `listAiPrompts` and
  `listLaunches` (the page's picker). Two functions may share one operation: `clearAttention` is
  `dismissAttention` with every key the caller read.
- `{ appOnly: '<why>' }`: why no API client may do it.

A new server function goes at the end of its area's block. The default is a route: write it in
`apps/web/src/server/<area>-api.ts` over the function's service, its tool beside it, and name its
operationId. `appOnly` is for three cases only: it handles a credential or a secret (a credential
never comes through the API, in or out), it sets up the instance itself or the API's own ways in, or
it is the page's view state or the app's own first-run guide. "Nobody needs it outside the app" is
not a reason: the owner works through an AI client as much as through the pages.

While the routes were being written a temporary `PENDING` map let the missing functions through, and
the MCP test had one for operations; each area removed its own block, and both maps were deleted when
the last area landed, so an uncovered function or operation now has only those two ways out.

## What stays in the app, and why

- **Credentials and secrets**: `connectWithForm` and `disconnect` (an account's credentials go into
  and out of the keychain), `importEnv` (copies the `.env`'s credentials into the keychain),
  `saveClaudio` (claudio's token), `rotateWebhookSecret` (a new webhook secret, shown once to paste
  into GitHub). `get_automation` says whether a webhook secret is set and `get_ai_settings` whether
  each provider's credential is, never the values.
- **The instance and the API's own ways in**: `getSettings` and `saveSettings` (the instance's
  configuration, secrets among it), `listTokens`, `createToken` and `revokeToken` (a token never
  sees, mints or revokes the others, [decisions/api-tokens.md](api-tokens.md)), `getWebMcp` and
  `setWebMcp` (whether the API takes the owner's cookie: a token must not widen the API's ways in).
- **The session and the page**: `whoAmI` (the shell's signed-in login; the API takes a token, which
  has no session), `getBanner` (a banner closed, from a cookie).
- **The in-app writing assistant's chat**: `listAssistantSessions`, `loadAssistantSession`,
  `settleAssistantProposal`, `assistantCheckJob`. It is an AI client of the editor itself; an MCP
  client is an assistant of its own and edits a draft through `get_draft` and `edit_draft`.
- **Onboarding and the tour**: `getOnboardingState`, `getOnboarding`, `markStep`,
  `finishOnboarding`, `setOnboardingAside`, `answerTourOffer`, `listLaunchRepos`,
  `chooseLaunchesRepo`, `proposeBrand`, `createBrand`: the first-run guide sets the instance up
  ([decisions/onboarding.md](onboarding.md)); what it shows of each area is read through that area's
  own routes.

Gone with the pull-request path: `refreshDrafts` (reading a drafts pull request again) left main on
2026-11-01 with the launch model's flags ([decisions/launch-model.md](launch-model.md)), while its
route was being written; drafts are the launch model's rows now ([app-review.md](../app-review.md)),
so the route and its tool were dropped before they shipped.

## Why

- **The agent is a client like the pages.** The owner works with Shipcast through an AI client as
  much as through the app; an action only the pages can do sends them back to the browser for it.
- **Drift is silent.** A missing tool or route breaks nothing and no one notices, which is how 28
  operations, then 28 page actions, fell behind. A failing test at the moment a route or a server
  function is added is the only reminder that costs nothing to keep.
- **The tool is cheap once the route exists, and the route once the service does.** Each tool is one
  REST call ([decisions/mcp.md](mcp.md)): the route already checks the input, the scope and the
  refusals, so the tool is a schema, a description and a test.

Rejected: generating the tools from the OpenAPI document (it lacks what a model needs: what a call
costs, when to ask the user, which tool comes next), deriving the routes from the server functions
(their inputs and answers are shaped for one page, and some must never leave the app), and a
checklist in the docs alone (it did not hold).

## Related

[[mcp.md]] · [[decisions/mcp.md]] · [[api.md]] · [[stats.md]] · [[decisions/api-tokens.md]] · [[decisions/onboarding.md]] · [[app-review.md]] · [[decisions/launch-model.md]] · [[status.md]]
