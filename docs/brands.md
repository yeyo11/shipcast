---
created_at: 2026-10-24T16:26:13.807005215Z
updated_at: 2026-10-24T16:28:36.043469588Z
tags:
    - brands
    - config
    - decision
    - tone
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
| `handles.x` | <https://x.com/joseagg112> (linked from the footer; nothing is published there) |
| `handles.linkedin` | <https://www.linkedin.com/in/jagg97/> (linked from the footer; nothing is published there) |
| `handles.bluesky` | <https://bsky.app/profile/yeyo11.bsky.social> |
| `handles.mastodon` | <https://mastodon.social/@yeyo11> |
| `handles.devto` | <https://dev.to/yeyo11> |
| `handles.reddit` | <https://www.reddit.com/user/josegarridodev/> |
| `handles.instagram` | <https://www.instagram.com/josegarridodev> |
| `languages.blog` | `[en, es]` |
| `languages.x`, `languages.linkedin` | not set: the owner does not publish on X or LinkedIn (2026-10-24); the schema keeps both optional for brands that do |
| `tone` | First person, didactic and direct; problem first, then evidence (command, config, output); honest about what does not work yet; no hype. Calm articles without emojis; short social posts with a hook and a few emojis as markers. Spanish from Spain. Set by the owner on 2026-10-24, to refine with real launches (phase 5) |
| `support` | <https://buymeacoffee.com/yeyo11>, linked from the blog's footer |

Handles are full profile URLs, as the owner gave them; a connector derives the account name from the
URL when an API needs it. The blog's footer links every profile with `rel="me"`, which also lets
Mastodon verify the blog once the profile links back to it. The support link sits on a line of its
own in the footer, apart from the profiles, and only in the blog: the launches repo's README does not
carry the Buy Me a Coffee badge, which belongs to Shipcast's README. `packages/schema` keeps a copy of
this file as a test fixture (`test/fixtures/brand.yml`), refreshed when the brand changes.

`brand.yml` and these documents are public. What a tone was drawn from, or any other internal
reference behind a brand decision, is not written in either.

## What the schema has to enforce

The brand schema in `packages/schema` validates this file: `id` and `displayName` required, handles
and `support` optional (a channel without a handle cannot publish), languages from `en` and `es`, the
blog in at least one, X and LinkedIn optional. A launch's `launch.yml` names its brand by `id`, and
the engine refuses a launch whose brand does not match the launches repo it would write to — the
mechanical form of "brands never mix".

## Related

[[decisions/mvp-scope.md]] · [[launches-repo.md]] · [[plans/shipcast.md]] · [[launch-yml.md]] · [[content-pack.md]]
