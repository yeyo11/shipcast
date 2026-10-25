---
created_at: 2026-10-25T00:57:18.123643992Z
updated_at: 2026-10-25T01:42:13.402893333Z
tags:
    - schema
    - launch-yml
    - configuration
---
# launch.yml

`.github/launch.yml` in a project says whether and how Shipcast launches it. The schema is
`LaunchConfig` in [`packages/schema/src/launch-config.ts`](../packages/schema/src/launch-config.ts),
written on 2026-10-24; `parseLaunchConfig(text)` validates a file and reports every problem with its
line, and `formatIssues('launch.yml', issues)` prints them as `launch.yml:14:3 publishing.reddit: …`.

## A complete example

```yaml
enabled: true            # required: turning launches on is always a deliberate line
brand: personal          # the id in the launches repo's brand.yml
language: en             # the project's main language (default en)
pack: launch             # optional: launch | major | minor; inferred from the version when absent

triggers:                # defaults shown
  release: true          # a published release
  manual: true           # shipcast launch <repo>
  public: false          # the repo going from private to public
  enabled: false         # enabled: true landing in a repo that never launched

content:
  article: true
  socialPosts: true
  technicalTutorial: false

publishing:              # auto | approval | manual | off, per channel
  blog: approval
  devto: approval
  bluesky: approval
  mastodon: approval
  instagram: approval
  newsletter: approval
  hashnode: approval     # phase 5 channels: off by default
  telegram: approval
  discord: approval
  hackerNews: manual     # the Show HN draft
  productHunt: manual    # the launch kit
  reddit: manual         # off by default since 2026-10-25

assets:
  demo: docs/demo.gif    # path in the repo or URL; every launch needs one

reddit:
  subreddits: [ClaudeAI, node]   # names without r/; only read when reddit is turned on
```

The smallest valid file is `enabled: true` and `brand: personal`; everything else has a default.

## Publishing modes

| Mode | Meaning |
| --- | --- |
| `auto` | Published as soon as the pack is generated, without review |
| `approval` | In the drafts pull request of the launches repo; published when it is merged |
| `manual` | In the drafts pull request as a draft the owner posts by hand; Shipcast never posts it |
| `off` | Not generated |

The plan named three modes; `off` was added so a channel can be left out without deleting a key.
Defaults (`DEFAULT_MODES` in `channels.ts`) turn on the MVP's channels — blog, dev.to, Bluesky,
Mastodon, Instagram on `approval` (the newsletter, off by default, is turned on per project) — and
leave every other channel `off`, Reddit included since 2026-10-25, when the owner left it out for now
([decisions/mvp-scope.md](decisions/mvp-scope.md)). A project that wants Reddit drafts sets
`publishing.reddit: manual`. An article written in the app has no `launch.yml` of its own: the
channels chosen there are written beside its drafts ([engine.md](engine.md#articles-written-in-the-app)).

## Rules the schema holds

- **Strict objects everywhere.** A misspelt key (`blgo: auto`) is an error pointing at its line, not a
  setting silently ignored.
- **Reddit, Hacker News and Product Hunt are drafts.** Any mode other than `manual` or `off` is
  refused: the plan keeps those communities for the owner to post by hand (Product Hunt joined them on
  2026-10-25; neither it nor Hacker News has an API to post through).
- **Channels are named ahead of their connectors.** `CHANNELS` lists every channel of the plan, so a
  file written today stays valid; turning on one without a connector yet is caught when the pack is
  checked (`missingPieces`, see [content-pack.md](content-pack.md)).

## Which pack a release gets

`resolvePack(config, version, previous)` in `pack.ts`: `pack` in the file wins; otherwise the first
launch of a project is `launch`, a new major version is `major`, everything else `minor`. Before 1.0 a
minor bump counts as major, semver's own rule for 0.y.z, so claudio's v0.8 → v0.9 is `major`. A tag
that is not semver gets `minor`, the quiet choice.

## Related

[[content-pack.md]] · [[brands.md]] · [[decisions/mvp-scope.md]] · [[plans/shipcast.md]] · [[plans/stack.md]] · [[engine.md]]
