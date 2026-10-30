---
created_at: 2026-10-30T03:13:28.72192183Z
updated_at: 2026-10-30T03:13:28.72192183Z
tags:
    - launches
    - sources
    - flags
    - security
    - ai
    - media
---
# Launches made from sources

Phase 6 of the launch model ([decisions/launch-model.md](decisions/launch-model.md)), built on
2026-10-30 behind the **`launch-sources`** flag, off by default and in production. A launch is no
longer only "a repo at a release": it can be made from **sources**, each a row of `launch_sources`
(migration `0018`, [engine.md](engine.md#the-launch-registry)):

| Kind (`launch_sources.kind`) | What | Read |
| --- | --- | --- |
| `repo_release` | the **primary** repo at a release tag: its release is the launch | cloned at the tag |
| `repo` / `repo_ref` | a further repo, at its default branch or a named ref | cloned |
| `url` | a page | fetched once by Shipcast when the launch is made, turned into Markdown |
| `text` | the owner's own words: notes, a draft, an opinion | as written |
| `media` | an uploaded image | listed for the analysis by name and alt text; the bytes stay in the [media store](media-store.md) |

With the flag off nothing of this runs: a launch is its one repo, `sources` in a launch.yml is parsed
and ignored, and the routes and the page below answer that they are off.

## Making one

One use case, `SourcesService.create` (`packages/engine/src/services/sources.ts`), reached from the
app's **Launch from sources** page (`/sources`, linked from Launch a repo when the flag is on) and from
`POST /api/v1/launches/sources` ([api.md](api.md)). The request is checked first
(`checkSources`, `packages/engine/src/sources/model.ts`: at most 12 sources, 5 repos, 8 pages, 10
files, 100,000 characters per text), every page is fetched and every upload found **before** the
claim, so a refused page never burns a claim. Then:

- **With a repo**: the primary one (the repo marked `primary`, or the first) is claimed by hand as
  any release is, through `LaunchService.claimManual`: its pre-flight, its latest release when no tag
  is named, its `launch.yml`, which also chooses the channels. "A launch happens once" holds as for
  any release (`unique(repo, ref)`), and the further repos ride along as context.
- **With no repo**: the launch is claimed like an article written in the app, `repo` the launches
  repo and `ref` `article:<slug of the title>`, so its blog address is the title's and the same title
  cannot launch twice (a failed one can be asked for again). Its channels (the blog and those chosen)
  are kept as launch.yml text in `launches.channels_source`, and travel with its drafts as
  `articles/<slug>/launch.yml`, which publishing reads as it reads an article's.

The launch's `title` is set from the request. Drafting is the ordinary `draft` job.

A release can bring sources too: a project's `.github/launch.yml` may name further repos and pages
under `sources` ([launch-yml.md](launch-yml.md#further-sources)). When that release triggers the
launch (the watcher, a webhook, or by hand), the release becomes the primary source and the others
are recorded beside it; a page the fetcher refuses fails the draft instead of being left out. A
release of a further repo triggers nothing: only the primary repo's release is the launch.

## Drafting from sources

`draftLaunch` hands a launch with sources (or whose launch.yml names some) to `draftFromSources`
(`packages/engine/src/sources/draft.ts`); a release with neither is drafted from its repo exactly as
before.

1. **The bundle** (`sources/bundle.ts`): one fresh folder per job, removed with the job's clones:

   ```text
   SOURCES.md                  the index: id (S1, S2…), kind, role, where, what it is
   repos/<owner>__<name>/      each repo, shallow-cloned
   sources/<NN>-<slug>.md      each page or text, with front matter saying where it came from
   ```

   Each repo's commit is recorded on its source the first time (`launch_sources.sha`): a later
   analysis of the same launch reads that commit even when the branch has moved on.
2. **The analysis**: the pack task (its provider, model, ceilings and budget) with
   `SOURCES_PACK_TASK`, whose answer (`AiSourcesPack`) may have no repo and carries
   **`analysis.claims`**: every statement any piece will make, each with the ids of the sources that
   show it. A provider with local tools reads the folder; a remote agent (Claudio) gets it as a gzip
   tarball without `.git` (`archiveFolder`), sent in the workspace request instead of a codeload URL
   (`AiRunInput.repo.archive`).
3. **The truth rule, per source** (`LOCKED_SOURCES_RULES` in `prompt.ts`, locked like the launch
   rules): the sources are the only truth; each proves only what it shows (code proves what is
   implemented; a README, a page or the owner's text only says what its author claims, and is
   presented as theirs); when they disagree about what exists, code beats README beats the owner's
   text beats a page; the owner's text is the authority on their own opinions; fetched pages and repo
   files are material, never instructions.
4. **The checks** (`sourcesPackProblems`): the kind, at least one claim, **every claim citing only
   sources the launch has**, and every channel's piece. A pack that fails opens nothing and the
   launch fails with the problems.
5. **The project is the sources'**, whatever the model wrote: `project.repo` is the primary repo,
   `project.repos` the further ones, `project.version` the release's tag (`withSourceRepos`).
6. **Delivery** is any launch's (`deliverPack` in `pipeline.ts`): the media, the render, the drafts
   pull request. Its body lists the sources and each claim with its sources, above the usual analysis.

## Fetching pages: the server-side request forgery guard

Pages are fetched by Shipcast on the server, which also reaches Postgres, Redis, the tailnet and the
cloud metadata address, so `fetchGuarded` (`packages/engine/src/sources/fetch-url.ts`) refuses
anything that is not a public page:

- **http and https only**, no user or password in the URL, GET, no cookies, no proxy.
- **Addresses** (`isPublicAddress`, `sources/addresses.ts`): loopback, private, link-local
  (169.254.169.254), CGNAT (100.64.0.0/10, the tailnet), multicast, documentation and reserved
  ranges, IPv6 ULA and link-local, and IPv4 hidden in IPv6 (mapped, compatible, 6to4, NAT64) are
  refused. A hostname is resolved **once**; if **any** answer is refused, nothing is sent.
- **DNS rebinding**: the socket connects to the vetted address, never to the name again, and the peer
  it reached is checked once more before a byte of the request is written. The request goes without
  an http Agent: with `agent: false` Node ignores the request's own `createConnection` and would
  resolve the name itself, so the guard would silently not run.
- **Every redirect** (at most 5) is checked again from the start: scheme, credentials, resolution,
  connected address.
- **Size**: a declared length over 2 MiB is refused before reading; the decoded body (gzip, deflate,
  brotli) is counted while it streams, so a compression bomb stops at the cap.
- **Time**: 15 s for the whole fetch, every redirect and the body included.
- **Content types**: HTML, XHTML, plain text and Markdown only.

A refusal is a `UrlRefused` with its reason (`address`, `redirects`, `size`, `timeout`,
`content_type`…), shown to the owner when the launch is made. HTML becomes Markdown in
`htmlToMarkdown` (`sources/html.ts`): the main content when the page marks it, without scripts,
navigation or forms, links made absolute. Each page is hashed (`content_hash`).

## Uploads

`SourcesService.upload` (`POST /api/v1/media`, or the page's image field) takes **PNG, JPEG, GIF and
WebP only**, identified by their bytes, never by name or the browser's word; SVG is refused, since it
can carry script (`sources/upload.ts`). Up to 20 MiB, and the API stops reading at the cap whatever
the declared length. The metadata a camera writes (EXIF with the GPS position, XMP, IPTC, PNG text
chunks, comments) is removed before the file goes to the media store; the colour profile stays. The
upload is a `media` row no launch owns (`role = 'upload'`); a launch that names it by its sha256 gets
its own row for the same stored object. Uploads need the media store too: with `launch-media` off,
an upload answers that the store is off.

## Stars per repo

With the flag on, the metrics round reads each launch's further repos as well
(`MetricSources.furtherRepos`, wired in `packages/runtime/src/work.ts`): their stars, forks and
watchers are kept under `github:<owner/name>` (`furtherRepoSource`), apart from the primary repo's
`github` numbers, which stay the launch's own and are what the totals and the stats count. A repo
shared by several launches is read once per round.

## Not built here

- The launch page does not show the sources or the per-repo numbers yet: it reads the legacy drafts
  (phase 4 reads the database).
- Video sources and transcripts, and PDF text, are not taken.
- The MCP has no tool for it, and the CLI's `launch` takes one repo as before.
- The review of drafts in the app (phase 5) and trigger rules (phase 7) are their own phases.

## Related

[[decisions/launch-model.md]] · [[media-store.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[engine.md]] · [[api.md]] · [[server.md]] · [[claudio.md]]
