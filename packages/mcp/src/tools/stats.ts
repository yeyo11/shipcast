import { CHANNELS, STATS_METRICS } from '@shipcast/schema';
import { z } from 'zod';
import { accountId, HINTS, tool, type ShipcastTool } from './shared.ts';

/* Stats: the Stats page's numbers (overview, series, ranking), an account's growth, and whether search engines have indexed the articles */

export const guide =
  'Stats, all read-only: get_stats_overview gives a period\'s totals against another period, then get_stats_series follows one metric over time and get_stats_ranking says what did best; get_stats_accounts and get_account_growth give the audience, get_search_index_status what Google and Bing indexed. A period is the last 30 days unless from and to say otherwise.';

// The site's own sources besides the channels (the engine's SITE_SOURCES), which this browser-safe package cannot import
const SITE_SOURCES = ['search', 'bing', 'github'] as const;
// The API's series groupings, bucket sizes and ranking units (the engine's SeriesGroupBy, SeriesBucket and RankBy)
const GROUP_BY = ['channel', 'account', 'launch'] as const;
const BUCKETS = ['day', 'week'] as const;
const RANK_BY = ['post', 'launch', 'account'] as const;

const SOURCES = [...new Set<string>([...CHANNELS, ...SITE_SOURCES])] as [string, ...string[]];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const moment = z.string().min(1).max(40);
const day = z.string().regex(DAY, 'a day, YYYY-MM-DD');
/** Row ids as the API's filters take them: at most 100, the search tab's at most 50 */
const ids = (max: number) => z.array(z.number().int().positive()).min(1).max(max);

/** The period every /stats route takes: days both included, or ISO moments */
const period = {
  from: moment.optional().describe('The first day, YYYY-MM-DD, included (or an ISO 8601 moment); 29 days before `to` when left out'),
  to: moment.optional().describe('The last day, YYYY-MM-DD, included (an ISO 8601 moment is excluded); today (UTC) when left out'),
};

/** The same period as days only, for what the page reads per day (snapshots, the search tab) */
const days = {
  from: day.optional().describe('The first day, YYYY-MM-DD, included; 29 days before `to` when left out'),
  to: day.optional().describe('The last day, YYYY-MM-DD, included; today (UTC) when left out'),
};

const filters = {
  channels: z.array(z.enum(SOURCES)).min(1).max(100).optional().describe('Only these channels or site sources (search is Google Search Console, bing is Bing, github the repo\'s own numbers); every one when left out'),
  account_ids: ids(100).optional().describe('Only what these accounts published (ids from list_accounts); leaves out what no account published, such as the blog'),
  launch_ids: ids(100).optional().describe('Only these launches (ids from list_launches)'),
};

type Filters = { [K in keyof typeof filters]?: z.infer<(typeof filters)[K]> };

const joined = (items: readonly (string | number)[] | undefined) => items?.join(',');
const filterQuery = (args: Filters) => ({ channels: joined(args.channels), accounts: joined(args.account_ids), launches: joined(args.launch_ids) });

export const tools: ShipcastTool[] = [
  tool({
    name: 'get_stats_overview',
    title: 'Stats overview',
    description:
      'The totals of a period, overall, per channel and per account: what the Stats page\'s overview shows. `metrics` is how much each family (views, reactions, comments, shares, clicks, impressions, and second-tier counters such as saves, reach or watchMinutes) grew between from and to, not a running total; `lifetime` is where the same counters stood at the period\'s end. `averages` are means and ratios (ctr, position, average read or view time) as the period ends, never added up. With `compare: "previous"` (the period of the same length just before) or compare_from and compare_to, each total also has `previous` and `delta` (absolute and relative change). The last 30 days by default. Then get_stats_series charts one metric over time and get_stats_ranking says which posts, launches or accounts did best.',
    operations: ['statsOverview'],
    input: z.object({
      ...period,
      ...filters,
      compare: z.enum(['previous']).optional().describe('`previous`: compare with the period of the same length just before; leave out to compare with nothing or with compare_from/compare_to'),
      compare_from: moment.optional().describe('The first day of another period to compare with, with compare_to; not with `compare`'),
      compare_to: moment.optional().describe('The last day of the period to compare with'),
    }),
    hints: HINTS.read,
    run: (api, args) =>
      api.call('GET', '/stats/overview', {
        query: { from: args.from, to: args.to, ...filterQuery(args), compare: args.compare, compareFrom: args.compare_from, compareTo: args.compare_to },
      }),
  }),
  tool({
    name: 'get_stats_series',
    title: 'Stats series',
    description:
      'One metric over time, one series per channel (the default), account or launch, per day or per week (weeks start on Monday): the Stats page\'s chart. Each point has `increase` (how much the metric grew in that bucket) and `cumulative` (where it stood at the bucket\'s end, everything before the period included); a series\' `total` is its increase over the period and `baseline` where it stood when the period began. The largest `limit` series come one by one, the rest added up as `other`. At most 400 buckets: ask for weeks over a long period. The last 30 days by default.',
    operations: ['statsSeries'],
    input: z.object({
      metric: z.enum(STATS_METRICS).describe('What to chart: views, reactions, comments, shares, clicks or impressions'),
      group_by: z.enum(GROUP_BY).optional().describe('One series per channel (the default), account or launch'),
      bucket: z.enum(BUCKETS).optional().describe('day (the default) or week'),
      limit: z.number().int().min(1).max(50).optional().describe('How many series come one by one, 1 to 50; 10 by default'),
      ...period,
      ...filters,
    }),
    hints: HINTS.read,
    run: (api, args) =>
      api.call('GET', '/stats/series', {
        query: { metric: args.metric, groupBy: args.group_by, bucket: args.bucket, limit: args.limit, from: args.from, to: args.to, ...filterQuery(args) },
      }),
  }),
  tool({
    name: 'get_stats_ranking',
    title: 'Stats ranking',
    description:
      'Posts (the default), launches or accounts ranked by popularity in a period: the Stats page\'s ranking. Networks count very differently, so the `score` is normalised per network: 1 is that network\'s typical piece in the period (its median increase, given in `medians`), 2 twice that; a launch\'s or an account\'s score is the mean of its pieces\'. Each entry also has the raw increases in the period (`metrics`) and where its counters stood at the period\'s end (`lifetime`), with its post, launch and account ids and its url. Pages with `offset` (the `next` of the previous page, null on the last). The last 30 days by default.',
    operations: ['statsRanking'],
    input: z.object({
      by: z.enum(RANK_BY).optional().describe('Rank posts (the default), launches or accounts'),
      order: z.enum(['desc', 'asc']).optional().describe('desc (the default): the most popular first; asc: the least'),
      limit: z.number().int().min(1).max(100).optional().describe('How many, 1 to 100; 20 by default'),
      offset: z.number().int().min(0).max(100_000).optional().describe('Where the page starts: the `next` of the previous page'),
      ...period,
      ...filters,
    }),
    hints: HINTS.read,
    run: (api, args) =>
      api.call('GET', '/stats/ranking', {
        query: { by: args.by, order: args.order, limit: args.limit, offset: args.offset, from: args.from, to: args.to, ...filterQuery(args) },
      }),
  }),
  tool({
    name: 'get_stats_accounts',
    title: 'Accounts\' audience',
    description:
      'Every account Shipcast takes daily snapshots of (followers, following, posts): its latest numbers whenever they were read, when it was last read (`syncedAt`) and whether that is more than 36 hours ago (`stale`, so its numbers may be out of date), its `change` over the period and one point per day read. The Stats page\'s accounts tab. Accounts on networks that count no audience are left out. The last 30 days by default.',
    operations: ['statsAccounts'],
    input: z.object(days),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/stats/accounts', { query: { from: args.from, to: args.to } }),
  }),
  tool({
    name: 'get_account_growth',
    title: 'Account growth',
    description:
      'One account\'s followers, following and posts per day it was read, each point with its `change` since the snapshot before (`days` says how many days apart they are, more than 1 after a missed day), and the `change` over the whole period. Unlike get_stats_accounts, the last 90 days by default.',
    operations: ['accountGrowth'],
    input: z.object({
      account_id: accountId,
      from: day.optional().describe('The first day, YYYY-MM-DD, included; 89 days before `to` when left out'),
      to: day.optional().describe('The last day, YYYY-MM-DD, included; today (UTC) when left out'),
    }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', `/accounts/${args.account_id}/growth`, { query: { from: args.from, to: args.to } }),
  }),
  tool({
    name: 'get_search_index_status',
    title: 'Search index status',
    description:
      'Each published launch\'s blog articles in search engines: the Stats page\'s search tab. For every article page (per language), whether Google and Bing have indexed it, in the engine\'s own words (`coverage`) and when that was checked; null means the engine has not been read for that page yet. Per launch and engine, the impressions and clicks that grew in the period and their `lifetime` at its end; the engines count a launch\'s pages together, so the numbers are per launch, not per page. Up to 100 launches, newest first. The last 30 days by default.',
    operations: ['statsSearch'],
    input: z.object({ ...days, launch_ids: ids(50).optional().describe('Only these launches (ids from list_launches), at most 50') }),
    hints: HINTS.read,
    run: (api, args) => api.call('GET', '/stats/search', { query: { from: args.from, to: args.to, launches: joined(args.launch_ids) } }),
  }),
];
