import { createApiToken, InvalidScopes, parseScopes } from '@shipcast/runtime';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { id, InvalidInput, object, text } from './input';

export const listTokens = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  return { tokens: await ctx.registry.apiTokens(), apiUrl: `${ctx.app.publicUrl}/api/v1` };
});

/** The token comes back once, here; afterwards only its name, scopes and dates are known */
export const createToken = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    const name = text(o.name, 'name', 100).trim();
    if (!name) throw new InvalidInput('a token needs a name');
    try {
      return { name, scopes: parseScopes(o.scopes) };
    } catch (error) {
      throw error instanceof InvalidScopes ? new InvalidInput(error.message) : error;
    }
  })
  .handler(async ({ data }) => {
    const { registry, secrets } = await appContext();
    const { token, record } = await createApiToken({ registry, secrets }, data.name, data.scopes);
    return { token, id: record.id };
  });

export const revokeToken = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => ({ ok: Boolean(await (await appContext()).registry.revokeApiToken(data)) }));
