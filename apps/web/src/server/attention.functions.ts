import { createServerFn } from '@tanstack/react-start';
import { attentionKeysInput } from './attention-api';
import { attentionApi } from './attention.server';
import { appContext } from './context.server';

/* The bell, through the same service as GET /attention and POST /attention/dismiss (attention-api.ts) */

/** The bell's list, from the registry alone (attention.server.ts) */
export const getAttention = createServerFn({ method: 'GET' }).handler(async () => attentionApi(await appContext()).list());

/** Hides one line (or a few) of the bell, on every device, until its condition changes */
export const dismissAttention = createServerFn({ method: 'POST' })
  .validator(attentionKeysInput)
  .handler(async ({ data }) => attentionApi(await appContext()).dismiss(data.keys));

/**
 * "Clear all": the lines the owner saw, not whatever the bell holds by the time the click lands,
 * so a failure that arrived in between is not cleared unread
 */
export const clearAttention = createServerFn({ method: 'POST' })
  .validator(attentionKeysInput)
  .handler(async ({ data }) => attentionApi(await appContext()).dismiss(data.keys));
