import { lockedPrompts } from '@shipcast/engine';
import { createServerFn } from '@tanstack/react-start';
import { aiApi } from './ai.server';
import { launchService } from './app-services';
import { appContext } from './context.server';
import { forOwner } from './errors';
import { id, InvalidInput, object, text } from './input';

/* The AI page's server functions: each calls the service the AI routes call (ai.server.ts) */

export const getAiSettings = createServerFn({ method: 'GET' }).handler(async () => {
  const ctx = await appContext();
  const ai = aiApi(ctx);
  const [settings, prompts] = await Promise.all([ai.settings(), ai.prompts()]);
  return {
    ...settings,
    ...prompts,
    locked: { ...prompts.locked, packSchema: JSON.stringify(lockedPrompts().packSchema, null, 2) },
    launches: (await launchService(ctx).recent(50)).map((l) => ({ id: l.id, label: `${l.repo} ${l.ref.replace(/^article:/, '')} · ${l.status}` })),
  };
});

export const saveAiSettings = createServerFn({ method: 'POST' })
  .validator((input: unknown) => object(input, 'input'))
  .handler(async ({ data }) => forOwner(async () => aiApi(await appContext()).save(data)));

export const saveAiPrompt = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: text(o.id, 'id', 100), text: text(o.text, 'text', 20_000) };
  })
  .handler(async ({ data }) => forOwner(async () => aiApi(await appContext()).savePrompt(data.id, data.text)));

export const restoreAiPrompt = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    return { id: text(o.id, 'id', 100), savedAt: text(o.savedAt, 'savedAt', 100) };
  })
  .handler(async ({ data }) => forOwner(async () => aiApi(await appContext()).restorePrompt(data.id, data.savedAt)));

/** The final prompt a past launch would get with the saved prompts and tone: rendered here, no AI call */
export const previewAiPrompt = createServerFn({ method: 'POST' })
  .validator((input: unknown) => id(object(input, 'input').launchId, 'launchId'))
  .handler(async ({ data }) =>
    forOwner(async () => {
      const preview = await aiApi(await appContext()).preview(data);
      if (!preview) throw new InvalidInput(`no launch ${data}`);
      return preview;
    }),
  );
