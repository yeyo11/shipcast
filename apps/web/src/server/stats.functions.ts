import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { forOwner } from './errors';
import { parseGrowthInput, parseSearchInput, parseStatsInput } from './stats-search';
import { loadGrowth, loadSearch, loadStats } from './stats.server';

/*
 * The Stats page's server functions: the engine's stats queries run in the app's own process, no
 * trip through the REST API. Each input is checked like every *.functions.ts does, since a request
 * can carry anything whatever the page sent. A period the engine refuses (an InvalidPeriod) is the
 * caller's mistake, as in the API's stats routes.
 */


export const getStats = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseStatsInput(input))
  .handler(async ({ data }) => forOwner(async () => loadStats((await appContext()).registry, data)));

export const getGrowth = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseGrowthInput(input))
  .handler(async ({ data }) => forOwner(async () => loadGrowth((await appContext()).registry, data)));

export const getSearch = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseSearchInput(input))
  .handler(async ({ data }) => forOwner(async () => loadSearch((await appContext()).registry, data)));
