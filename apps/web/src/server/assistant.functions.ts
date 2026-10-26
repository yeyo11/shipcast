import { createServerFn } from '@tanstack/react-start';
import { appContext } from './context.server';
import { id, InvalidInput, object, text } from './input';

/*
 * The writing assistant's history: past sessions, newest talked-in first a page at a time, and one
 * session's turns to take it up again. The chat itself is saved by the streaming endpoint.
 * See docs/decisions/writing-assistant.md
 */

export interface SessionSummary {
  id: number;
  title: string;
  launchId: number | null;
  draftPath: string | null;
  draftLabel: string | null;
  updatedAt: string;
}

export const listAssistantSessions = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const o = object(input ?? {}, 'input');
    const limit = o.limit === undefined ? undefined : id(o.limit, 'limit');
    if (limit !== undefined && limit > 50) throw new InvalidInput('limit is at most 50');
    return { ...(o.cursor !== undefined && o.cursor !== null && { cursor: text(o.cursor, 'cursor', 100) }), ...(limit !== undefined && { limit }) };
  })
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    const page = await registry.assistantSessions(data);
    const sessions: SessionSummary[] = page.sessions.map((s) => ({ id: s.id, title: s.title, launchId: s.launchId, draftPath: s.draftPath, draftLabel: s.draftLabel, updatedAt: s.updatedAt }));
    return { sessions, next: page.next };
  });

export const loadAssistantSession = createServerFn({ method: 'GET' })
  .validator((input: unknown) => id(input))
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    const session = await registry.assistantSession(data);
    if (!session) throw new InvalidInput('that session no longer exists');
    return {
      session: { id: session.id, title: session.title, launchId: session.launchId, draftPath: session.draftPath, draftLabel: session.draftLabel, updatedAt: session.updatedAt },
      messages: await registry.assistantMessages(data),
    };
  });

export const settleAssistantProposal = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    const o = object(input, 'input');
    if (o.state !== 'accepted' && o.state !== 'rejected') throw new InvalidInput('state is accepted or rejected');
    if (typeof o.index !== 'number' || !Number.isInteger(o.index) || o.index < 0 || o.index > 50) throw new InvalidInput('index must be a proposal number');
    const state: 'accepted' | 'rejected' = o.state;
    return { messageId: id(o.messageId, 'messageId'), index: o.index, state };
  })
  .handler(async ({ data }) => {
    const { registry } = await appContext();
    return { ok: await registry.settleAssistantProposal(data.messageId, data.index, data.state) };
  });
