---
created_at: 2026-10-26T07:03:34.508871045Z
updated_at: 2026-10-26T07:03:34.508871045Z
tags:
    - decision
    - connectors
    - github-discussions
    - threads
    - linkedin
    - phase-11
---
# GitHub Discussions, Threads and LinkedIn

Built on 2026-10-26 for milestone 7 of the [goal after the MVP](../plans/goal-after-mvp.md), the
networks the owner chose in [plans/after-mvp.md](../plans/after-mvp.md#decisions): GitHub
Discussions, Threads, and LinkedIn on the personal profile. YouTube waits until there is video.

## What each one does

| Network | Publishes | Edit | Delete | Numbers | Comments | Account |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub Discussions | A discussion in the launched repo: title and Markdown body, in English, linking the article | Yes: title and body | Yes, with its comments | Reactions and comments | Read and answered on approval | None to connect: the [GitHub App](github-app.md)'s installation token, which has Discussions: write |
| Threads | A post with the launch image and its text (at most 500 characters, an emoji counting as its UTF-8 bytes), linking the article | No: the Threads API has none | Yes (`threads_delete`, at most 100 a day) | Views, likes, replies and reposts (`threads_manage_insights`) | Read and answered on approval (`threads_read_replies`, `threads_manage_replies`) | OAuth through the owner's Meta app (its Threads use case); a 60-day token renewed every 30 days, as Instagram's |
| LinkedIn | A post on the owner's personal profile sharing the article (at most 1,300 characters), its thumbnail uploaded first | No | Yes | None | None | OAuth with "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn" (`openid profile w_member_social`); a 60-day token, connected again when it runs out |

- **GitHub Discussions** posts in the repo's **Announcements** category (only maintainers can post
  there), or **General** when the repo has none. A repo with Discussions turned off is reported in
  words the owner can act on ("turn on Discussions in the repo's settings"), never as a GraphQL error.
  The channel is `approval` by default; it needs nothing connected.
- **Threads** goes through Meta's two steps: a media container, waited on until Threads has processed
  it, then published. Meta moved Threads to `threads.com` in 2025, and its API docs use that host.
- **LinkedIn** publishes with the Posts API (`/rest/posts`, which replaced `ugcPosts`), with a
  monthly version header. Reading a member's posts, comments or numbers needs the Community Management
  API (`r_member_social`), which LinkedIn grants only to approved companies: LinkedIn gets no metrics
  and no comment assistant, and the Channels page says so. Its text is escaped for LinkedIn's
  "little" format, where a bare parenthesis or bracket can cut a post short.

Threads and LinkedIn are `off` by default in `launch.yml` until they are connected.

## Where they fit

- **The content pack** gains `githubDiscussions` (title, body), `threads` (text) and `linkedin` (text),
  each with its brief, an editable prompt in the AI settings; `missingPieces` asks for them when their
  channel is on, and for the article that LinkedIn shares ([content-pack.md](../content-pack.md)).
- **Publishing** records each as a piece of the launch, once
  ([decisions/post-model.md](post-model.md)); the capability map says what can be edited and deleted
  ([decisions/edit-delete.md](edit-delete.md)); the comment assistant reads GitHub Discussions and
  Threads ([decisions/comment-assistant.md](comment-assistant.md)); best times include them.
- **The apps' credentials** are settings, not `.env`: the Threads app id (a setting) and secret (the
  keychain), the LinkedIn client id and secret likewise, entered in Settings. The OAuth callbacks are
  `https://<app>/auth/threads/callback` and `https://<app>/auth/linkedin/callback`.

## What the owner does

- **GitHub Discussions**: turn on Discussions in each repo that should get one (repo › Settings ›
  Features › Discussions); on 2026-10-26 `yeyo11/shipcast` had it off, so the live test waits.
- **Threads**: add the Threads use case to the Meta app with the permissions above and the callback,
  then enter its app id and secret in Settings and connect Threads in Channels.
- **LinkedIn**: create an app with the two products and the callback, then enter its client id and
  secret in Settings and connect LinkedIn in Channels.

## Related

[[plans/goal-after-mvp.md]] · [[plans/after-mvp.md]] · [[decisions/github-app.md]] · [[decisions/post-model.md]] · [[decisions/edit-delete.md]] · [[decisions/comment-assistant.md]] · [[content-pack.md]] · [[publishing.md]] · [[accounts.md]]
