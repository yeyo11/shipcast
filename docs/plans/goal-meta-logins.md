---
created_at: 2026-11-05T11:44:52.291489772Z
updated_at: 2026-11-05T11:52:18.609764112Z
tags:
    - plan
    - goal
    - oauth
    - instagram
    - facebook
    - handoff
---
# Goal: every Meta login and the Facebook channel, ready for the owner to test

The brief of an autonomous run, agreed with the owner on 2026-11-05. It builds
[plans/meta-logins.md](meta-logins.md) by its implementation plan,
[plans/meta-logins-implementation.md](meta-logins-implementation.md), from Task 1 to Task 9, until
everything is on `main`, deployed, and the owner only has to set up their Meta app and try it. Where
this brief and a guess disagree, this brief wins; where it is silent, the spec, the plan,
[../../CLAUDE.md](../../CLAUDE.md) and the decisions in `docs/decisions/` decide.

**The run never waits for the owner.** Everything that needs them is collected at the end, in the
report and in "What the owner does after the run".

## Decisions the owner took for this run

| Question | Decision |
| --- | --- |
| Scope | Instagram through Instagram Login, Unified Login and Facebook Login for Business; Facebook Pages as a full channel; a Facebook account only as a way to log in; Threads unchanged |
| Who uses it | Each install with its own Meta app; Shipcast is not a Tech Provider |
| The spike (plan, Task 0) | **Skipped in this run**: it needs the owner's app. Build with the plan's stated fallbacks (the Page token for Instagram; the post metrics `post_impressions_unique`, `post_clicks`, `post_reactions_by_type_total` and the Page metrics `page_follows`, `page_post_engagements`), each refused metric dropped by name at run time as Instagram's are. The spike's three questions go into the owner's test list |
| Real accounts | **No real Meta call** in the run: every flow is proven with fakes and in a preview. The owner's Instagram account keeps working on Instagram Login untouched |
| Execution | Subagent-driven: one fresh implementer per task and a fresh reviewer after it; a whole-branch review on the most capable model before the last push |
| Pushes | After Tasks 4, 5, 8 and 9, each only when Sluice's gates pass; a push to `main` deploys to apps-1 on its own |

## Rules for the run

- **How work is done**: verify only through Sluice's `verify` (never `pnpm test` or `tsc` in the
  shell; a gate killed for memory is rerun unchanged, never around Sluice); documents only through
  pando's `kb_add_document`, which writes into the main checkout's `docs/`: copy the file into the
  worktree, then remove or restore it in the main checkout, which stays on `main`, clean; stage files
  by name, never `git add -A`; Conventional Commits with the `Co-Authored-By` line; work in your own
  worktree from `origin/main` and push straight to `origin main`.
- **Production is on apps-1, and a push to `main` is a deploy** (`.github/workflows/deploy.yml`).
  Never start or deploy Shipcast on the laptop. Before each push, the deploy checklist: no scheduled
  post due in the next 20 minutes; a `pg_dump -Fc` on the server with a copy in `data/backups/`; the
  table counts, compared after the deploy. Server access is `tailscale ssh yeyo@apps-1`; if Tailscale
  asks for the owner's browser check, push anyway (this run has no migration, so the data is not at
  risk), say in the report that the backup was skipped, and still check the health. After each
  push, wait for the Image and Deploy workflows (`gh run watch`) and check
  `https://shipcast.josegarrido.dev/api/health`. If it fails, fix forward or revert the commit at once.
- **Existing accounts are sacred.** The owner's Instagram account (Instagram Login, settings with no
  `login`) must keep publishing and refreshing: the plan's Review Focus 1 and 2 are tested, and
  after the Task 4 push the account's check on the Channels page is still green.
- **Migrations**: none are expected (settings are rows, accounts keep JSON settings). If one becomes
  necessary it is additive only, and its push waits for the backup.
- **Previews never touch TLS**: a preview has `SHIPCAST_APP_TLS=off`, its own keychain service and
  its own throwaway Postgres. Use the `run` skill's preview mode to show the Settings choice, the
  Connect buttons and a Facebook card.
- **No secret, id or token** in any document, commit or log line.
- **When something blocks**: a gate that keeps failing, an interface the plan got wrong, a Meta fact
  that contradicts the spec. Fix it the way the spec intends, record the change in the plan's task
  and in the decision record, and continue. Stop only for something that would lose the owner's data
  or break production for good, and say why.

## Milestones

1. Tasks 1 to 4: variants, Meta's flows, Instagram on `graph.facebook.com`, Unified Login. Push.
   A new Meta app can connect Instagram from here on.
2. Task 5: Facebook Login for Business for Instagram. Push.
3. Tasks 6 to 8: the Facebook channel, its connector and adapter, shown in a preview. Push.
4. Task 9: the decision record and the reference documents, `status.md`, the spec's Status. Push.
5. The whole-branch review's findings fixed, the gates green, the last deploy healthy.

## Done means

- Every task's tests pass in Sluice, `app-parity` and `mcp-parity` included.
- `main` deployed and healthy; the owner's existing Instagram account still checks green.
- Settings offers the Meta app id and secret, the Instagram setup (`instagram`, `unified`,
  `facebook`) and the two configuration ids; Channels offers Facebook.
- `decisions/meta-logins.md` exists; `accounts.md`, `publishing.md`, `launch-yml.md`,
  `content-pack.md` and `status.md` say what was built.
- The final report, in Spanish, lists the commits, what was proven and how, what is still unproven
  against Meta, and the owner's test list below, adjusted to what was really built.

## What the owner does after the run

1. **Meta app for Unified Login** (a new app, or the user's): owned by a business portfolio;
   Instagram use case → API setup with Unified login → a configuration whose token never expires,
   with the redirect URL `https://<app>/auth/instagram/callback`. In Shipcast Settings: the Meta app
   id and secret, the Instagram setup `unified`, the configuration id. Connect Instagram; publish a
   test launch with Instagram on `approval`.
2. **Facebook Page**: the "Manage everything on your Page" use case, a Facebook Login for Business
   configuration with a User access token and the Pages permissions, the redirect URL
   `https://<app>/auth/facebook/callback`. In Settings the Facebook configuration id. Connect
   Facebook, publish a test launch with Facebook on `approval`, edit it, delete it, read its numbers
   the next hour.
3. **Facebook Login for an Instagram linked to a Page** (optional): the Instagram setup `facebook`
   in an app with that setup; connect and check.
4. **The spike's three questions**, answered by those tests: does Instagram on `graph.facebook.com`
   take the Page token; which Page metrics Meta accepts (the account's sync line names any it
   refused); does the Unified configuration's token report no expiry.

## Related

[[plans/meta-logins.md]] · [[plans/meta-logins-implementation.md]] · [[accounts.md]] · [[status.md]]
