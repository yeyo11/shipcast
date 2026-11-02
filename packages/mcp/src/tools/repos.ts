import { z } from 'zod';
import { HINTS, tool, type ShipcastTool } from './shared.ts';

/* The repos and releases a launch is made from, and the pre-flight that says whether one can launch */

export const guide =
  'Repos: list_repos gives the GitHub repos a launch can be made from, list_releases a repo\'s releases with the launch already made of each (a release launches only once), and check_repo runs the pre-flight of one release without launching it: call it before launch_repo, and fix what it reports first.';

const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name').describe('The GitHub repo, owner/name, as list_repos gives it');

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_repos',
    title: 'List repos',
    description:
      'The GitHub repos of the brand\'s owner that Shipcast can launch, newest push first, with their description (forks and archived repos are left out). The list is cached for a few minutes, so a repo created a moment ago may be missing. Read-only.',
    operations: ['listRepos'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/repos'),
  }),
  tool({
    name: 'list_releases',
    title: 'List a repo\'s releases',
    description:
      'A repo\'s published releases on GitHub, newest first (tag, name, date, whether it is a pre-release), each with `launch`: the launch already made of that release (its id and status, for get_launch), or null when it was never launched. A release is launched only once, so use this to see whether a release was already launched before offering launch_repo; launching one that has a launch is refused. Read-only.',
    operations: ['listReleases'],
    input: z.object({ repo }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/repos/releases', { query: { repo: args.repo } }),
  }),
  tool({
    name: 'check_repo',
    title: 'Check a repo before launching',
    description:
      'The pre-flight of a repo at a release, without launching it: whether the release is published, .github/launch.yml is valid and enabled, there is a recognised license and a README, and the demo answers. `ok` is true when every required check passes; each check carries one sentence to act on. This is the step before launch_repo, which runs the same checks and refuses a repo that fails them: show the user what failed so they can fix it first. Read-only; it reads GitHub and changes nothing.',
    operations: ['checkRepo'],
    input: z.object({
      repo,
      ref: z.string().min(1).max(140).optional().describe('The release tag, like v1.2.0; the latest release when left out, as launch_repo takes it'),
    }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/repos/preflight', { query: { repo: args.repo, ref: args.ref } }),
  }),
];
