import { z } from 'zod';
import { cursor, HINTS, limit, tool, type ShipcastTool } from './shared.ts';

/* The background work: every tool that starts a job points here to follow it */

export const guide = 'Jobs: list_jobs pages through the last day\'s background work, newest first; follow every job a tool started there until it ends.';

export const tools: ShipcastTool[] = [
  tool({
    name: 'list_jobs',
    title: 'List jobs',
    description:
      'The background work running or finished in the last day (drafting, publishing, reading numbers), newest first, with each job\'s state and log. Follow a launch_repo, approve_drafts, write_article or retry_channel here. Pages with `cursor` (the `next` of the previous page).',
    operations: ['listJobs'],
    input: z.object({ limit: limit(30), cursor }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/jobs', { query: { limit: args.limit, cursor: args.cursor } }),
  }),
];
