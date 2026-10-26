---
created_at: 2026-10-25T16:31:21.16585086Z
updated_at: 2026-10-26T20:52:06.719329823Z
tags:
    - decision
    - publishing
    - connectors
    - edit-delete
    - api
    - phase-9
---
# Editing and deleting what a launch published

Decided and built on 2026-10-25, the base of milestone 5 of the [goal](../plans/goal-after-mvp.md)
(phase 9 of [plans/after-mvp.md](../plans/after-mvp.md)). A published piece can be edited or deleted
on the networks whose API allows it, one at a time or a whole launch at once, from the engine and the
REST API; the launch page's buttons come later, on top of the same functions. How it works is in
[publishing.md](../publishing.md#after-publishing-editing-and-deleting) and the routes in
[api.md](../api.md).

## What each network can do

The capability is written once, as a static map per channel (`CAPABILITIES` in
`packages/engine/src/edit.ts`), so the app and the API say the same thing and a refusal is explained,
not hidden. Each entry is `{ edit: 'yes' | 'no' | 'partial', delete: 'yes' | 'no' | 'unpublish',
note, fields }`; `GET /api/v1/capabilities` serves it.

| Channel | Edit | Delete | How |
| --- | --- | --- | --- |
| Mastodon | yes: text, image | yes | `PUT /api/v1/statuses/:id` (its media ids and language read first and sent back, the plain text from `/source` when only the image changes); `DELETE /api/v1/statuses/:id` |
| Telegram | yes: text or caption, a photo's photo | yes | `editMessageText`, then `editMessageCaption` when Telegram says the message has no text, `editMessageMedia` for a new photo; `deleteMessage`, which Telegram refuses after 48 hours |
| Discord | yes: text | yes | `PATCH` / `DELETE /webhooks/{id}/{token}/messages/{message}`: the webhook URL holds the id and token, and publishing with `?wait=true` already recorded the message id |
| dev.to | yes: body, title, tags, canonical URL, cover | unpublish | `PUT /api/articles/:id`; Forem has no delete, so `published: false` takes it off the site and leaves it in the author's dashboard |
| Hashnode | yes: body, title, tags, canonical URL, cover | yes | `updatePost` and `removePost`, checked against Hashnode's schema; only answers publications on the Pro plan |
| Bluesky | no | yes | `com.atproto.repo.deleteRecord` with the repo, collection and rkey of the at:// URI |
| Instagram | no | no | The API edits no caption of a published post and deletes no post (comments can be deleted; not done here) |
| Newsletter | no | no | A sent campaign is in the inboxes already |
| Blog | yes: body, title, tags | yes | A commit to the launches repo's `main`, which deploys the site |
| GitHub Discussions | yes: title, body | yes | `updateDiscussion` and `deleteDiscussion` through the GitHub App; a delete removes its comments |
| Threads | no | yes | The Threads API has no edit; `DELETE /{media-id}`, at most 100 a day |
| LinkedIn | no | yes | `DELETE /rest/posts/{urn}`; Share on LinkedIn cannot edit |
| Reddit | no | yes | `POST /api/del` with the post's name (`t3_…`); a title can never change, and editing the body (`/api/editusertext`) is not built |

In the connectors the capability is a type too: a connector that can implements `Editable<Piece>`
(`edit(externalId, piece)`) or `Deletable` (`delete(externalId)`), with `Piece` what that network lets
change; Bluesky implements only `Deletable`, Instagram and Brevo neither.

## Why Bluesky has no edit

The AT Protocol could overwrite the record (`putRecord`), but the Bluesky app would show a post whose
text no longer matches its likes, quotes and facets, and a delete and repost loses every like and
reply. The capability says no, and Shipcast never deletes and reposts on its own: the owner can delete
it and write a new post, knowing what that costs.

## The account a piece went out with

An edit or a delete is made with the account the row records, never the channel's primary account of
the moment: the primary may have changed since, and another account cannot touch the post. A row with
no account went out with the `.env` credentials, which speak only for their own brand. An account
removed since has its pieces' account set to null, so they fall back to `.env`; one connected but
with no secrets left is refused with that reason. `postEditors` in `packages/runtime/src/edits.ts`
builds the connectors this way.

## The row after an edit or a delete

The row stays. An edit sets `status` to `edited`, `content_hash` to the SHA-256 of the fields sent
and `updated_at`; a delete sets `status` to `deleted`. No migration was needed: the columns were in
the post model from the start ([post-model.md](post-model.md)).

"A launch happens once" holds through a delete: the engine decides a channel is done by the kinds of
its rows, whatever their status, so a deleted post is never published again, even if the launch goes
back to drafted, and the registry still refuses a second piece of the same kind. Deleted pieces are
left out of the metric rounds (they would only answer not found) and of the blog's visit and search
readings, and keep the numbers they last had. A network that answers 404 to a delete is taken at its
word: the piece is gone, which is what was asked.

## Refusing before sending

What the network cannot do is refused before any request leaves, with the capability's note: an edit
on Bluesky or Instagram, a delete on Instagram or the newsletter, a story, a comment or a newsletter
issue (only a channel's post, a subreddit's post and the blog's articles are edited or deleted), a
field the network does not take (an image on Discord), a link with no text on a network whose post is
text alone, an image with no text on Telegram (the Bot API cannot read the caption back to keep it).
The API answers 409 for what cannot be done, 400 for a change that is not valid, 404 for a post or
launch that does not exist, and 502 with the network's own words when the network refuses.

## Several channels at once

`editPosts(launchId, changes, channels?)` sends the same shared fields (text, link, image) to every
live piece of the launch on the channels named, each network taking what it has: the text is the post
on Mastodon and Telegram (with the link after it), the message on Discord, the article's body on
dev.to, Hashnode and the blog; the link is the canonical URL on dev.to and Hashnode; the image is
Mastodon's upload, Telegram's photo and the articles' cover. A field a network does not take is left
out for it, a piece that can take nothing is reported, and one failure never stops the rest.
`deleteLaunchPosts(launchId, channels?)` deletes the same way. Both answer one outcome per piece.
They run synchronously, one piece at a time, rather than as a job: each is one or two requests, and
the caller wants to see what each network said.

## The blog

The blog has no account: its articles are files in the launches repo. An edit reads the article at
`src/content/posts/<lang>/<slug>.md` on `main`, changes the body, the title or the tags while keeping
the front matter as written (YAML's document API keeps quotes, order and comments), sets
`updatedDate`, and commits it straight onto `main`. A delete removes the article in one commit through
the Git data API, and the launch's media folder (`public/<launch dir>/`) with it only when no other
language of the launch is left, since the other article still shows those images. Deleting the blog's
media also breaks the dev.to and Hashnode covers that point at them, which is why the media go last.
The commit is not exercised against GitHub in the tests.

## Checked

Fake-fetch tests for every connector's edit and delete request (and that Bluesky, Instagram and Brevo
have no edit, and the last two no delete), engine tests on PGlite (the row's status and hash, every
refusal, the multi-edit mapping, the blog's commits, a deleted post not published again) and API
route tests. On 2026-10-25 one clearly marked test post was published on Mastodon and on the Telegram
channel through the connectors, with the connected accounts publishing uses, against a throwaway copy
of the registry: each was edited (Mastodon's text read back changed) and then deleted (Mastodon
answered 404 afterwards; Telegram's public page says the post is not found). No other post was
touched. Hashnode's mutations were checked against its schema but not run: its API needs the Pro plan.

## Related

[[publishing.md]] · [[api.md]] · [[decisions/post-model.md]] · [[decisions/automatic-channels-only.md]] · [[plans/after-mvp.md]] · [[plans/goal-after-mvp.md]] · [[accounts.md]] · [[launches-repo.md]]
