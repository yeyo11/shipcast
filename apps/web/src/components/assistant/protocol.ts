/*
 * What the page and `/api/assistant` say to each other. Kept free of server imports, so the editor
 * can use it in the browser. See docs/decisions/writing-assistant.md
 */

import { CHANNEL_DEFINITIONS, draftOf } from '@shipcast/schema/channels';

export const ACTIONS = ['improve', 'shorten', 'translate', 'titles', 'adapt', 'check'] as const;
export type Action = (typeof ACTIONS)[number];

/** The networks "Adapt to a network" offers, by channel id, as a person names them: every channel with an `adapt` in its definition */
export const ADAPT_NETWORKS: ReadonlyArray<{ id: string; name: string }> = CHANNEL_DEFINITIONS.filter((d) => 'adapt' in d).map((d) => ({ id: d.id, name: d.name }));

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantRequest {
  /** A quick action on the selection, or a turn of the side chat */
  action: Action | 'chat';
  /** The selected text; empty means the whole text */
  selection: string;
  document: string;
  lang?: 'en' | 'es';
  /** The network of the piece being edited, when it is one */
  channel?: string;
  /** For `adapt`: the network to adapt to */
  target?: string;
  /** The launch whose draft is edited; none for a free article on Write */
  launchId?: number;
  /** For `chat`: the conversation, the owner's last message last */
  messages?: ChatTurn[];
  /** For `chat`: the saved session this turn continues; a new one is started when absent */
  sessionId?: number;
  /** For `chat`: where the selection sits in the text, saved with the question so its proposals can be applied again */
  range?: { start: number; end: number };
  /** What the session is about, for the history: the draft's file (none for an article on Write) and its name */
  draftPath?: string;
  draftLabel?: string;
}

export type CheckVerdict = 'backed' | 'planned' | 'not-found' | 'contradicted';

export interface CheckFinding {
  claim: string;
  verdict: CheckVerdict;
  evidence: string;
}

/** One line of the answer's stream, as NDJSON */
export type AssistantEvent =
  /** The answer is not streamed (the check against the code): it arrives at once, after a wait */
  | { type: 'whole' }
  | { type: 'text'; text: string }
  | { type: 'check'; revised: string; findings: CheckFinding[] }
  /**
   * The answer is worked as a job (the check against the code): the stream ends
   * here, and the page follows the job and reads its result (follow.ts) as the `check` it would have been
   */
  | { type: 'job'; id: string }
  | { type: 'error'; message: string }
  /** A chat turn was saved: the session it belongs to, and the answer's row for settling its proposals */
  | { type: 'saved'; sessionId: number; messageId: number }
  | { type: 'done' };

/** A draft's channel, from its file in the launches repo (`launches/<project>/<ref>/bluesky.md`), by the channels' own matchers */
export function channelOfDraft(path: string): string | undefined {
  return draftOf(path)?.channel;
}

/** A draft's language, when its path says it (`src/content/posts/es/…`, `newsletter-es.md`) */
export function langOfDraft(path: string): 'en' | 'es' | undefined {
  const match = /(?:\/|-)(en|es)(?:\/|\.md$)/.exec(path);
  return match?.[1] === 'en' || match?.[1] === 'es' ? match[1] : undefined;
}

/** Reads the answer's NDJSON stream as events, as they arrive */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<AssistantEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    // `stream: true` keeps a character split across two chunks whole
    if (value) buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as AssistantEvent;
      newline = buffer.indexOf('\n');
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as AssistantEvent;
}
