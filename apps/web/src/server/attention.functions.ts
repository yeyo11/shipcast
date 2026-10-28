import { createServerFn } from '@tanstack/react-start';
import { ATTENTION_KEY } from './attention';
import { attentionFor } from './attention.server';
import { appContext } from './context.server';
import { InvalidInput, list, object } from './input';

/** More than the bell ever lists at once; a longer list is not a click on it */
const MAX_KEYS = 100;

/** The bell's list, from the registry alone (attention.server.ts) */
export const getAttention = createServerFn({ method: 'GET' }).handler(async () => attentionFor((await appContext()).registry));

function keysInput(input: unknown): { keys: string[] } {
  const keys = list(object(input, 'input').keys, 'keys');
  if (keys.length === 0 || keys.length > MAX_KEYS) throw new InvalidInput(`keys must hold 1 to ${MAX_KEYS} keys`);
  for (const key of keys) if (!ATTENTION_KEY.test(key)) throw new InvalidInput(`${key} is not a line of the bell`);
  return { keys };
}

/** Hides one line (or a few) of the bell, on every device, until its condition changes */
export const dismissAttention = createServerFn({ method: 'POST' })
  .validator(keysInput)
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    await registry.attention.dismissAttention(data.keys);
    return { dismissed: data.keys.length };
  });

/**
 * "Clear all": the lines the owner saw, not whatever the bell holds by the time the click lands,
 * so a failure that arrived in between is not cleared unread
 */
export const clearAttention = createServerFn({ method: 'POST' })
  .validator(keysInput)
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    await registry.attention.dismissAttention(data.keys);
    return { dismissed: data.keys.length };
  });
