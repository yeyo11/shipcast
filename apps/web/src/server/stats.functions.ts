import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { InvalidInput } from './input';
import { parseGrowthInput, parseSearchInput, parseStatsInput } from './stats-search';
import { loadGrowth, loadSearch, loadStats } from './stats.server';

/*
 * The Stats page's server functions: the engine's stats queries run in the app's own process, no
 * trip through the REST API. Each input is checked like every *.functions.ts does, since a request
 * can carry anything whatever the page sent. A period the engine refuses (a RangeError) is the
 * caller's mistake, as in the API's stats routes.
 */

async function checked<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RangeError) throw new InvalidInput(error.message);
    throw error;
  }
}

export const getStats = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseStatsInput(input))
  .handler(async ({ data }) => checked(async () => loadStats((await appContext()).registry, data)));

export const getGrowth = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseGrowthInput(input))
  .handler(async ({ data }) => checked(async () => loadGrowth((await appContext()).registry, data)));

export const getSearch = createServerFn({ method: 'GET' })
  .validator((input: unknown) => parseSearchInput(input))
  .handler(async ({ data }) => checked(async () => loadSearch((await appContext()).registry, data)));
