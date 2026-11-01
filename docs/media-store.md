---
created_at: 2026-10-30T00:39:53.627637481Z
updated_at: 2026-11-01T16:07:16.327928067Z
tags:
    - media
    - storage
    - r2
    - launches
    - configuration
    - flags
---
# The media store

Where a launch's images and videos live once Shipcast, not the launches repo, holds a launch
([decisions/launch-model.md](decisions/launch-model.md)). The owner chose **Cloudflare R2** from the
start: it also covers the video sources that come later, and it keeps media off the server's
volume. Built on 2026-10-30 as the first phase of the launch model, behind the `launch-media` flag,
which was retired on 2026-11-01 ([server.md](server.md#the-flags)). Every launch Shipcast holds keeps
its files here ([launch-store.md](launch-store.md), [app-review.md](app-review.md)), the app serves
them to the owner's pages (`/media/<id>`, [launch-store-read.md](launch-store-read.md)), uploads for a
launch made from sources land here ([sources.md](sources.md)), and the import put the old launches'
files here ([launch-import.md](launch-import.md)).

## The port

`MediaStore` (`packages/engine/src/media/store.ts`) is the one way to keep a file, with one
implementation per backend:

| Implementation | Where | For |
| --- | --- | --- |
| `R2MediaStore` | `packages/engine/src/media/r2.ts` | Cloudflare R2, or any S3-compatible store (MinIO, S3) |
| `MemoryMediaStore` | `@shipcast/engine/testing` | tests: the same contract, in memory |
| `unavailableMediaStore(reason)` | `store.ts` | a process without a store: every call refuses with the reason |

| Call | Does |
| --- | --- |
| `put(bytes, mime)` | keeps the bytes under their sha256 and answers `{ key, sha256, bytes, mime }`; the same bytes again are the same object |
| `get(key)` | the bytes and their type, or `undefined` when there is nothing under the key |
| `has(key)` | whether the key holds anything |
| `delete(key)` | removes it; a key with nothing under it is not an error |

Files are **addressed by content**: the key is `media/<first two hex>/<sha256>`, the sha256 of the
bytes. Two launches that use the same image share one object, and a `media` row (below) can always be
checked against what the store holds. Every call but `put` takes only a key that `mediaKey` could have
made (`assertMediaKey`), so no caller can read or delete another object of the bucket.

The R2 implementation is four calls on the S3 API with requests signed by hand (AWS Signature
Version 4, `signS3Request`, tested against AWS's own example), path-style
(`<endpoint>/<bucket>/<key>`), so it needs no SDK. Its errors are Shipcast errors:
`MediaStoreUnavailable` (`media_unavailable`, 503, never retried: only the owner fixes it),
`MediaStoreFailed` (`upstream`, retryable on 429, 5xx or no answer; it keeps only S3's error code,
whose message can echo the request), and `MediaKeyInvalid` (400).

## Configuration

The runtime builds the store (`packages/runtime/src/media.ts`, `Runtime.media`):

- **All of them in `.env`**: R2.
- **Half of them**: the start stops with a `ConfigError`, as half a GitHub App does.
- **None, on a server** (`SHIPCAST_APP_TLS=proxy`, as production runs, and not a preview with fake
  networks): the start stops with a `ConfigError` naming the four variables. Every launch keeps its
  files here, so a server without the store could not hold one.
- **None, on a desktop install or a preview with fake networks**: the store refuses every call,
  naming the four variables, so a launch with files fails its draft saying what is missing.

| Variable | What |
| --- | --- |
| `SHIPCAST_MEDIA_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com`, without the bucket; only `https://host` is accepted |
| `SHIPCAST_MEDIA_BUCKET` | the bucket's name |
| `SHIPCAST_MEDIA_ACCESS_KEY_ID`, `SHIPCAST_MEDIA_SECRET_ACCESS_KEY` | an R2 API token's key pair, with Object Read & Write on that bucket alone |
| `SHIPCAST_MEDIA_REGION` | optional: R2 takes `auto`, the default; another S3-compatible store may need its own |

They live in `.env` ([.env.example](../.env.example)) because the store is needed by every process
before anyone signs in, like the database.

## What describes a file

The bytes are in the store; what describes them is a row of `media` in Postgres (migration `0018`,
[engine.md](engine.md#the-launch-registry)): the launch (null for a file no launch owns, such as a
project's cover), `sha256`, `kind`, `mime`, `bytes` (a `bigint`: a video can pass 2 GiB), the size or
length, `storage` (`r2`) and `path` (the key), its `role` (`og`, `screenshot`, `carousel`, `story`,
`demo`, `cover`, `chart`, `upload`, or `other`) and its `public_path` on the site (for a launch of the
pull-request flow, where its pull request puts it). One launch holds a file once
(`unique (launch_id, sha256)`); a purge removes an object only when no row names its sha256 any more.

## Still to do

- Adding the bucket to the server's nightly backup, which today covers Postgres only: part of the
  media phase in the decision.
- Handing networks a public address of their own at publish time: today they fetch the files from
  the site, where the publish commit puts them ([app-review.md](app-review.md)).

## Related

[[decisions/launch-model.md]] · [[engine.md]] · [[publishing.md]] · [[server.md]] · [[content-pack.md]] · [[launches-repo.md]] · [[launch-store.md]]
