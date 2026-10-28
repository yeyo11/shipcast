import {
  accountGrowth,
  STATS_METRICS,
  statsOverview,
  statsRanking,
  statsSeries,
  type RankBy,
  type SeriesBucket,
  type SeriesGroupBy,
  type StatsFilter,
  type StatsMetric,
  type StatsWindow,
  statsWindow,
} from '@shipcast/engine';
import type { ApiRoute } from './api.ts';
import { InvalidInput } from './input.ts';

/*
 * The stats routes of the REST API, read-only, thin over packages/engine/src/stats.ts. Kept apart
 * from api.ts, which spreads them into its routes and its OpenAPI document; only types come back
 * from api.ts, so the two modules never need each other at load time. See docs/stats.md
 */

type JsonSchema = Record<string, unknown>;
type Query = URLSearchParams;

const ok = (body: unknown) => Response.json(body, { status: 200, headers: { 'cache-control': 'no-store' } });


const today = () => new Date().toISOString().slice(0, 10);
const daysBefore = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** `from` and `to` as sent, the last 30 days (today included) when left out */
function period(query: Query): { from: string; to: string } {
  const to = query.get('to') ?? today();
  const from = query.get('from') ?? daysBefore(to.slice(0, 10), 29);
  for (const [name, value] of [['from', from], ['to', to]] as const) if (value.length > 40) throw new InvalidInput(`${name} is too long`);
  return { from, to };
}

function oneOf<T extends string>(query: Query, name: string, allowed: readonly T[], fallback?: T): T {
  const value = query.get(name) ?? fallback;
  if (value === undefined) throw new InvalidInput(`${name} is required: one of ${allowed.join(', ')}`);
  if (!(allowed as readonly string[]).includes(value)) throw new InvalidInput(`${name} is one of ${allowed.join(', ')}`);
  return value as T;
}

function integer(query: Query, name: string, min: number, max: number, fallback: number): number {
  const text = query.get(name);
  const value = text === null ? fallback : Number(text);
  if (!Number.isInteger(value) || value < min || value > max) throw new InvalidInput(`${name} is an integer from ${min} to ${max}`);
  return value;
}

/** A comma-separated list; at most 100 items, each checked */
function list<T>(query: Query, name: string, parse: (item: string) => T | undefined): T[] | undefined {
  const text = query.get(name);
  if (text === null) return undefined;
  const items = text.split(',').map((item) => item.trim()).filter((item) => item !== '');
  if (items.length === 0 || items.length > 100) throw new InvalidInput(`${name} is a comma-separated list of 1 to 100 items`);
  return items.map((item) => {
    const value = parse(item);
    if (value === undefined) throw new InvalidInput(`${name} has an item that is not valid: ${item.slice(0, 40)}`);
    return value;
  });
}

const positive = (item: string) => (/^\d{1,10}$/.test(item) && Number(item) > 0 ? Number(item) : undefined);
const channelName = (item: string) => (/^[a-zA-Z][\w-]{0,39}$/.test(item) ? item : undefined);

function filters(query: Query): StatsFilter {
  const channels = list(query, 'channels', channelName);
  const accounts = list(query, 'accounts', positive);
  const launches = list(query, 'launches', positive);
  return { ...(channels && { channels }), ...(accounts && { accounts }), ...(launches && { launches }) };
}

function comparison(query: Query): StatsWindow | 'previous' | undefined {
  const compare = query.get('compare');
  const from = query.get('compareFrom');
  const to = query.get('compareTo');
  if (compare !== null && compare !== 'previous') throw new InvalidInput('compare is previous, or give compareFrom and compareTo');
  if ((from === null) !== (to === null)) throw new InvalidInput('compareFrom and compareTo go together');
  if (compare !== null && from !== null) throw new InvalidInput('compare=previous or compareFrom and compareTo, not both');
  if (from !== null && to !== null) {
    // The engine's InvalidPeriod is a 400 already, with its own words
    return statsWindow(from, to);
  }
  return compare === 'previous' ? 'previous' : undefined;
}

const q = (name: string, description: string, schema: JsonSchema) => ({ name, description, schema });
const PERIOD = [
  q('from', 'The first day (YYYY-MM-DD, included) or moment (ISO 8601, included); 29 days before `to` when left out', { type: 'string' }),
  q('to', 'The last day (YYYY-MM-DD, included) or moment (ISO 8601, excluded); today when left out', { type: 'string' }),
];
const FILTERS = [
  q('channels', 'Comma-separated channels or sources (`devto,bluesky,blog`)', { type: 'string' }),
  q('accounts', 'Comma-separated account ids; leaves out what no account published', { type: 'string' }),
  q('launches', 'Comma-separated launch ids', { type: 'string' }),
];
const GROUP_BY: readonly SeriesGroupBy[] = ['channel', 'account', 'launch'];
const BUCKETS: readonly SeriesBucket[] = ['day', 'week'];
const RANK_BY: readonly RankBy[] = ['post', 'launch', 'account'];

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

export const STATS_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/stats/overview',
    scope: 'read',
    operationId: 'statsOverview',
    summary: 'Totals per channel and per account in a period, against another period when asked',
    query: [
      ...PERIOD,
      ...FILTERS,
      q('compare', '`previous`: the period of the same length just before', { type: 'string', enum: ['previous'] }),
      q('compareFrom', 'Another period to compare with, with `compareTo`', { type: 'string' }),
      q('compareTo', 'The end of the period to compare with', { type: 'string' }),
    ],
    response: { status: 200, description: 'The totals, the comparison and the change', schema: ref('StatsOverview') },
    async handle(deps, { url }) {
      const query = url.searchParams;
      const compareTo = comparison(query);
      return ok(await statsOverview(deps.registry, { ...period(query), ...filters(query), ...(compareTo && { compareTo }) }));
    },
  },
  {
    method: 'GET',
    path: '/stats/series',
    scope: 'read',
    operationId: 'statsSeries',
    summary: 'A metric over time, one series per channel, account or launch: the increase per bucket and the running total',
    query: [
      q('metric', 'What to chart', { type: 'string', enum: STATS_METRICS }),
      q('groupBy', 'One series per channel (the default), account or launch', { type: 'string', enum: GROUP_BY, default: 'channel' }),
      q('bucket', 'Days (the default) or weeks starting on Monday', { type: 'string', enum: BUCKETS, default: 'day' }),
      q('limit', 'How many series come one by one, the largest first; the rest are added up as `other` (10 by default)', { type: 'integer', minimum: 1, maximum: 50, default: 10 }),
      ...PERIOD,
      ...FILTERS,
    ],
    response: { status: 200, description: 'The buckets and a series per group', schema: ref('StatsSeries') },
    async handle(deps, { url }) {
      const query = url.searchParams;
      return ok(
        await statsSeries(deps.registry, {
          metric: oneOf<StatsMetric>(query, 'metric', STATS_METRICS),
          groupBy: oneOf(query, 'groupBy', GROUP_BY, 'channel'),
          bucket: oneOf(query, 'bucket', BUCKETS, 'day'),
          limit: integer(query, 'limit', 1, 50, 10),
          ...period(query),
          ...filters(query),
        }),
      );
    },
  },
  {
    method: 'GET',
    path: '/stats/ranking',
    scope: 'read',
    operationId: 'statsRanking',
    summary: 'Posts, launches or accounts ranked by popularity normalised per network, with the raw numbers beside the score',
    query: [
      q('by', 'Rank posts (the default), launches or accounts', { type: 'string', enum: RANK_BY, default: 'post' }),
      q('order', 'The most popular first (`desc`, the default) or the least', { type: 'string', enum: ['desc', 'asc'], default: 'desc' }),
      q('limit', 'How many, 1 to 100 (20 by default)', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
      q('offset', 'Where the page starts: the `next` of the previous page', { type: 'integer', minimum: 0, default: 0 }),
      ...PERIOD,
      ...FILTERS,
    ],
    response: { status: 200, description: 'A page of the ranking and each network’s yardstick', schema: ref('StatsRanking') },
    async handle(deps, { url }) {
      const query = url.searchParams;
      return ok(
        await statsRanking(deps.registry, {
          by: oneOf(query, 'by', RANK_BY, 'post'),
          order: oneOf(query, 'order', ['desc', 'asc'] as const, 'desc'),
          limit: integer(query, 'limit', 1, 100, 20),
          offset: integer(query, 'offset', 0, 100_000, 0),
          ...period(query),
          ...filters(query),
        }),
      );
    },
  },
  {
    method: 'GET',
    path: '/accounts/{accountId}/growth',
    scope: 'read',
    operationId: 'accountGrowth',
    summary: 'An account’s followers, following and posts per day from its snapshots, with the change since the one before',
    query: [
      q('from', 'The first day, YYYY-MM-DD (89 days before `to` when left out)', { type: 'string', format: 'date' }),
      q('to', 'The last day, YYYY-MM-DD (today when left out)', { type: 'string', format: 'date' }),
    ],
    response: { status: 200, description: 'One point a day the account was read', schema: ref('AccountGrowth') },
    async handle(deps, { params, url }) {
      const id = positive(params.accountId ?? '');
      if (id === undefined) throw new InvalidInput('the account id must be a positive integer');
      if (!(await deps.registry.account(id))) {
        return Response.json({ error: { code: 'not_found', message: 'no such account' } }, { status: 404, headers: { 'cache-control': 'no-store' } });
      }
      const to = url.searchParams.get('to') ?? today();
      const from = url.searchParams.get('from') ?? (/^\d{4}-\d{2}-\d{2}$/.test(to) ? daysBefore(to, 89) : to);
      return ok(await accountGrowth(deps.registry, id, { from, to }));
    },
  },
];

const windowSchema = { type: 'object', properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } } };
const totals = { type: 'object', description: 'Per family, only those the sources count', properties: Object.fromEntries(STATS_METRICS.map((m) => [m, { type: 'number' }])) };
const delta = { type: 'object', additionalProperties: { type: 'object', properties: { absolute: { type: 'number' }, relative: { type: ['number', 'null'] } } } };
const breakdown = { metrics: totals, previous: totals, delta };
const point = { type: 'object', properties: { bucket: { type: 'string', format: 'date' }, increase: { type: 'number' }, cumulative: { type: 'number' } } };
const group = {
  type: 'object',
  properties: { key: { type: 'string' }, label: { type: 'string' }, total: { type: 'number' }, baseline: { type: 'number' }, points: { type: 'array', items: point } },
};
const change = { type: 'object', properties: { followers: { type: ['integer', 'null'] }, following: { type: ['integer', 'null'] }, posts: { type: ['integer', 'null'] } } };

/** The components the stats routes' responses name, merged into the OpenAPI document's */
export const STATS_SCHEMAS: Record<string, JsonSchema> = {
  StatsOverview: {
    type: 'object',
    properties: {
      window: windowSchema,
      compareTo: windowSchema,
      ...breakdown,
      channels: { type: 'array', items: { type: 'object', properties: { channel: { type: 'string' }, ...breakdown } } },
      accounts: {
        type: 'array',
        items: { type: 'object', properties: { accountId: { type: 'integer' }, network: { type: ['string', 'null'] }, label: { type: ['string', 'null'] }, ...breakdown } },
      },
    },
  },
  StatsSeries: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: STATS_METRICS },
      groupBy: { type: 'string', enum: GROUP_BY },
      bucket: { type: 'string', enum: BUCKETS },
      window: windowSchema,
      buckets: { type: 'array', items: { type: 'string', format: 'date' } },
      groups: { type: 'array', items: group },
      other: { oneOf: [{ type: 'null' }, { ...group, properties: { ...group.properties, groups: { type: 'integer' } } }] },
    },
  },
  StatsRanking: {
    type: 'object',
    properties: {
      by: { type: 'string', enum: RANK_BY },
      window: windowSchema,
      total: { type: 'integer' },
      next: { type: ['integer', 'null'] },
      medians: { type: 'object', additionalProperties: totals, description: 'Each network’s median increase per active family: the yardstick' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rank: { type: 'integer' },
            score: { type: 'number', description: '1 is the network’s typical piece in the period, 2 twice that' },
            metrics: totals,
            pieces: { type: 'integer' },
            channel: { type: ['string', 'null'] },
            launchId: { type: ['integer', 'null'] },
            postId: { type: ['integer', 'null'] },
            accountId: { type: ['integer', 'null'] },
            label: { type: 'string' },
            url: { type: ['string', 'null'] },
            kind: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
  AccountGrowth: {
    type: 'object',
    properties: {
      accountId: { type: 'integer' },
      from: { type: 'string', format: 'date' },
      to: { type: 'string', format: 'date' },
      change,
      points: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            day: { type: 'string', format: 'date' },
            takenAt: { type: 'string', format: 'date-time' },
            followers: { type: ['integer', 'null'] },
            following: { type: ['integer', 'null'] },
            posts: { type: ['integer', 'null'] },
            change,
            days: { type: ['integer', 'null'] },
          },
        },
      },
    },
  },
};
