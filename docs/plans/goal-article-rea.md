---
created_at: 2026-10-27T08:54:52.491569356Z
updated_at: 2026-10-27T08:54:52.491569356Z
tags:
    - plan
    - goal
    - article
    - content
    - rea
    - blog
---
# Goal: an article on REA, set up and tried on YouTube's web client

The brief for an autonomous run, agreed with the owner on 2026-10-27. The run researches, tests,
writes and stages one blog article, end to end, and stops at the owner's approval. Everything here
was decided in conversation; where this brief and a guess disagree, this brief wins, and where it is
silent, the project's rules ([../../CLAUDE.md](../../CLAUDE.md)) and the brand
([../brands.md](../brands.md)) decide.

## What the owner asked for

- **The topic**: REA (Reverse Engineer Anything), an open-source toolkit that lets coding agents
  inspect software without its source, shown **how to set it up** and then **used on a popular
  app: YouTube**.
- **The format**: a tutorial plus a demonstration. Part one, setting REA up step by step with
  Claude Code; part two, pointing it at YouTube's web client and reporting what it finds, checked
  against what really happens in the browser.
- **Who writes**: the agent, alone, start to finish, with screenshots and real command output.
  The owner only reviews and approves at the end.
- **Where it goes**: the blog in Spanish and English and every connected channel **except Reddit**.

## Red lines (decided, not open)

The owner first proposed "an ad-free YouTube with every Premium feature for free". That was
declined and the owner agreed to the angle above. The article must not:

- show, hint at or link to how to remove or skip ads, unlock Premium features (background play,
  downloads…), defeat DRM, or decipher the signed/throttled stream URLs (the `n`/`sig` parameters
  yt-dlp handles); not even as "what you could do next";
- download or save videos;
- reproduce large blocks of YouTube's code: quote at most a few lines at a time, always with what
  file they came from, as commentary;
- analyse the Android or iOS app (it would mean an APK from a third-party mirror, and the disk is
  short), or any login-only part of the site: the run uses **no Google account**.

If a finding drifts towards one of these (REA will happily explain how ads are inserted), leave it
out of the article. Describing that YouTube's player reports telemetry or picks a quality is fine;
describing how to block or forge it is not. Google's terms forbid reverse engineering their
software; the defensible ground is observing what any browser already downloads and sends, as
DevTools would, and explaining it.

## Facts established on 2026-10-27

Checked against the source, not only search results:

- Official project: **github.com/morluto/rea** (MIT; about 394,000 stars on 2026-10-27; pushed
  daily). npm package **`rea-agents`**, latest **6.8.0** (2026-10-25). Its site is linked from the
  repo; reverseengineeranything.org, .co and .com and a SourceForge mirror are **not** official and
  must not be linked.
- The REA skill installed on this machine (`~/.claude/skills/reverse-engineer-anything`, version
  42) quotes `rea-agents@6.5.0` in its examples; use **6.8.0** and pin it in every command shown.
- `npx -y rea-agents@6.8.0 --help` works on Node 24.22.1; npm prints a `prebuild-install`
  deprecation warning, harmless. The CLI has the web commands the demo needs:
  `list-browser-targets`, `inspect-web-page`, `observe-web-session`, `observe-web-execution`,
  `analyze-web-bundle` (`--fetch-source-maps`, `--detail summary --evidence_output`),
  `capture-browser-scenario`, `capture-web-screenshot`, `export-web-scripts`, `compare-web-captures`,
  `inspect-web-network-capture`, and `doctor`, `setup` (`--client claude_code --dry-run --json`),
  `mcp add`, and `--mcp` (stdio MCP server). Read `--help` and `--schema` of each before using it.
- Web targets need **neither Ghidra nor IDA**: nothing native is installed and nothing has to be.
- A headless Chrome works as the target: `google-chrome --headless=new
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9333
  --user-data-dir=<new empty dir> --lang=en-US --window-size=1280,800`, run as a transient
  `systemd-run --user --unit rea-chrome` so it can be stopped. Driving it with `playwright-core`'s
  `connectOverCDP` (resolve it from `apps/web`), `https://www.youtube.com/watch?v=jNQXAC9IVRw`
  ("Me at the zoo", the first video on YouTube, 19 s) loaded with no consent wall from this
  network in `en-US`; handle a "Reject all" button if one appears. Always reject cookies, never
  accept.
- REA's passive tools observe what someone else does in the page; `capture-browser-scenario`
  performs declared actions itself. Say which one did what in the article, as REA's docs insist.
- The disk had about 10 GB free. Check `df -h /` before big steps; stop and clean up under 5 GB.

## The work, in order

### 1. Set REA up as a reader would, isolated

- Work in a new directory, `/tmp/rea-article/`, with `evidence/` (raw JSON, logs), `shots/`
  (screenshots) and `sandbox/` (the Claude Code project a reader would create).
- Run `npx -y rea-agents@6.8.0 doctor --client claude_code --json` and `setup --client claude_code
  --dry-run --json`; record what they report.
- **Never change the owner's own Claude Code configuration** (`~/.claude.json`,
  `~/.claude/settings.json`, the installed skill). Register REA only in the sandbox, project-scoped:
  `cd sandbox && claude mcp add --scope project rea -- npx -y rea-agents@6.8.0 --mcp` (check the
  exact form against `rea mcp add --help` and `claude mcp add --help`; it writes `sandbox/.mcp.json`).
- Show it working from Claude Code in headless mode inside the sandbox: `claude -p "<a question
  for REA about the open YouTube page>" --mcp-config .mcp.json --allowedTools "mcp__rea__*"`
  (`--output-format stream-json --verbose` to keep which tools were called). Keep the prompt and the
  full output.

### 2. Point it at YouTube's web client

Start the isolated Chrome, open the video and let it play (mute it). Then answer three questions,
each with REA and each **checked independently** (Chrome DevTools Protocol network events through
Playwright, `performance.getEntries()`, the player's own "Stats for nerds" panel):

1. **What does the page load before the video starts?** Scripts, their sizes, the player bundle
   (`base.js`), what is fetched in parallel. REA: `inspect-web-page`, `analyze-web-bundle`.
2. **What does the browser send while you watch?** The media segment requests (`videoplayback`),
   and the reporting calls (`/api/stats/watchtime`, `/api/stats/qoe`, `/ptracking`, `/youtubei/v1/log_event`
   or whatever is really observed): when, how often, what kind of data in general terms (no
   cookie or identifier values). REA: `observe-web-session` over a playback window.
3. **How does the player choose a quality?** Throttle the connection through CDP
   (`Network.emulateNetworkConditions`) mid-playback and watch the `itag`/resolution change in the
   segment requests and in "Stats for nerds"; ask REA where in the bundle that decision lives
   (`analyze-web-bundle`, `observe-web-execution`). Report only what the evidence shows.

For each answer, record: the exact command, REA's output (trimmed, never edited), the independent
check, and whether they agree. **Where REA is wrong, vague, slow or fails, that is a result**: put
it in the article plainly, with the output. No claim goes in the article without its evidence in
`evidence/`.

### 3. Screenshots

All real; nothing mocked. At least:

- the YouTube page in the isolated browser, playing;
- `doctor` and the `.mcp.json` / `claude mcp list` showing REA registered;
- Claude Code answering through REA's tools (terminal output: render the **real, unedited** output
  in a terminal-styled HTML page with Playwright, monospace, the brand's dark look; say nothing in
  the image that was not in the output);
- each of the three findings: REA's output next to the independent check (DevTools-like network
  list, "Stats for nerds", the quality change);
- no cookies, tokens, account names, local usernames or paths under `/home` visible in any image:
  check each one before using it. Crop to what matters; 1280 px wide or less; PNG, then compressed.

### 4. Write the article

- Written by the agent in **Spanish from Spain** and **English**, following the brand's tone in
  [../brands.md](../brands.md): first person (the owner's voice), didactic and direct, the problem
  first, then the evidence (command, config, output); only what works today; no hype, no emojis in
  the article.
- Shape: why REA and what it is (two short paragraphs, the official links only) → set it up with
  Claude Code (pinned version, commands, screenshots) → the three questions on YouTube, each:
  question, command, what REA said, what the browser showed, verdict → what REA got right and
  wrong → how to repeat it (the commands in one block) → limits and the legal note in one or two
  lines (observe what your browser already receives; respect the site's terms; nothing here
  bypasses ads or protections).
- Around 1,500 to 2,500 words per language. Title under 70 characters, the description under 160.
- Every number, path and command in the text appears in `evidence/`. Re-run the full command block
  at the end on a fresh profile to prove it still works as written.

### 5. Stage it in Shipcast, stop at approval

- The free-article path: `POST /articles` (`{ title, markdown, lang, channels, direct: false }`,
  [../api.md](../api.md)) or the app's **Write** page; the AI translates and writes each channel's
  piece under the truth rule, and the drafts land as a pull request in the launches repo for review
  ([../launches-repo.md](../launches-repo.md)). A write-scoped token: `pnpm shipcast token create
  "article run" --scopes read,write`, revoked at the end.
- **Channels**: every connected one except `reddit` (check `GET /channels` or the Channels page:
  dev.to, Hashnode, Bluesky, Mastodon, Instagram, Threads, LinkedIn, Telegram, Discord, GitHub
  Discussions, the newsletter, whichever are connected). The article's language for the request:
  write the Spanish one by hand and let the pipeline translate only if the result matches the
  English the run wrote; otherwise put the run's own English into the drafts pull request.
- **Screenshots in the article body**: today an article's media are the generated ones
  (`og.png`, the carousel) under `public/launches/<project>/<ref>/`; the body's own images are not
  a documented feature. Find out how the blog serves images from an article body. If it needs a
  change in Shipcast, make it the smallest one that works for the blog, dev.to and Hashnode
  (absolute URLs on the blog's domain, available before those channels publish), with tests and
  its doc through `kb_add_document`, verified through Sluice, and pushed to `main` (the owner's
  rule since 2026-10-26: work straight on main), then deployed like the last deploy: back up the
  database to `data/backups/`, `git pull --ff-only` in the main checkout, `systemctl --user restart
  shipcast-app`, check `/api/health`. Otherwise commit the images to the drafts pull request.
- `direct: false` always. **Do not approve, merge or publish.** Check the drafts pull request's
  preview (the blog's preview URL per branch) renders both languages and every image, and that
  each channel's piece links the article and stays within its limit.

### 6. Report and clean up

- Stop the Chrome unit, delete its profile and the sandbox; keep `evidence/` and `shots/` in
  `/tmp/rea-article/` for the owner. Revoke the token.
- Report to the owner, in Spanish: the drafts pull request's link and its blog preview, the
  channels it will go to, the three findings with their verdicts, what REA got wrong, anything
  changed in Shipcast, and what is left for them (approve in the app).

## Done when

- [ ] REA 6.8.0 set up in the sandbox and used from Claude Code, with its output kept
- [ ] the three questions answered, each with REA's evidence and an independent check
- [ ] the screenshots taken, checked for private data, and in the article
- [ ] the article in Spanish and English, every claim backed by `evidence/`, the commands re-run
- [ ] the drafts pull request open in the launches repo, every channel but Reddit, rendering well
- [ ] nothing approved or published; the owner's configuration untouched; the token revoked
- [ ] the report to the owner

## Related

[[brands.md]] · [[api.md]] · [[launches-repo.md]] · [[publishing.md]] · [[content-pack.md]] · [[launch-yml.md]] · [[handoff-2026-10-26.md]] · [[ideas.md]]
