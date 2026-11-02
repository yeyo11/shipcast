import { SCHEDULABLE_CHANNELS } from '@shipcast/schema';
import { z } from 'zod';
import { HINTS, launchId, postId, tool, ToolRefused, type ShipcastTool, type ToolHints } from './shared.ts';

/* Scheduling: when each channel's piece of a launch goes out, the recommended times, and the owner's timezone */

export const guide =
  'Scheduling: recommend_times and get_timezone come before schedule_launch, which sets a time per channel (publishing still waits for approve_drafts); reschedule_post and cancel_scheduled_post change one scheduled post; set_timezone sets the owner\'s zone.';

const channels = SCHEDULABLE_CHANNELS.join(', ');

// The route's own check (moment() in apps/web/src/server/requests.ts): without an offset a time would be read in the server's zone
const moment = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/, 'an ISO 8601 date-time with its offset, such as 2026-10-27T17:00:00+01:00')
  .describe('ISO 8601 with its offset (Z or ±hh:mm), such as 2026-10-27T17:00:00+01:00; at most 60 days ahead');

const schedulable = z.enum(SCHEDULABLE_CHANNELS);

/*
 * Neither preset fits: these writes stay in Shipcast, but they decide what goes public and when, and
 * a time that has come sends a piece out on the next publish run.
 */
/** Sets or moves a time: overwrites the slot it had, and a time now or past reaches the network on the next run */
const RETIMES: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
/** Takes a channel out of a launch's publishing; nothing outside Shipcast is touched */
const WITHHOLDS: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const tools: ShipcastTool[] = [
  tool({
    name: 'schedule_launch',
    title: 'Schedule a launch\'s channels',
    description:
      `Set the time each named channel's piece of a launch goes out, instead of the moment the launch is published; a channel scheduled already is moved. Approval still comes first: nothing goes out while the drafts wait for approve_drafts, and a piece whose time passed before then goes out with the approval. Every time carries its own offset, a time without one is refused: give the owner's zone's offset (get_timezone, recommend_times give the times in it). The channels are ${channels}; a channel off in launch.yml or already out, a time over 60 days ahead and a launch already published, skipped or failed are refused. A time already past publishes it publicly on the next run: confirm the times with the user.`,
    operations: ['scheduleLaunch'],
    input: z.object({
      launch_id: launchId,
      times: z.partialRecord(schedulable, moment).describe('Channel to time, such as {"bluesky": "2026-10-27T17:00:00+01:00"}; at least one'),
    }),
    hints: RETIMES,
    run: (api, args) => {
      if (Object.keys(args.times).length === 0) throw new ToolRefused(`schedule_launch needs at least one channel and its time, among ${channels}`);
      return api.call('POST', `/launches/${args.launch_id}/schedule`, { body: { times: args.times } });
    },
  }),
  tool({
    name: 'reschedule_post',
    title: 'Move a scheduled post',
    description:
      'Move one scheduled piece (a post of get_launch with status `scheduled`) to another time, at most 60 days ahead. A time now or already past sends it on the next publish run, which publishes it publicly on its network once the drafts are approved: confirm with the user first. A piece already out is refused.',
    operations: ['reschedulePost'],
    input: z.object({ post_id: postId, at: moment.describe('The new time, ISO 8601 with its offset, such as 2026-10-27T17:00:00+01:00; now or past sends it on the next run') }),
    hints: RETIMES,
    run: (api, args) => api.call('PATCH', `/posts/${args.post_id}/schedule`, { body: { at: args.at } }),
  }),
  tool({
    name: 'cancel_scheduled_post',
    title: 'Cancel a scheduled post',
    description:
      'Cancel one scheduled piece (a post of get_launch with status `scheduled`): its channel is then not published at all for that launch, until schedule_launch sets it a time again. Nothing on a network changes. To send it now instead, use reschedule_post with the current time. Ask the user before taking a channel out of a launch.',
    operations: ['cancelScheduledPost'],
    input: z.object({ post_id: postId }),
    hints: WITHHOLDS,
    run: (api, args) => api.call('DELETE', `/posts/${args.post_id}/schedule`),
  }),
  tool({
    name: 'recommend_times',
    title: 'Recommend times to publish',
    description:
      `The best times to publish on a channel in the next days, ranked, one per day at most: each with its UTC moment (\`at\`, ready for schedule_launch), the time in the owner's zone, a score against the channel's median post and the reason (the channel's defaults, its own history, Instagram's online-follower hours). The channels are ${channels}. Only reads.`,
    operations: ['recommendTimes'],
    input: z.object({
      channel: schedulable.describe(`A channel Shipcast publishes and schedules: ${channels}`),
      days: z.number().int().min(1).max(30).optional().describe('Days ahead, 1 to 30; 7 by default'),
      count: z.number().int().min(1).max(30).optional().describe('How many times, 1 to 30; 5 by default'),
    }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/recommendations', { query: { channel: args.channel, days: args.days, count: args.count } }),
  }),
  tool({
    name: 'get_timezone',
    title: 'Get the owner\'s timezone',
    description: 'The owner\'s time zone, an IANA name (Europe/Madrid until one is set): the zone recommend_times tells its times in, and whose offset a time for schedule_launch or reschedule_post should carry.',
    operations: ['getTimezone'],
    input: z.object({}),
    hints: HINTS.read,
    run: (api) => api.call('GET', '/settings/timezone'),
  }),
  tool({
    name: 'set_timezone',
    title: 'Set the owner\'s timezone',
    description:
      'Set the owner\'s time zone, the one recommend_times and the app tell times in, as an IANA name such as Europe/Madrid, America/New_York or UTC. An offset such as +01:00 is refused, since it has no summer time and would put the times an hour off half the year. Times already scheduled keep their moment. Setting the same zone again changes nothing.',
    operations: ['setTimezone'],
    input: z.object({ timezone: z.string().min(1).max(64).describe('An IANA zone, such as Europe/Madrid; not an offset') }),
    hints: HINTS.setting,
    run: (api, args) => api.call('PATCH', '/settings/timezone', { body: { timezone: args.timezone } }),
  }),
];
