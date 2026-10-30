---
created_at: 2026-10-30T00:39:53.627637481Z
updated_at: 2026-10-30T00:39:53.627637481Z
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
volume. Built on 2026-10-30 as the first phase of the launch model, behind the `launch-media` flag;
**nothing calls it yet**. The launches' media of today still ride in the drafts pull request
([publishing.md](publishing.md#the-launchs-media)).

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

- **`launch-media` off** (the default, and production's): the store refuses every call with "the
  launch-media flag is off", and `.env` is not read for it.
- **On, with nothing in `.env`**: it refuses every call, naming the four variables that are missing.
- **On, with half of them**: the start stops with a `ConfigError`, as half a GitHub App does.
- **On, with all of them**: R2.

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
`demo`, `chart`, `upload`) and, once published on the site, its `public_path`. One launch holds a
file once (`unique (launch_id, sha256)`); a purge removes an object only when no row names its
sha256 any more.

## Still to do

- Adding the bucket to the server's nightly backup, which today covers Postgres only: part of the
  media phase in the decision.
- Writing media to it (the shadow write), serving it to the app for review, and handing networks a
  public address at publish time: later phases of the launch model.

## Related

[[decisions/launch-model.md]] · [[engine.md]] · [[publishing.md]] · [[server.md]] · [[content-pack.md]] · [[launches-repo.md]]
