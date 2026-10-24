---
created_at: 2026-10-24T14:21:43.07742302Z
updated_at: 2026-10-24T14:21:43.07742302Z
tags:
    - brands
    - config
    - decision
---
# Brands

A brand is who a launch speaks for: the name that signs it, the profiles it links, the language of
each channel and the tone of the writing. The owner has two, which never mix: **personal** (GitHub
`yeyo11`) and **company** (`josegarridodigio`). The MVP covers only the personal one
([decisions/mvp-scope.md](decisions/mvp-scope.md)).

## Where a brand is described

In **`brand.yml` at the root of the brand's launches repo**, not in Shipcast. Decided on 2026-10-24:
each brand has its own launches repo ([launches-repo.md](launches-repo.md)), so its description
travels with it; Shipcast stays a product that holds no one's brand; and the site reads the same file
(`src/site.ts`), so there is one place to change a profile. The file holds public information only;
tokens stay in Shipcast's `.env`.

The personal brand's file, [`yeyo11/launches/brand.yml`](https://github.com/yeyo11/launches/blob/main/brand.yml):

| Field | Value |
| --- | --- |
| `id` | `personal` |
| `displayName` | José Antonio Garrido |
| `github` | `yeyo11` |
| `handles.x` | <https://x.com/joseagg112> |
| `handles.linkedin` | <https://www.linkedin.com/in/jagg97/> |
| `handles.bluesky` | <https://bsky.app/profile/yeyo11.bsky.social> |
| `handles.mastodon` | <https://mastodon.social/@yeyo11> |
| `handles.devto` | <https://dev.to/yeyo11> |
| `languages.blog` | `[en, es]` |
| `languages.x` | `en` — provisional, not yet confirmed by the owner |
| `languages.linkedin` | `es` — provisional, not yet confirmed by the owner |
| `tone` | empty: defined from examples in phase 5 |

Handles are full profile URLs, as the owner gave them; a connector derives the account name from the
URL when an API needs it. The blog's footer links every profile with `rel="me"`, which also lets
Mastodon verify the blog once the profile links back to it.

## What the schema has to enforce

The brand schema in `packages/schema` validates this file: `id` and `displayName` required, handles
optional (a channel without a handle cannot publish), languages from `en` and `es`, the blog in at
least one. A launch's `launch.yml` names its brand by `id`, and the engine refuses a launch whose brand
does not match the launches repo it would write to — the mechanical form of "brands never mix".

## Related

[[decisions/mvp-scope.md]] · [[launches-repo.md]] · [[plans/shipcast.md]] · [[launch-yml]] · [[content-pack]]
