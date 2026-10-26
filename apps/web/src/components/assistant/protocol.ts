/*
 * What the page and `/api/assistant` say to each other. Kept free of server imports, so the editor
 * can use it in the browser. See docs/decisions/writing-assistant.md
 */

export const ACTIONS = ['improve', 'shorten', 'translate', 'titles', 'adapt', 'check'] as const;
export type Action = (typeof ACTIONS)[number];

/** The networks "Adapt to a network" offers, by channel id, as a person names them */
export const ADAPT_NETWORKS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'bluesky', name: 'Bluesky' },
  { id: 'mastodon', name: 'Mastodon' },
  { id: 'linkedin', name: 'LinkedIn' },
  { id: 'devto', name: 'dev.to' },
  { id: 'hashnode', name: 'Hashnode' },
  { id: 'instagram', name: 'Instagram' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'discord', name: 'Discord' },
  { id: 'reddit', name: 'Reddit' },
  { id: 'newsletter', name: 'Newsletter' },
];

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

/** One line of the answer's stream, as NDJSON */
export type AssistantEvent =
  /** The provider cannot stream: the whole answer arrives at once, after a wait */
  | { type: 'whole' }
  | { type: 'text'; text: string }
  | { type: 'check'; revised: string; findings: Array<{ claim: string; verdict: CheckVerdict; evidence: string }> }
  | { type: 'error'; message: string }
  /** A chat turn was saved: the session it belongs to, and the answer's row for settling its proposals */
  | { type: 'saved'; sessionId: number; messageId: number }
  | { type: 'done' };

const DRAFT_CHANNELS: Record<string, string> = {
  'devto.md': 'devto',
  'hashnode.md': 'hashnode',
  'bluesky.md': 'bluesky',
  'mastodon.md': 'mastodon',
  'instagram.md': 'instagram',
  'telegram.md': 'telegram',
  'discord.md': 'discord',
  'newsletter-en.md': 'newsletter',
  'newsletter-es.md': 'newsletter',
};

/** A draft's channel, from its file in the launches repo (`launches/<project>/<ref>/bluesky.md`) */
export function channelOfDraft(path: string): string | undefined {
  const file = path.split('/').at(-1) ?? '';
  return DRAFT_CHANNELS[file] ?? (file.startsWith('reddit') ? 'reddit' : undefined);
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
