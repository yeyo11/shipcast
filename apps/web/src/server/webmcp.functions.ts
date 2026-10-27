import { readWebMcp, writeWebMcp } from '@shipcast/runtime';
import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { object } from './input';

/** Whether the owner turned the WebMCP experiment on; off by default (docs/decisions/mcp.md) */
export const getWebMcp = createServerFn({ method: 'GET' }).handler(async () => {
  const { registry } = await appContext();
  return { enabled: await readWebMcp(registry) };
});

export const setWebMcp = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { enabled: o.enabled === true };
  })
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    return { enabled: await writeWebMcp(registry, data.enabled) };
  });
