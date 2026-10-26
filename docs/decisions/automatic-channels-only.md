---
created_at: 2026-10-26T20:50:20.744958368Z
updated_at: 2026-10-26T20:50:20.744958368Z
tags:
    - decision
    - channels
    - connectors
    - reddit
    - launch-yml
---
# Only channels Shipcast publishes on itself

Decided on 2026-10-26 by the owner: Shipcast knows only networks it posts to itself. Hacker News,
Product Hunt and X are gone, and so is the `manual` publishing mode; Reddit, a draft until then,
became a channel Shipcast publishes on.

## What changed

- **Hacker News and Product Hunt** were drafts for the owner to copy (`show-hn.md`,
  `product-hunt.md`): neither has an API to post through. Postiz, read on the same day as reference
  ([mvp-scope.md](mvp-scope.md) says how it is used), has no integration for either, which confirmed
  there is nothing to automate. They are gone from the channels, the content pack, the prompt, the
  writing assistant, the network catalog, the design system's glyphs and the blog's referrer
  sources (a visit from news.ycombinator.com now counts as `other`). The two drafts of Shipcast
  v0.1.0 were deleted from the launches repo.
- **X** was a channel with no connector, named so a `launch.yml` would stay valid; it is gone, with
  its `handles.x` and `languages.x` in `brand.yml`.
- **The `manual` mode** wrote a draft Shipcast never sent. A channel is now `auto`, `approval` or
  `off` (`PublishMode` in `packages/schema/src/channels.ts`). `DRAFT_ONLY_CHANNELS` and the
  catalog's `auth: 'none'` went with it. The UI tone that showed "post it yourself" is now `quiet`,
  for what is not launched, deleted or dismissed.
- **Reddit publishes** from the owner's account: one text post per subreddit in `launch.yml`,
  linking the article ([publishing.md](../publishing.md#reddit)).

## Why

The owner wants every channel to go out on its own once approved; a draft to copy by hand is work
the tool was built to remove. Reddit was a draft by an earlier choice (communities that judge
self-promotion by hand), not because it lacked an API.

## What it costs

- **A `launch.yml` that names `hackerNews`, `productHunt` or `x`, or sets a channel to `manual`, no
  longer parses**, with the error on its line. Only Shipcast's own file used them; it was updated in
  the same change, and claudio's never did.
- **Reddit's API needs an approved app.** Since November 2025 Reddit grants API access by request
  under its Responsible Builder Policy. The connector is built and tested with fakes; it posts once
  Reddit approves the owner's app and the account is connected.
- **Reddit is not schedulable** for now: a schedule is one row per channel, and Reddit has one post
  per subreddit.

## Rejected

- **Keeping Hacker News and Product Hunt as drafts in the pull request**, or recording a URL the
  owner posted by hand: the owner chose to drop every channel Shipcast cannot publish itself.
- **Reddit through a "script" app with the account's password**: OAuth with a permanent refresh
  token keeps the password out of Shipcast, like every other OAuth network.

## Related

[[decisions/mvp-scope.md]] · [[publishing.md]] · [[launch-yml.md]] · [[content-pack.md]] · [[accounts.md]] · [[scheduling.md]] · [[decisions/edit-delete.md]]
