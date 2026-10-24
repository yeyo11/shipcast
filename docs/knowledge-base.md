---
created_at: 2026-10-24T12:32:02.02174124Z
updated_at: 2026-10-24T12:34:50.427679951Z
tags:
    - knowledge-base
    - pando
    - convention
    - docs
    - search
---
# The knowledge base

What Shipcast knows about itself lives in two indexes that [pando](https://github.com/digiogithub/pando)
keeps beside the repo: the **knowledge base**, which is this `docs/` folder chunked and embedded, and
the **code index**, which is every source file parsed into symbols. Both answer semantic questions —
"where is a channel's publishing mode decided", "what did we decide about Postiz" — that a
`grep` cannot.

Neither is a second source of truth. The documents are the markdown files in this folder, tracked in
git and reviewed like code; the indexes are derived and disposable. They live in
`.pando/data/pando.db`, which is gitignored, so nothing here is committed and a lost database is one
re-index away.

## The rule

**Every new feature, every decision, and anything else worth remembering becomes a document here,
and goes into the knowledge base.** A decision that only exists in a chat transcript or a commit
message is a decision the next session will not find. Write it with pando's `kb_add_document`,
which stores it and writes the markdown under `docs/` (plans go in `docs/plans/`, decisions in
`docs/decisions/`), using the path the knowledge base already uses for this folder — `status.md`,
`plans/shipcast.md` — plus tags and links.

Search before writing. `kb_search_documents` says whether a document already covers the ground, and
updating it beats adding a second one that disagrees with the first.

The rule is stated in [CLAUDE.md](../CLAUDE.md) as well, because it travels with the repository: an
agent in a fresh worktree starts with none of the memory of the session that planned the work, and
CLAUDE.md is what reaches it.

## Search before answering

The other half of the rule, and the one that gets skipped. **Any question about this project is
answered by searching the knowledge base first** — what the project does, how a piece of it works,
where it stands, why something was decided, where something lives. `kb_search_documents` is the
first tool call of the turn, then `code_hybrid_search` when the answer is in the source rather than
in the prose. `git log` and opening the likely file come after, to verify what the search returned.

The failure mode is not forgetting the tools exist; it is deciding, question by question, that this
particular one is factual enough to answer straight from the repository. It never is: the
repository says what the code is, and the documents say what it means and why. So the trigger is not
a judgment about the question. Search unless the user named the exact file, unless you are after a
literal string or a known identifier — grep's job — or unless the turn is pure editing with nothing
asked. A search that returns nothing costs one call and rules out a whole folder.

A search that comes back empty on a question this folder should have covered is itself the finding:
the document is missing, and writing it is the rule above.

Prose alone does not hold — in claudio the first version of this rule was read and skipped — so a
`UserPromptSubmit` hook in [`.claude/settings.json`](../.claude/settings.json) states it again on
every prompt, where no judgment stands between reading it and acting. It is checked in rather than
left in `settings.local.json` so an agent in a fresh worktree gets it too, for the same reason the
rule is in CLAUDE.md. `/hooks` lists it; a session started before it existed needs that menu opened
once, or a restart, to load it.

## Write through the tools, not around them

Every document, new or changed, enters through `kb_add_document`, never through the REST upsert, a
plain file write or a file dropped for the watcher. The tool does three things the plain write does
not: it merges **front matter** into the file — `created_at` kept from the first version,
`updated_at` refreshed, and the `tags` passed with the call — it **mirrors the document back to
`docs/`** with that front matter, and it **indexes the `[[wiki links]]`**, answering with how many
were resolved and which targets nothing defines yet. Those dates and tags are what later filter and
rank a search; a document imported around the tools has none of them.

The content sent is the whole markdown body without front matter: pando strips any it is given and
writes its own. That front matter is rebuilt from the tags on every update, so anything else written
into it by hand — `aliases`, a status field — does not survive the next `kb_add_document`. Tags are
the durable metadata; keep them meaningful.

To change a document, read it (`kb_get_document` or the file), edit the body and send it whole: on an
existing path the tool keeps `created_at` from the row it already has, refreshes `updated_at`,
merges the tags and mirrors the file back. Unlike claudio, which edits its files and re-syncs,
Shipcast writes every change through the tool, so the dates and tags are always pando's.

A `PreToolUse` hook in [`.claude/settings.json`](../.claude/settings.json)
(`.claude/hooks/kb-through-pando.mjs`) holds the rule: a `Write`, `Edit` or `MultiEdit` on a
markdown file under `docs/` is blocked, and Claude is told to call `kb_add_document` instead, with
the path it should use. It blocks rather than reminds because a reminder after the write would come
with the file already on disk and its front matter wrong. If the pando tools are not available the
agent stops and says so, rather than writing the file by hand.

## The format every document follows

This is the file pando writes; what is sent is everything below the front matter.

```markdown
---
created_at: 2026-10-24T12:00:00Z
updated_at: 2026-10-24T13:00:00Z
tags:
    - deploy
    - operations
---
# Title

…the document…

## Related

[[status.md]] · [[plans/shipcast.md]]
```

The dates are the document's own history, for the reader. Pando strips the front matter before
storing a document and stamps its rows with its own times, so a search sorted by date sorts by when
the document reached the knowledge base. Tags are the metadata that does cross over — lowercase,
few, and filterable with the `tags` argument of `kb_search_documents`.

## Re-sync

The re-sync is for what reached `docs/` some other way — a bulk change, a pull, a file written
before the hook existed:

```bash
curl -sk -X POST -H "X-Pando-Token: $T" https://localhost:8765/api/v1/remembrances/kb/reindex
```

It is deterministic and idempotent — it answers with what it scanned, updated and linked, and a
second run reports everything unchanged. The file watcher does the same work on its own, but it
processes one document at a time and can be left behind by a bulk edit; the endpoint is how you
know. When the watcher is importing the same file at that moment the call can fail with
`UNIQUE constraint failed: kb_documents.file_path`; run it again, and the second run reports what is
left.

## Links, and which kind

The prose links with ordinary markdown, so the documents read correctly on GitHub, and each one ends
with a **Related** list of `[[wiki links]]`. That list is what pando indexes as a graph:
`kb_related_documents` walks outgoing links, backlinks and shared tags from it. The brackets are
visible on GitHub — that is the price of the graph, and confining them to one list at the end keeps
it cheap.

A wiki link to something that does not exist yet is not a mistake. It records a concept worth
writing about, and `kb_related_documents` with no arguments lists those wanted concepts, most
requested first: the queue for the next document.

A target resolves by path or by basename, so `[[status.md]]` and `[[status]]` both find `status.md`.
Pando can also resolve declared aliases, but do not rely on them here: they live in front matter,
and front matter is rebuilt from the tags on every update.

## The embedding server has to be up

Every embedding — documents through `qwen3-embedding:0.6b`, code symbols through
`jina-embeddings-v2-base-code` — is computed locally by an ollama-compatible server on
`127.0.0.1:11435` (on this machine, `alkahest`), as set by the `DocumentEmbedding*` and
`CodeEmbedding*` keys of `~/.pando.toml`:

```bash
curl -s 127.0.0.1:11435/api/tags     # lists the models when it is up
```

With it down, `kb_add_document` and every semantic search fail or come back empty, and an index job
started without it produces nothing. Being local, embedding costs time and never money.

## The code index

`code_hybrid_search` (by meaning) and `code_find_symbol` (by name) answer from a snapshot, not from
the working tree, and the snapshot does not follow later commits. Check it before trusting it:

```
code_get_project_stats(project_id: "home_yeyo_Escritorio_shipcast")
```

The project id is the repo path with separators replaced; `indexing_status` must be `completed`. The
index holds every source file except the contents of dotdirs, so neither `.github/` nor the worktrees
under `.claude/worktrees/`, nor `node_modules`, `dist` and `build`.

Leave `ContextEnrichmentCodeProject` empty in `~/.pando.toml`. That file is global, so an id set
there is applied to every directory pando starts in (claudio was once indexed under the id of
another project that way). Pando keeps the id a directory is already registered under, so a wrong
one has to be removed with `code_delete_project` before re-indexing; it does not correct itself.

Re-indexing needs an instance that outlives the request. A job started through the MCP server dies
when the Claude Code session that spawned it exits (and claudio starts a new `claude -p`, with a new
pando, on every turn of a chat), which leaves the project stuck at `in_progress`. What works is a
detached server, driven over its REST API:

```bash
cd /path/to/shipcast
setsid nohup pando serve > .pando/serve.log 2>&1 < /dev/null &   # HTTPS on 8765
T=$(curl -sk https://localhost:8765/api/v1/token | jq -r .token) # loopback only
curl -sk -X POST -H "X-Pando-Token: $T" -H 'Content-Type: application/json' \
  -d '{"path":"'"$PWD"'","project_id":"home_yeyo_Escritorio_shipcast"}' \
  https://localhost:8765/api/v1/remembrances/projects/index
```

Watch a pass with `GET /api/v1/remembrances/projects`, and stop the server when it says `completed`.
Port 8765 is shared with every other repo's detached server, so stop the one that is running before
starting this one.

Pando before 1.2.14 lets every instance index and watch the same tree at once, which corrupted
claudio's database on 2026-10-18; from 1.2.14 one instance is the primary and the others leave
indexing and watching to it. If a search fails with `database disk image is malformed`, stop every
pando, move `.pando/data` aside, and rebuild it with the detached server above plus the re-sync:
nothing in it is lost, because it is all derived from `docs/` and the source.

## How pando is wired in

Pando is an MCP server declared in [`.mcp.json`](../.mcp.json), speaking stdio, started by the
Claude Code CLI with the repo as its working directory:

```json
{ "mcpServers": { "pando": { "type": "stdio", "command": "pando", "args": ["mcp-server", "--no-http"] } } }
```

It is there for these two indexes and nothing else: fetch, browser, Context7 and the mesnada
orchestrator are off in `~/.pando.toml`, so the tool surface stays at the `kb_*`, `code_*` and
memory tools. Claude Code already has its own file, grep and shell tools, and a smaller surface
keeps context cheap.

Both databases are resolved **relative to the working directory** (`[Data] Directory =
'./.pando/data'`), so pando must always be started from the repo root. Started anywhere else it
opens an empty knowledge base and reports, truthfully and uselessly, that it knows nothing.

## Related

[[status.md]] · [[plans/shipcast.md]]
