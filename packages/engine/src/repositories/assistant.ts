import { and, asc, desc, eq, lt, or } from 'drizzle-orm';
import type { Database } from '../db/connect.ts';
import { assistantMessages, assistantSessions, nowIso } from '../db/schema.ts';

/** One proposal in an assistant's answer, and what the owner did with it */
export interface AssistantProposal {
  text: string;
  state: 'open' | 'accepted' | 'rejected';
}

/** The passage selected when a question was asked, which its proposals replace */
export interface AssistantSelection {
  start: number;
  end: number;
  original: string;
}

/** A writing-assistant conversation, tied to the draft or article it was held on */
export interface AssistantSession {
  id: number;
  title: string;
  /** Null for an article on Write */
  launchId: number | null;
  draftPath: string | null;
  draftLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAssistantSession {
  title: string;
  launchId?: number | null;
  draftPath?: string | null;
  draftLabel?: string | null;
}

export interface AssistantMessage {
  id: number;
  sessionId: number;
  role: 'user' | 'assistant';
  content: string;
  proposals: AssistantProposal[];
  selection: AssistantSelection | null;
  problem: string | null;
  createdAt: string;
}

export interface NewAssistantMessage {
  role: 'user' | 'assistant';
  content: string;
  proposals?: AssistantProposal[];
  selection?: AssistantSelection | null;
  problem?: string | null;
}

/** A page of sessions, the most recently talked in first; `next` is the cursor for the page after it */
export interface AssistantSessionPage {
  sessions: AssistantSession[];
  next: string | null;
}

/** The sessions' cursor is the last row's `updatedAt` and id: a keyset, so new messages never shift a page */
function encodeSessionCursor(row: { updatedAt: string; id: number }): string {
  return `${row.updatedAt}|${row.id}`;
}

function decodeSessionCursor(cursor: string): { updatedAt: string; id: number } | undefined {
  const at = cursor.lastIndexOf('|');
  if (at < 1) return undefined;
  const id = Number(cursor.slice(at + 1));
  return Number.isInteger(id) ? { updatedAt: cursor.slice(0, at), id } : undefined;
}

function toAssistantMessage(row: typeof assistantMessages.$inferSelect): AssistantMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    proposals: row.proposals,
    selection: row.selection,
    problem: row.problem,
    createdAt: row.createdAt,
  };
}

/** The writing assistant's conversations and their turns */
export class AssistantRepository {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async createAssistantSession(session: NewAssistantSession): Promise<AssistantSession> {
    const [row] = await this.#db
      .insert(assistantSessions)
      .values({ title: session.title, launchId: session.launchId ?? null, draftPath: session.draftPath ?? null, draftLabel: session.draftLabel ?? null })
      .returning();
    return row!;
  }

  async assistantSession(id: number): Promise<AssistantSession | undefined> {
    const [row] = await this.#db.select().from(assistantSessions).where(eq(assistantSessions.id, id));
    return row;
  }

  /** Adds a turn and moves the session to the top of the list; undefined when the session is gone */
  async addAssistantMessage(sessionId: number, message: NewAssistantMessage): Promise<AssistantMessage | undefined> {
    return this.#db.transaction(async (tx) => {
      const [touched] = await tx.update(assistantSessions).set({ updatedAt: nowIso }).where(eq(assistantSessions.id, sessionId)).returning({ id: assistantSessions.id });
      if (!touched) return undefined;
      const [row] = await tx
        .insert(assistantMessages)
        .values({ sessionId, role: message.role, content: message.content, proposals: message.proposals ?? [], selection: message.selection ?? null, problem: message.problem ?? null })
        .returning();
      return toAssistantMessage(row!);
    });
  }

  /** The session's turns in the order they were said */
  async assistantMessages(sessionId: number): Promise<AssistantMessage[]> {
    const rows = await this.#db.select().from(assistantMessages).where(eq(assistantMessages.sessionId, sessionId)).orderBy(asc(assistantMessages.id));
    return rows.map(toAssistantMessage);
  }

  /** Records what the owner did with one proposal of an answer; false when there is no such proposal */
  async settleAssistantProposal(messageId: number, index: number, state: 'accepted' | 'rejected'): Promise<boolean> {
    return this.#db.transaction(async (tx) => {
      const [row] = await tx.select({ proposals: assistantMessages.proposals }).from(assistantMessages).where(eq(assistantMessages.id, messageId)).for('update');
      const proposal = row?.proposals[index];
      if (!row || !proposal) return false;
      const proposals = row.proposals.map((p, i) => (i === index ? { ...p, state } : p));
      await tx.update(assistantMessages).set({ proposals }).where(eq(assistantMessages.id, messageId));
      return true;
    });
  }

  /** Sessions, the most recently talked in first, a page at a time: pass the previous page's `next` for the following one */
  async assistantSessions(options: { limit?: number; cursor?: string } = {}): Promise<AssistantSessionPage> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 100));
    const at = options.cursor === undefined ? undefined : decodeSessionCursor(options.cursor);
    const where = at
      ? or(lt(assistantSessions.updatedAt, at.updatedAt), and(eq(assistantSessions.updatedAt, at.updatedAt), lt(assistantSessions.id, at.id)))
      : undefined;
    const rows = await this.#db.select().from(assistantSessions).where(where).orderBy(desc(assistantSessions.updatedAt), desc(assistantSessions.id)).limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { sessions: page, next: rows.length > limit && last ? encodeSessionCursor(last) : null };
  }
}
