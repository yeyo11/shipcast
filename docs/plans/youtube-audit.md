---
created_at: 2026-10-28T17:11:23.179876019Z
updated_at: 2026-10-28T17:11:23.179876019Z
tags:
    - plan
    - youtube
    - audit
    - google
    - privacy
    - owner-step
---
# YouTube API audit: what to send Google

Prepared on 2026-10-28 for the owner to send, from [decisions/youtube.md](../decisions/youtube.md). Until
Google audits the project, every video Shipcast uploads through the API stays **private**. The form is
Google's "YouTube API Services – Audit and Quota Extension Form". Each answer below is written to be
pasted, in English.

## The application

- **API client**: Shipcast, `https://github.com/yeyo11/shipcast` (open source, MIT).
- **What it does**: Shipcast is a self-hosted tool a developer runs for their own GitHub projects. On a
  release it drafts the launch content for every channel the developer has connected (a blog article,
  social posts, a newsletter issue, and two YouTube videos), the developer reviews and approves the
  drafts, and Shipcast publishes them on the developer's own accounts.
- **Who uses it**: one person, the channel's owner, on their own YouTube channel. There are no other
  users and no other channels. No end user signs in through this project.
- **Where it runs**: the owner's own server (`https://shipcast.josegarrido.dev`, private to the owner).

## How it uses the YouTube API

| Use | Endpoints | Why |
| --- | --- | --- |
| Upload the launch's two videos (a Short and a 1–3 minute horizontal video), once each per release | `videos.insert` (resumable), `captions.insert`, `thumbnails.set` | the release announcement on the owner's channel, with captions in the video's language (the videos have no voice) |
| Correct a title, description or tags after upload | `videos.list`, `videos.update` (snippet) | the owner edits a published piece from Shipcast |
| Remove a video the owner deletes in Shipcast | `videos.delete` | the owner's own request |
| Show the videos' numbers in Shipcast's stats | `videos.list` (statistics, 50 per call, hourly), `channels.list` (statistics, daily) | the owner sees how each launch did |
| Read and answer comments under the owner's videos | `commentThreads.list`, `comments.insert` | the owner answers comments, each reply drafted by Shipcast and sent only after the owner approves it |

Expected volume: a few releases a month, so two uploads per release; reads are batched and at most
hourly. The default quota of 10,000 units a day is enough; no quota extension is requested.

## Scopes and why each is needed

| Scope | Why |
| --- | --- |
| `https://www.googleapis.com/auth/youtube.upload` | to upload the launch videos |
| `https://www.googleapis.com/auth/youtube.readonly` | to read the channel's videos, their numbers and its own statistics |
| `https://www.googleapis.com/auth/youtube.force-ssl` | to edit and delete the owner's videos, upload captions, and read and answer comments |

## Data kept, and for how long

- **Kept**: each video's id and URL, its title and description as published, its numbers over time
  (views, likes, comments), the channel's subscriber, video and view counts once a day, and the comments
  under the owner's videos with the replies the owner approved.
- **Where**: the owner's own PostgreSQL database on the owner's server. Nothing is sent to any third
  party. The OAuth refresh token is stored encrypted (AES-256-GCM, key outside the database).
- **How long**: as long as the owner keeps the launch in Shipcast; deleting a launch's posts in Shipcast
  deletes the videos on YouTube; disconnecting YouTube in Shipcast deletes the token. Revoking access at
  `https://myaccount.google.com/permissions` stops every call at once.
- **Not done**: no data from other channels or other users is collected beyond the public comments
  under the owner's own videos; nothing is sold, shared or used for advertising.

## Screens to attach

1. Shipcast's **Channels → YouTube** page with the Connect button (the consent flow starts there).
2. Google's consent screen as Shipcast opens it, showing the three scopes.
3. A launch's page in Shipcast listing its two YouTube videos with their links and numbers.
4. The drafts pull request where the owner reviews the videos' titles and descriptions before they are
   published.
5. The Comments page with a drafted reply waiting for approval.

## Privacy policy

`https://josegarrido.dev/privacy/` (the blog's privacy page, which the launches repo holds). Before
sending the form, the page must say, in English and Spanish: that Shipcast uses YouTube API Services; a
link to the YouTube Terms of Service (`https://www.youtube.com/t/terms`) and to the Google Privacy Policy
(`https://policies.google.com/privacy`); what is kept and for how long (the section above); and how to
revoke access (`https://myaccount.google.com/permissions`). This is the owner's step, since the page is
the owner's site and its text is the owner's.

## After sending

Google answers by email, usually within weeks. Until then the videos stay private, which Shipcast shows
as "private until Google audits the project". Once audited, new uploads can be public; the ones
already up can be made public from YouTube Studio.

## Related

[[decisions/youtube.md]] · [[plans/goal-refactor.md]] · [[plans/goal-v0.2.md]]