---
created_at: 2026-10-25T10:29:05.41216436Z
updated_at: 2026-10-30T03:14:02.144761572Z
tags:
    - schema
    - launch-yml
    - configuration
    - sources
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

publishing:              # auto | approval | off, per channel
  blog: approval
  devto: approval
  bluesky: approval
  mastodon: approval
  instagram: approval
  newsletter: approval
  hashnode: approval     # phase 5 channels: off by default
  telegram: approval
  discord: approval
  reddit: approval       # off by default: one post per subreddit below

assets:
  demo: docs/demo.gif    # path in the repo or URL of a GIF; or record one from `site`
  site: https://claudio.example   # the deployed project: screenshots, and the demo when there is no GIF
  tour:                  # optional, at most 12 steps, one action each
    - wait: 1000         # ms, 100 to 5000
    - scroll: 600        # pixels down (negative goes up), or `bottom`
    - click: "#start"    # a CSS selector
    - goto: /docs        # a path on the same site
  screenshots:           # optional, 1 to 6 pages; the site's root when absent
    - path: /
    - path: /docs/start
      name: start        # optional; taken from the path otherwise ("/" is "home")

sources:                 # optional, read only with the launch-sources flag on
  repos: [yeyo11/claudio-web]        # further repos, at their default branch; at most 5
  urls: [https://claudio.example/]   # pages Shipcast fetches; at most 8

reddit:
  subreddits: [ClaudeAI, node]   # names without r/; only read when reddit is turned on
```

The smallest valid file is `enabled: true` and `brand: personal`; everything else has a default.

## The demo and the deployed project

Added on 2026-10-25 ([plans/mvp-close.md](plans/mvp-close.md)). Every launch needs a demo, which
becomes the Instagram carousel's video: either a GIF committed to the repo (`assets.demo`), or the
deployed project (`assets.site`), which Shipcast opens in headless Chromium through Playwright
([publishing.md](publishing.md#the-launchs-media)). With a site it takes screenshots (desktop and
mobile) of the listed pages, and, when there is no `assets.demo`, records the tour as the demo GIF.
Without a tour it records the default one: a pause, a slow scroll to the bottom and back to the top.
The pre-flight check accepts a site that answers in place of a committed demo.

## Further sources

Added on 2026-10-30 with phase 6 of the launch model ([sources.md](sources.md)). A project that is
more than its own repo (an app and its site, a library and its docs) names the rest under `sources`:
`repos` (`owner/name`, read at their default branch) and `urls` (http or https pages, fetched by
Shipcast through its guarded fetcher). When this repo's release triggers the launch, the release is
the primary source and the others are read beside it; a release of one of the further repos triggers
nothing. A page that cannot be fetched fails the draft rather than being left out. The key is
optional and adds nothing to a file without it; with the `launch-sources` flag off it is parsed and
ignored.

## Publishing modes

| Mode | Meaning |
| --- | --- |
| `auto` | Published as soon as the pack is generated, without review |
| `approval` | In the drafts pull request of the launches repo; published when it is merged |
| `off` | Not generated |

The plan named three modes; `off` was added so a channel can be left out without deleting a key.
A fourth, `manual` (a draft the owner posted by hand), was removed on 2026-10-26 with every channel
Shipcast cannot publish itself ([decisions/automatic-channels-only.md](decisions/automatic-channels-only.md)).
Defaults (`DEFAULT_MODES` in `channels.ts`) turn on the MVP's channels — blog, dev.to, Bluesky,
Mastodon, Instagram on `approval`, and GitHub Discussions, which needs no account (the newsletter,
off by default, is turned on per project) — and leave every other channel `off`, Reddit included,
so a network that needs an account is never drafted for before one is connected. A project that
wants Reddit sets `publishing.reddit: approval` and lists its subreddits. An article written in the
app has no `launch.yml` of its own: the channels chosen there are written beside its drafts
([engine.md](engine.md#articles-written-in-the-app)), and so are those of a launch made from sources
with no repo ([sources.md](sources.md)).

## Rules the schema holds

- **Strict objects everywhere.** A misspelt key (`blgo: auto`) is an error pointing at its line, not a
  setting silently ignored. So is a channel that no longer exists (`hackerNews`, `productHunt`, `x`)
  and the removed `manual` mode.
- **Every channel publishes.** `CHANNELS` lists only networks with a connector, and each has its
  piece of the pack; turning one on whose piece is missing is caught when the pack is checked
  (`missingPieces`, see [content-pack.md](content-pack.md)).
- **A site is https, and a tour stays on it**: a `goto` to another origin is refused.

## Which pack a release gets

`resolvePack(config, version, previous)` in `pack.ts`: `pack` in the file wins; otherwise the first
launch of a project is `launch`, a new major version is `major`, everything else `minor`. Before 1.0 a
minor bump counts as major, semver's own rule for 0.y.z, so claudio's v0.8 → v0.9 is `major`. A tag
that is not semver gets `minor`, the quiet choice.

## Related

[[content-pack.md]] · [[brands.md]] · [[decisions/mvp-scope.md]] · [[decisions/automatic-channels-only.md]] · [[plans/shipcast.md]] · [[plans/stack.md]] · [[engine.md]] · [[plans/mvp-close.md]] · [[publishing.md]] · [[sources.md]]
