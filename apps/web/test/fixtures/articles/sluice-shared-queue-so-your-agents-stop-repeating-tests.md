[Sluice](https://github.com/josegarridodigio/sluice) is a verification queue and cache shared by all the AI agents on a Linux machine: it runs each *gate* (tests, linters, type checks) only once per git tree, under a common CPU and memory budget, and stores the result. It is open source (MIT license), written in Rust, and works with any AI coding agent: the git hooks need nothing from the agent, agents that support MCP connect to its MCP server, and Claude Code also has a plugin. I built it, and in this article I tell you why, how to install it and what has changed on my machines, with the measured numbers.

![sluice status on a machine with agents working all day: 1,874 runs, 1,147 cache answers and 19 h 24 min saved](/articles/sluice-una-cola-compartida-para-que-tus-agentes-no-repitan-los-tests/sluice-status.png)

## What problem does it solve?

In my day job I build software for clients with AI agents. On a normal day I have dozens of agents running at once (I use Claude Code), each in its own git *worktree*, on projects with expensive checks: test suites that take several minutes, linters and type checks wired into `pre-commit` and `pre-push`. Those hooks are defined by each project's team and I can't always touch them.

Nothing coordinated those agents. Working with several AI agents in parallel, my machine spent the day running the same tests and builds over and over, until it ran out of memory, and pushes took forever. What made me say "enough" was watching the desktop give up: GNOME stopped responding and Linux started killing processes on its own. The kernel's OOM killer took out the browser and the applications, and `systemd-oomd` took out the agents' own tools.

There were three separate causes behind it:

1. **Uncontrolled concurrency.** Each agent launches its checks on its own, directly or from git hooks.
2. **Redundancy.** The same tree is verified many times: the agent before committing, then `pre-commit`, then `pre-push` (which repeats `pre-commit`), and again after a *rebase* that changes nothing. I measured it with Sluice itself: of all the checks requested, 52% on the development machine (1,426 of 2,742) and 38% on the second machine (1,142 of 3,016) were on code that was already verified.
3. **Excessive scope.** Full suites where a subset would do. That is up to each project, not Sluice.

And one constraint that complicates everything: an agent's shell tool has a timeout. A hook that sits waiting in a queue inside `git commit` ends up cut off, and the agent still doesn't know whether the commit happened. That's why Sluice answers fast in hooks and really waits over MCP.

## What do you need?

- Linux (it only works on Linux) with `git` 2.31 or later. There are static binaries for x86_64 and aarch64.
- An AI coding agent. Any agent that supports MCP can use the MCP server (`sluice mcp`); for Claude Code there is also a plugin that sets everything up.
- To isolate jobs: cgroup v2 and a systemd user manager. The memory policy uses `systemd-oomd` with systemd 257 or later. `sluice doctor` tells you what you have.

## How do I install it?

The binary installs to `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/josegarridodigio/sluice/main/scripts/install.sh | sh
```

`SLUICE_VERSION` pins a specific version and, later on, `sluice update` updates in place while verifying the checksum. Then connect your agent. In Claude Code, install the plugin:

```
/plugin marketplace add josegarridodigio/sluice
/plugin install sluice@sluice
```

With any other agent that supports MCP, register `sluice mcp` as an MCP server in its configuration and paste into its `AGENTS.md` the instruction block from the [agents guide](https://github.com/josegarridodigio/sluice/blob/main/docs/agents.md). If the agent sets no variable Sluice recognises, export `SLUICE_AGENT=1` in its shell so the hooks know it is an agent; and if it only has a shell, `sluice shim install`, with the shims directory first in its `PATH`, puts its builds and tests in the queue too.

And in each repository, first look at what it would do and then write it:

```bash
sluice init --dry-run   # detects the stack and your hooks; shows the plan, writes nothing
sluice init             # writes .sluice.toml and rewires your hooks
```

With the Claude Code plugin you don't need to touch the `PATH` or `CLAUDE.md`: at the start of each session, it installs some shell *shims*, puts them first in the session's `PATH` and gives the agent the rules. A *gate* is a named command in `.sluice.toml`:

```toml
version = 1

[gates.test]
cmd = "npm test -- --maxWorkers=2"
weight = 4
hooks = ["pre-commit", "pre-push"]
```

`weight` is how many units of the budget the *gate* takes up, roughly the CPU threads it uses. With `weight = "auto"`, Sluice starts at half the budget and learns a lower one from the measured runs.

## What happens when a tree has already passed?

It doesn't run again. The cache key is the exact content of the working tree plus the *gate* definition, and all the repository's *worktrees* share it. If another agent, or your `pre-commit` hook, already verified that tree, the answer comes from the cache without even going through the daemon:

![sluice gate list and two sluice run answered from the cache: typecheck in 0.22 s and test in 0.24 s](/articles/sluice-una-cola-compartida-para-que-tus-agentes-no-repitan-los-tests/sluice-cache-hit.png)

That `typecheck` took 54 seconds the last time it really ran; now it answers in 0.22 s. In this repository the answer includes running `pnpm --version`, because it's declared in `key_inputs`: the output of those commands goes into the key, so changing pnpm version invalidates the cache, and they run on every query. Without them, on my development machine, a cache answer costs about 25–30 ms.

If you want to see why Sluice decides what it decides, `--explain` shows you the tree, the key and the lookup result without running anything:

![sluice run --explain typecheck: the git tree, the cache key and a HIT from an hour ago](/articles/sluice-una-cola-compartida-para-que-tus-agentes-no-repitan-los-tests/sluice-explain.png)

If two agents ask for the same thing at the same time, it runs once and both get the result (*coalescing*).

This is what has been saved, measured in each daemon's database, not counting cancelled jobs:

| | Second machine (12 threads, 30 GB) | Development machine (20 threads, 30 GB) |
| --- | --- | --- |
| Period | Oct 24 → 29 (5.8 days) | Oct 22 → 28 |
| Checks run | 1,874 | 1,316 |
| Cache answers | 1,142 | 1,426 |
| Run time saved | 19.2 hours | 8.6 hours |

In total, about 28 hours of tests and linters that did not run in a week, because that exact code was already verified. On the second machine, the daily saving ranges from 1.9 to 5 hours. The screenshot at the top is from that machine, a few hours later, with a few more cache answers.

Sluice doesn't make tests faster: it avoids repeating them, orders when they run and protects the machine.

## How does it keep the machine from running out of memory?

On the second machine, with 5 agents working at once, the system log shows out-of-memory episodes on three different days (October 22, 25 and 26). In the worst one, on the morning of the 26th, the system was killing processes for about 20 minutes, up to 6 per minute. Sluice recorded 15 interventions by the kernel or `systemd-oomd` on agent sessions, and a single *gate* reached 18 GB.

Version 0.6.0 (October 26) changed three things:

- **Memory admission.** Sluice learns how much memory each *gate* uses (the largest *working set* of its last 5 runs, plus 20%) and doesn't start one that doesn't fit in the available memory minus a reserve for the desktop and the agents (by default, 10% of memory).
- **Isolation.** Each job runs in its own cgroup.
- **Preferred victims.** If memory still runs short, the kernel and `systemd-oomd` pick a verification job before your desktop or your agents.

`sluice doctor` shows you how it ends up configured on your machine:

![sluice doctor: full containment with cgroup v2, jobs with oom_score_adj of 800 or more and systemd-oomd acting on gates before agents](/articles/sluice-una-cola-compartida-para-que-tus-agentes-no-repitan-los-tests/sluice-doctor.png)

Since the afternoon of October 26: **0 out-of-memory episodes** on the second machine, across about 780 checks and 2.5 days of agents working, nights included. I don't count a deliberate, bounded test I ran that same day at noon.

Version 0.8.0 fixed the opposite case: a *gate* with no history reserved an inflated estimate. A `pytest` reserved 13.8 GB, waited 26 minutes, ran in 1 min 40 s and used around 1 GB. Now the first run starts as a probe, measures what it really uses and also learns from the ones that fail: waits caused by guessed estimates went from 7 in one day to 0 the first night.

## Why did a 0.1-second linter wait 23 minutes?

Because it was waiting behind a giant. On October 28, with the previous version, the test suite of a pnpm monorepo used about 12 GB on each run (20 measured runs, between 11 and 13 GB). With 30 GB only one fits at a time. When that suite waited for memory at the head of the queue, it reserved its turn and everything else waited behind it:

- a linter that takes 0.1 seconds waited between 15 and 23 minutes;
- a 19-second `typecheck` waited about 4 minutes;
- 48% of all queue time was of this kind, and 91% of those jobs lasted less than a minute.

Meanwhile the CPU was almost idle: 40% of the time with jobs in the queue, it was idle.

Version 0.8.0 brings *backfilling*, the technique used by supercomputing schedulers such as Slurm. Sluice predicts when the head job can start from how long the running jobs take, and lets one from behind go ahead only if it fits now and doesn't delay the head: either because the head will still fit next to it, or because its learned duration, with margin, ends sooner. `[scheduler] backfill = false` goes back to strict reservation.

| | Before: Oct 28 day, 12 h | After: night of Oct 28–29 with 0.8.0, 12 h |
| --- | --- | --- |
| Checks | 316 | 202 |
| Run minutes | 510 | 380 |
| Queue wait minutes | 981 | 167 |
| **Wait per minute of work** | **1.92 min** | **0.44 min** |
| Worst wait of a job under 1 min | 27 min | 12 min |
| Idle CPU while there was a queue | ~40% | 4.8% |
| Jobs that went ahead of the head | — | 10 |
| Total delay that caused to heads | — | 4 min 52 s |

Read it carefully: it is not a controlled experiment. It's 12 hours of daytime with the old version against 12 hours of night with the new one, with different workloads. That's why I compare wait per minute of work, about 4.4 times lower, and not absolute wait. And there is a cost: letting jobs through delayed the heads by 4 min 52 s in total that night. Sluice measures it and shows it in `sluice status` (the `backfill` line in the screenshot at the top) precisely so you can keep an eye on it.

## What if a test hangs?

On October 28, a project's tests hung four times, waiting for something that never arrived. Each time they held the queue and up to 7.6 GB of memory for the 30 minutes of the limit. In three of them the tests had already finished and a single file hung for 25 minutes or more.

Since 0.8.0, every 5 seconds the daemon looks at what each job is doing: CPU time, disk I/O, page faults, number of processes and log bytes. A job with no progress at all for `max(5 min, 3 × its usual duration)` shows up as `STALLED` in `sluice status`, and the agent gets the warning in the `verify` progress. Sluice never kills it: the *gate*'s `timeout` is still the only limit. I decided it this way so there is no false positive that costs a good job. A *gate* that is meant to stay still (a `watch`, a server) can set `stall_timeout = "off"`.

The first night: 0 hangs and 0 false warnings across 177 jobs. The longest silence of any job was 20 seconds.

## What if I can't touch the repository's hooks?

It happened to me in a client's Angular repository that uses husky. The hooks belong to the client and their team, so I couldn't rewrite them, and husky prepends its own `PATH`: each commit's tests ran outside the queue and the cache. Minutes per commit, competing with everything else.

Since 0.7.0, Sluice can be the entry point for your clone's hooks without modifying the repository:

```bash
sluice hooks on       # or, when configuring: sluice init --hooks entry
sluice hooks status   # which hook goes through the queue and which is delegated, and why
```

`on` points `core.hooksPath` to a hooks directory inside the clone's git directory, from a file included in its configuration, so husky's write on each install doesn't displace it. `off` removes it, and if the `sluice` binary is missing, the repository's hooks keep working.

The design rule is: either I understand it entirely, or I run it untouched. Before writing it I read the source code of husky, lefthook and pre-commit. A hook that Sluice fully understands runs its commands as queue jobs, in the manager's order: read-only ones, like tests or linters, go to the cache, and those that can change files, like `lint-staged`, always run. Any other hook runs exactly as before.

In a repository without `.sluice.toml`, those hook units become the `verify` *gates*, with the same cache inputs: a `verify` before `git commit` turns the commit hook into a cache answer.

## How does an agent use it without hitting the shell timeout?

Through MCP. `sluice mcp` exposes a `verify` tool that blocks until the *gates* finish and sends a progress notification every 15 seconds. Claude Code, for example, only cuts an MCP call if its inactivity window (30 minutes by default) passes with no response or progress, so the agent waits as long as needed, without the shell's limit.

In Claude Code, the rest of the plugin steers the agent that way: a *skill* that teaches it to use `verify` and the merge queue, and a *guard* that rewrites the *gates*' commands to `sluice run <gate> -v` and heavy ones (builds, test runners) to `sluice exec -- ...`, so they share the budget. With other agents, the `AGENTS.md` block carries the same instructions as the skill. And if an agent commits with a tree that isn't in the cache, the hook rewired by `sluice init` answers immediately with exit code 3 and tells it to use `verify`, instead of waiting inside `git commit`.

## How do I integrate the branches of several agents?

With the local merge queue. An agent finishes its branch, passes `verify`, commits and enqueues it. The daemon combines the queued branches onto the target in a disposable *worktree* (a "train") and runs the *gates* once on the combined tree, with the same cache and the same budget:

```bash
sluice queue enqueue           # the agent does this, or you
sluice queue status            # the plan: trains, conflicts and what is ready
sluice queue approve <train>   # you do this
```

By default, nothing is pushed until a person approves the train: the daemon rejects an agent's approval, over MCP or from the terminal, and the Claude Code plugin blocks it too. You can allow it explicitly in your personal configuration (`allow_agent_approval = true`); a repository can't turn it on by itself. Even so, two cases remain human-only: a train that changes the project's own verification configuration and landing through a *pull request*. If your target branch is protected and only accepts *pull requests*, `[queue] land = "pull-request"` pushes the verified result to a `sluice/train/<id>` branch and, on approval, opens the *pull request* with your own `gh`. Sluice never does the merge.

## How did I build it?

With AI agents, and verified with Sluice itself: every commit of the project goes through its own queue and its own cache. The first commit is from October 22 and 0.8.0 came out on the 28th: from 0.1.0 to 0.8.0 in a week, with about 190 commits, about 105,000 lines of Rust and 25 architecture decisions (ADRs) documented in the repository.

Each big change followed the same cycle: analysis of the code and of real data from the two machines, proposals with their risks, my decision recorded in an ADR, implementation in waves with agents, and review. Before each version, CI on 7 combinations: Ubuntu 22.04 and 24.04, Debian, Fedora, Alpine, ARM and the minimum git version. Several times the review found bugs the tests didn't see, and CI uncovered problems that only existed on Alpine or Fedora. And almost every version was born from a problem I saw using Sluice daily: memory in 0.6.0, hooks in 0.7.0 and the stuck queue in 0.8.0.

## Try it

Install the binary and connect your agent as above, and in your repository:

```bash
sluice doctor
sluice init --dry-run
sluice init
sluice status
```

The code, the documentation and the 25 ADRs are at [github.com/josegarridodigio/sluice](https://github.com/josegarridodigio/sluice). If something doesn't work for you, `sluice doctor --bundle` generates a diagnostic bundle, with sensitive data removed, to attach to an *issue*.
