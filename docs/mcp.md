---
created_at: 2026-10-25T19:31:14.30492503Z
updated_at: 2026-10-25T19:31:14.30492503Z
tags:
    - mcp
    - api
    - reference
    - phase-11
    - webmcp
---
# The MCP server

Added on 2026-10-25 (milestone 7 of the [goal](plans/goal-after-mvp.md), phase 11 of
[plans/after-mvp.md](plans/after-mvp.md)): Shipcast's tools for AI clients, over the
[Model Context Protocol](https://modelcontextprotocol.io). One package, `packages/mcp`, serves them
two ways: **`shipcast mcp`** over stdio for a client on any machine, and **`/mcp`** over Streamable
HTTP, served by the app. Both call the [REST API](api.md), so a client can do exactly what its token's
scopes allow and nothing the app would refuse. **WebMCP**, the same tools offered to an agent in the
browser, is an experiment, off by default. Why it is built this way is in
[decisions/mcp.md](decisions/mcp.md).

## Connecting a client

### 1. A token

Every client needs an API token with both scopes. Make one in the app's **API** page (`/tokens`), or
on the machine the app runs on:

```bash
pnpm shipcast token create "Claude Code on my laptop" --scopes read,write
```

It is printed once; only its hash is kept. Revoke it there (or `pnpm shipcast token revoke <id>`)
when the client goes. A `read`-only token works too: the tools that start work then answer that the
token lacks the `write` scope.

### 2a. Claude Code, over stdio

From a checkout of Shipcast (`pnpm install` done), on any machine that reaches the app:

```bash
claude mcp add shipcast \
  -e SHIPCAST_API_URL=https://your-shipcast.example \
  -e SHIPCAST_API_TOKEN=shipcast_12_... \
  -- pnpm --silent --dir /path/to/shipcast shipcast mcp
```

`--silent` matters: stdout is the protocol, and pnpm would otherwise print its script banner there.
`SHIPCAST_API_URL` is the app's origin; on the machine the app runs on it can be left out, and
`shipcast mcp` reads `SHIPCAST_PUBLIC_URL` from that checkout's `.env` (that variable alone).
`--url` and `--token` override the environment, but a token on the command line shows in the process
list, so the environment is better.

### 2b. Claude Desktop and other stdio clients

The same command in the client's configuration:

```json
{
  "mcpServers": {
    "shipcast": {
      "command": "pnpm",
      "args": ["--silent", "--dir", "/path/to/shipcast", "shipcast", "mcp"],
      "env": { "SHIPCAST_API_URL": "https://your-shipcast.example", "SHIPCAST_API_TOKEN": "shipcast_12_..." }
    }
  }
}
```

### 2c. Over HTTP, without a checkout

A client that speaks Streamable HTTP connects to the app itself:

```bash
claude mcp add --transport http shipcast https://your-shipcast.example/mcp \
  --header "Authorization: Bearer shipcast_12_..."
```

The app must be reachable from the client: today the app answers only on the owner's tailnet
([web-app.md](web-app.md)), so this works from the owner's devices, and from anywhere once the app is
on a server.

## Tools

| Tool | Scope | Hints | Does |
| --- | --- | --- | --- |
| `list_launches` | read | read-only | `GET /launches`: newest first, `limit`, `cursor`, `status` |
| `get_launch` | read | read-only | `GET /launches/{id}`: posts (with their ids), failures, numbers, index status, drafts summary |
| `launch_repo` | write | open world | `POST /launches`: `repo`, `ref`, `direct`; a release launches once |
| `approve_drafts` | write | open world | `POST /launches/{id}/approve`: merges the drafts pull request, then publishes |
| `write_article` | write | open world | `POST /articles`: `title`, `markdown`, `lang`, `channels`, `direct` |
| `retry_channel` | write | open world | `POST /launches/{id}/retry/{channel}` |
| `list_accounts` | read | read-only | `GET /accounts`, without secrets |
| `list_jobs` | read | read-only | `GET /jobs`: follow the work the write tools start |
| `get_capabilities` | read | read-only | `GET /capabilities`: what each channel can edit or delete |
| `edit_post` | write | destructive | `PATCH /posts/{id}`: `text`, `title`, `tags`, `link`, `image_url`, `image_alt` |
| `delete_post` | write | destructive | `DELETE /posts/{id}`; deletes nothing unless `confirm: true` |

The arguments are Zod schemas (`packages/mcp/src/tools.ts`) checked before the API is called, and the
descriptions tell the model what a call costs: the write tools publish in public and ask it to confirm
with the user first. `stats_overview`, `schedule_post` and `recommend_times` come when their routes
reach the API.

A write that starts work answers the job, with a note to follow it with `list_jobs`. A failure is a
tool error (`isError`) whose text is the API's message, its status and code, and what to do next:
`401 unauthorized` says how to make a token, `403 insufficient_scope` to use `read,write`, `409
refused` not to retry as it is, `429` how long to wait, an unreachable app to check
`SHIPCAST_API_URL` (`packages/mcp/src/errors.ts`). The token never appears in a message: the client
removes it from anything it shows.

**Resources**: `shipcast://launches` (the latest 20) and `shipcast://launches/{id}` (one launch,
listed for the latest). **Prompts**: `launch_checklist` (`repo`, `ref`: from checking it was not
launched to the approved, published posts, step by step) and `announce_release` (`repo`, `ref`,
`lang`: an article written with the user, true to the code, then `write_article` to drafts).

## The HTTP endpoint

`/mcp` (`apps/web/src/routes/mcp.ts`, over `createMcpHttpHandler` in `packages/mcp/src/http.ts`):

- **Bearer only, the API's tokens.** The token is checked before MCP starts (`checkBearer` in
  `apps/web/src/server/api.ts`): the same hash, revocation and limit on wrong tokens as `/api/v1`,
  one shared limit for both. Then each tool calls the API **in-process** with the caller's own
  `Authorization` header, so every call gets the route's scope check, with no network hop.
- **Stateless.** Every request gets a fresh server; nothing is kept between requests. It serves the
  2026-07-28 protocol and, for older clients, the 2025 one statelessly (a `GET` or `DELETE` session
  call answers 405).
- **Never the cookie.** Like `/api/v1`, `/mcp` is left out of the session and same-origin middleware
  in `src/start.ts`; a request carrying an `Origin` other than the app's is refused (403), against
  DNS rebinding.

## WebMCP

[WebMCP](https://webmachinelearning.github.io/webmcp/) lets a page offer tools to an agent built into
the browser. `packages/mcp/src/webmcp.ts` (exported as `@shipcast/mcp/webmcp`) registers the **same
tools** on the browser's registry: the proposal's `document.modelContext.registerTool(tool, { signal })`,
or `navigator.modelContext` of early previews, each tool with its JSON Schema and WebMCP's hints
(`readOnlyHint`; `consequentialHint` for every tool that acts). It calls the same-origin `/api/v1` with
the owner's session cookie and the `x-shipcast-webmcp: 1` header.

Status on 2026-10-25: **experimental, off, and not mounted yet**. `mountWebMcp({ enabled })` is there
for the app's shell to call; it registers nothing unless `enabled` is true and the browser has a
registry, and `unmount()` takes every tool off again. The setting is `webmcp:enabled` in the registry
(`readWebMcp` and `writeWebMcp` in `@shipcast/runtime`), false by default; while it is off the API
refuses the cookie calls too, so turning the experiment on takes both the setting and the shell
mounting it.

## Checked

`packages/mcp/test/`: every tool's API call against a fake API (method, path, body), the schemas
refusing bad arguments before any call, `delete_post` without `confirm` and `edit_post` without a
field calling nothing, the error messages per code, an unreachable app, a non-JSON answer and the
token removed from messages; an MCP client and server over the SDK's in-memory transport (tools with
their annotations, resources, prompts); the HTTP handler through the SDK's Streamable HTTP client (a
tool run under the token, 401 for a wrong one, 403 for a foreign origin); and **`shipcast mcp`
spawned over stdio** against the fake API on a local socket. WebMCP: registration on a fake
`modelContext`, unmounting, the session and header on its calls, and a check that the module imports
nothing from Node. `apps/web/test/api.test.ts`: the WebMCP cookie rules and the `/mcp` bearer check.

Not yet run against the live app: that needs a token, which the owner makes after the merge (above),
then `claude mcp add` and a `list_launches`.

## Related

[[api.md]] · [[decisions/mcp.md]] · [[decisions/api-tokens.md]] · [[decisions/edit-delete.md]] · [[web-app.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]]
