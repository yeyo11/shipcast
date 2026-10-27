---
created_at: 2026-10-25T20:03:17.775522423Z
updated_at: 2026-10-27T17:29:29.401059953Z
tags:
    - decision
    - mcp
    - api
    - security
    - phase-11
    - webmcp
---
# Decision: the MCP server over the REST API

Taken on 2026-10-25, building milestone 7 of the [goal](../plans/goal-after-mvp.md) (phase 11 of
[plans/after-mvp.md](../plans/after-mvp.md): `shipcast mcp` over stdio, then remote over HTTP with a
token; WebMCP as an experiment). How to connect and the tools are in [mcp.md](../mcp.md).

## Every tool is one REST call

The tools call `/api/v1` ([api.md](../api.md)) instead of the engine and the registry directly.

- **One set of rules.** The API already checks the input with the pages' own functions, refuses a
  second launch of a release, scopes each route and maps the engine's refusals to codes. A tool that
  went to the engine would need all of it again, and the two would drift.
- **Any machine.** `shipcast mcp` holds no database, keychain or `.env` secrets: the app's URL and a
  token are enough, so it runs on a laptop as well as on the app's machine. It starts before the CLI
  builds its runtime, so it needs no Postgres either.
- **The token's scopes are the client's.** A `read` token gives a client that can look and not
  publish, with no MCP-specific permission model.

Rejected: a server inside the app with the registry in hand (fast, but a second permission model and
a second set of checks), and generating the tools from the OpenAPI document (the descriptions a model
needs, "this publishes in public, confirm first", are not in it).

## The SDK's current major

`@modelcontextprotocol/server` and `@modelcontextprotocol/client` (dev) 2.4.0: v2 of the official
TypeScript SDK, its stable line, which replaces the single `@modelcontextprotocol/sdk` package of v1
and implements the 2026-07-28 protocol while still serving 2025-era clients. Its server package
depends only on Zod and the SDK's core (v1 brought Express and Hono), and it has the two serving
entries needed: `serveStdio(factory)` and `createMcpHandler(factory)`, a web-standard
`Request → Response` handler that a TanStack server route calls as it is. Tools are registered with
Zod 4 schemas, which the repo already uses, and the annotations `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`.

## stdio and HTTP

- **stdio** (`shipcast mcp`) is what Claude Code and Claude Desktop start as a child process, and it
  reaches the app over HTTPS like any client.
- **Streamable HTTP** at the app's `/mcp`, for clients that cannot run a checkout. It reuses the API's
  bearer check (`checkBearer`, sharing the API's limit on wrong tokens) and calls the API's handler
  in-process with the caller's `Authorization`, so it has the same tokens, scopes and errors with no
  network hop. It is stateless: a fresh server per request, nothing lost on a restart. OAuth, which
  the MCP specification describes for remote servers, was left out for the reason the API's tokens
  were chosen ([decisions/api-tokens.md](api-tokens.md)): one owner, who makes a token per client.
- **Destructive tools ask twice.** `edit_post` and `delete_post` are marked destructive;
  `delete_post` also refuses unless called with `confirm: true`, and its description tells the model
  to ask the user first. The schema allows `confirm: false` on purpose, so the model reads why nothing
  happened rather than a bare validation error.

## WebMCP: experimental, off, and the cookie only with a marker

[WebMCP](https://webmachinelearning.github.io/webmcp/) is a draft: on 2026-10-25 the registry is
`document.modelContext` with `registerTool(tool, { signal })`, after early previews put it on
`navigator`. The module (`packages/mcp/src/webmcp.ts`) accepts both and registers the same tool list,
so the browser's agent and an MCP client can do the same things.

A page in the owner's browser has the session cookie, not a token, and `/api/v1` refused cookies so
that no other site could make a signed-in browser call it. WebMCP's calls are let in with the cookie
only when all of these hold (`webMcpSession` in `apps/web/src/server/api.ts`):

- the request has no `Authorization` header and has `x-shipcast-webmcp: 1`: a page on another site
  cannot add a custom header without a CORS preflight, which the app never answers;
- `Sec-Fetch-Site` is `same-origin`, a header the page cannot set;
- the owner turned WebMCP on (`webmcp:enabled` in the registry, false by default);
- the session is valid. It then has both scopes, as the owner does in the pages.

Off is both halves: the app's shell does not mount the tools, and the API refuses the cookie path.

**The toggle and the mounting (2026-10-27).** *Settings › API* has a "WebMCP" checkbox
(`getWebMcp`/`setWebMcp` in `apps/web/src/server/webmcp.functions.ts`, over `readWebMcp` and
`writeWebMcp`). The `_app` loader reads the setting and `WebMcpHost` (`apps/web/src/components/WebMcpHost.tsx`)
mounts the tools while it is on: it imports `@shipcast/mcp/webmcp` only then, so the shell carries none
of the module while the experiment is off, and it unmounts them when the setting goes off or the shell
leaves. A browser without the proposal's registry gets nothing registered.

Rejected: a token kept in the page for WebMCP (a long-lived secret in the browser's JavaScript, for
an experiment), and opening the API to the cookie with the usual same-origin check alone (every
`/api/v1` route would then depend on it; the marker header keeps the change to WebMCP's calls).

## Related

[[mcp.md]] · [[api.md]] · [[decisions/api-tokens.md]] · [[decisions/edit-delete.md]] · [[web-app.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]]
