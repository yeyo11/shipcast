---
created_at: 2026-10-24T13:31:37.712709647Z
updated_at: 2026-10-24T13:31:37.712709647Z
tags:
    - plan
    - stack
    - architecture
---
# Technical stack

Proposed on 2026-10-24, before the first package. The rule behind every choice: the platform first
(what Node 24 already ships), one well-known library where the platform falls short, and claudio's
choices where the problem is the same, so the two codebases read alike. Versions are the latest on
that date.

## Core, from the MVP

| Concern | Choice | Why |
| --- | --- | --- |
| Runtime | Node 24.22.1 LTS | Pinned in `.nvmrc` and pnpm's `useNodeVersion` |
| Language | TypeScript 7, strict, `noEmit` | Type-checks only; nothing is compiled |
| Running TypeScript | Node's native type stripping | Node 24 runs `.ts` directly (`process.features.typescript` is `strip`): no build step and no `tsx`. Requires erasable syntax only (no enums, no parameter properties): `erasableSyntaxOnly` in `tsconfig.base.json` holds it |
| Monorepo | pnpm workspaces | `packages/*` libraries, `apps/*` runnables |
| Tests | `node:test` + `node:assert` | Built in; HTTP is tested by injecting `fetch`, not by mocking libraries |
| Schemas and validation | Zod 4 (4.6) | One definition gives the TypeScript types, the runtime validation of `launch.yml` and of what the AI returns, and — through `z.toJSONSchema` — the JSON Schema handed to Claude so the content pack comes back in shape |
| `launch.yml` | `yaml` 2.9 | YAML 1.2, keeps line numbers for error messages |
| Storage | `node:sqlite` | Built in, as in claudio. The launch registry and metrics are rows; plain SQL with numbered migrations, no ORM. Settings stay in files |
| GitHub | `@octokit/rest` 22 | Polling releases on both accounts, and the drafts pull request (branch, tree, commit, PR), with pagination and rate-limit handling done right |
| Cloning repos to analyse | the `git` CLI | A shallow clone into `workspace/`, which claudio sees as `/workspace` |
| AI | claudio's REST API through `fetch` | A small typed client; claudio runs from `docker-compose.yml` ([claudio.md](../claudio.md)) |
| CLI | `node:util` `parseArgs` | `shipcast launch <repo>`, `shipcast watch`: a handful of commands need no framework |
| Engine process | one long-running `shipcast watch` | Polls every few minutes; a systemd user unit later. No queue, no broker, no Redis |
| Blog | Astro 7, static, on GitHub Pages | In `yeyo11/launches`; content collections for the articles in English and Spanish; deployed by the official Astro action on merge, which is what makes the merge publish |
| dev.to | its REST API through `fetch` | `canonical_url` pointing to the blog |

## Later phases

| Phase | Concern | Choice |
| --- | --- | --- |
| 2 | X, LinkedIn, Bluesky, Mastodon | Own connectors through `fetch`, or Postiz; the open question of the plan, decided in phase 2 |
| 2 | Notifications | Telegram Bot API through `fetch` |
| 3 | Demo GIFs | VHS for terminal tools, Playwright for websites |
| 3 | OG images and covers | Satori (JSX to SVG) and resvg (SVG to PNG): templates in code, filled with each brand's tokens |
| 4 | Dashboard | A small HTTP API and a web UI served locally behind Tailscale Serve; framework decided in phase 4 (claudio uses Fastify and React with Vite) |
| 6 | GitHub Action mode | A reusable workflow (`workflow_call`) running the same engine, with the Claude Code Action as provider |

## Packages

```
packages/schema      launch.yml, brand config, content pack: Zod schemas and JSON Schema export
packages/engine      triggers (polling, manual), launch registry, claudio client, pipeline
packages/connectors  one module per channel: blog (launches repo), dev.to, then the rest
apps/cli             the shipcast command
```

Each package has a `tsconfig.json` extending `tsconfig.base.json`, `typecheck` (`tsc --noEmit`) and
`test` (`node --test`) scripts, and exports its `src/index.ts` directly, since nothing is built.

## What was left out

- **tsx**, which claudio uses: Node 24 strips types natively, so it is one dependency less.
- **An ORM** (Prisma, Drizzle): a handful of tables does not need one, and `node:sqlite` needs no
  native build.
- **A job queue** (BullMQ, Temporal): one process polling on a timer is enough for a few launches a
  month; Temporal is precisely what makes Postiz heavy.
- **n8n**: rejected in the plan; the flow is versioned code.

## Related

[[plans/shipcast.md]] · [[claudio.md]] · [[decisions/mvp-scope.md]] · [[launch-yml]] · [[content-pack]]
