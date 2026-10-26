import { useCallback, useEffect, useRef, useState } from 'react';
import { loadAssistantSession, settleAssistantProposal } from '../../server/assistant.functions';
import { applyProposal } from './diff';
import { readEvents, type Action, type AssistantEvent, type AssistantRequest, type ChatTurn, type CheckVerdict } from './protocol';

/** A range of the text, as the textarea reports a selection */
export interface Range {
  start: number;
  end: number;
}

/** What the editor is editing, and what the assistant needs to know about it */
export interface AssistantTarget {
  value: string;
  onChange: (next: string) => void;
  lang?: 'en' | 'es';
  channel?: string;
  launchId?: number;
  /** What the history shows the session under: the draft's file in the launches repo (none on Write) and its name */
  draftPath?: string;
  draftLabel?: string;
  /** Why "Check against the repo's code" cannot run here; undefined when it can */
  checkDisabled?: string;
}

/** A proposal waiting for Accept or Reject: what it replaces, and with what */
export interface Proposal {
  id: number;
  /** What was asked, in words: "Shorten", "From the chat" */
  label: string;
  /** The range it replaces; undefined replaces the whole text */
  range: Range | undefined;
  /** The text it was made from, to notice when the text changed meanwhile */
  original: string;
  text: string;
  /** Still arriving */
  streaming: boolean;
  /** The provider sends the whole answer at once (claudio until its streaming API exists) */
  whole: boolean;
  /** For titles: the candidates, one of which becomes the text */
  titles?: string[];
  findings?: Array<{ claim: string; verdict: CheckVerdict; evidence: string }>;
  problem?: string;
}

export interface ChatMessage extends ChatTurn {
  id: number;
  streaming?: boolean;
  whole?: boolean;
  problem?: string;
  /** What the owner had selected when asking: proposals replace it */
  range?: Range;
  original?: string;
  /** The saved answer's row, once the server has kept it: what settling a proposal is recorded against */
  savedId?: number;
  /** What was done with each proposal of the answer, by its number among the answer's proposals */
  settled?: Record<number, 'accepted' | 'rejected'>;
}

const LABELS: Record<Action, string> = {
  improve: 'Improve',
  shorten: 'Shorten',
  translate: 'Translate',
  titles: 'Titles',
  adapt: 'Adapt',
  check: 'Check against the code',
};

let counter = 0;
const nextId = () => ++counter;

/** Sends one request and hands each event over as it arrives; resolves when the answer ends */
async function ask(request: AssistantRequest, signal: AbortSignal, onEvent: (event: AssistantEvent) => void): Promise<void> {
  const response = await fetch('/api/assistant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal });
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    onEvent({ type: 'error', message: body?.error ?? `the assistant answered ${response.status}` });
    return;
  }
  for await (const event of readEvents(response.body)) onEvent(event);
}

const titlesOf = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '').replace(/^["“«'](.*)["”»']$/, '$1').trim())
    .filter(Boolean);

/**
 * One editor's assistant: the selection, the quick action's proposal and the side chat, all against
 * the same text. Nothing changes the text but Accept.
 */
export function useAssistant(target: AssistantTarget) {
  const [selection, setSelection] = useState<Range>({ start: 0, end: 0 });
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [chat, setChat] = useState<ChatMessage[]>([]);
  // The saved session the chat continues; undefined until the server keeps the first turn
  const [sessionId, setSessionId] = useState<number | undefined>(undefined);
  const [announce, setAnnounce] = useState('');
  const actionAbort = useRef<AbortController | null>(null);
  const chatAbort = useRef<AbortController | null>(null);
  const latest = useRef(target);
  latest.current = target;

  useEffect(
    () => () => {
      actionAbort.current?.abort();
      chatAbort.current?.abort();
    },
    [],
  );

  const selected = selection.end > selection.start ? target.value.slice(selection.start, selection.end) : '';
  const base = (): Omit<AssistantRequest, 'action'> => {
    const t = latest.current;
    return {
      selection: selected,
      document: t.value,
      ...(t.lang && { lang: t.lang }),
      ...(t.channel && { channel: t.channel }),
      ...(t.launchId !== undefined && { launchId: t.launchId }),
      ...(t.draftPath && { draftPath: t.draftPath }),
      ...(t.draftLabel && { draftLabel: t.draftLabel }),
    };
  };

  const run = useCallback(
    (action: Action, adaptTo?: { id: string; name: string }) => {
      actionAbort.current?.abort();
      const controller = new AbortController();
      actionAbort.current = controller;
      const range = selected ? { ...selection } : undefined;
      const id = nextId();
      const label = action === 'adapt' && adaptTo ? `Adapt to ${adaptTo.name}` : action === 'translate' ? (latest.current.lang === 'es' ? 'Translate to English' : latest.current.lang === 'en' ? 'Translate to Spanish' : 'Translate') : LABELS[action];
      setProposal({ id, label, range, original: selected || latest.current.value, text: '', streaming: true, whole: false });
      setAnnounce(`${label}: working`);
      const update = (change: (p: Proposal) => Proposal) => setProposal((p) => (p && p.id === id ? change(p) : p));
      void ask({ ...base(), action, ...(adaptTo && { target: adaptTo.id }) }, controller.signal, (event) => {
        if (event.type === 'whole') update((p) => ({ ...p, whole: true }));
        else if (event.type === 'text') update((p) => ({ ...p, text: p.text + event.text }));
        else if (event.type === 'check') update((p) => ({ ...p, text: event.revised, findings: event.findings }));
        else if (event.type === 'error') {
          update((p) => ({ ...p, streaming: false, problem: event.message }));
          setAnnounce(`${label} failed`);
        } else if (event.type === 'done') {
          update((p) => {
            const titles = action === 'titles' ? titlesOf(p.text) : undefined;
            return { ...p, streaming: false, ...(titles && { titles, text: '' }) };
          });
          setAnnounce(`${label}: the proposal is ready below the text`);
        }
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        update((p) => ({ ...p, streaming: false, problem: error instanceof Error ? error.message : String(error) }));
      });
    },
    // base reads the latest target through a ref; the selection is what changes the request
    [selected, selection.start, selection.end],
  );

  /** Whether a range still holds what a proposal was made from */
  const stillThere = (range: Range | undefined, original: string) => (range ? latest.current.value.slice(range.start, range.end) === original : true);

  const accept = useCallback((p: { range: Range | undefined; original: string; text: string }): boolean => {
    if (!stillThere(p.range, p.original)) return false;
    latest.current.onChange(applyProposal(latest.current.value, p.range, p.text));
    return true;
  }, []);

  const acceptProposal = useCallback((): boolean => {
    if (!proposal || proposal.streaming || !proposal.text) return false;
    const ok = accept(proposal);
    if (ok) {
      setProposal(null);
      setAnnounce('Accepted: the text is changed');
    }
    return ok;
  }, [proposal, accept]);

  const rejectProposal = useCallback(() => {
    actionAbort.current?.abort();
    setProposal(null);
    setAnnounce('Rejected: the text is as it was');
  }, []);

  const chooseTitle = useCallback((title: string) => setProposal((p) => (p ? { ...p, text: title } : p)), []);

  const send = useCallback(
    (content: string) => {
      if (!content.trim()) return;
      chatAbort.current?.abort();
      const controller = new AbortController();
      chatAbort.current = controller;
      const range = selected ? { ...selection } : undefined;
      const mine: ChatMessage = { id: nextId(), role: 'user', content };
      const answer: ChatMessage = { id: nextId(), role: 'assistant', content: '', streaming: true, ...(range && { range, original: selected }) };
      const history = [...chat.filter((m) => !m.problem && m.content), mine].map(({ role, content: c }) => ({ role, content: c }));
      setChat((c) => [...c, mine, answer]);
      const update = (change: (m: ChatMessage) => ChatMessage) => setChat((c) => c.map((m) => (m.id === answer.id ? change(m) : m)));
      void ask({ ...base(), action: 'chat', messages: history, ...(sessionId !== undefined && { sessionId }), ...(range && { range }) }, controller.signal, (event) => {
        if (event.type === 'whole') update((m) => ({ ...m, whole: true }));
        else if (event.type === 'saved') {
          setSessionId(event.sessionId);
          update((m) => ({ ...m, savedId: event.messageId }));
        }
        else if (event.type === 'text') update((m) => ({ ...m, content: m.content + event.text }));
        else if (event.type === 'error') update((m) => ({ ...m, streaming: false, problem: event.message }));
        else if (event.type === 'done') {
          update((m) => ({ ...m, streaming: false }));
          setAnnounce('The assistant answered in the chat');
        }
      }).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        update((m) => ({ ...m, streaming: false, problem: error instanceof Error ? error.message : String(error) }));
      });
    },
    [chat, sessionId, selected, selection.start, selection.end],
  );

  const stopChat = useCallback(() => {
    chatAbort.current?.abort();
    setChat((c) => c.map((m) => (m.streaming ? { ...m, streaming: false } : m)));
  }, []);

  /** Starts a new session: what was said stays in the history */
  const newSession = useCallback(() => {
    chatAbort.current?.abort();
    setChat([]);
    setSessionId(undefined);
  }, []);

  /** Takes a saved session up again; false when it could not be loaded */
  const openSession = useCallback(async (id: number): Promise<boolean> => {
    try {
      const { messages } = await loadAssistantSession({ data: id });
      chatAbort.current?.abort();
      setChat(
        messages.map((m): ChatMessage => {
          const settled: Record<number, 'accepted' | 'rejected'> = {};
          m.proposals.forEach((p, i) => {
            if (p.state !== 'open') settled[i] = p.state;
          });
          return {
            id: nextId(),
            role: m.role,
            content: m.content,
            savedId: m.id,
            settled,
            ...(m.problem && { problem: m.problem }),
            ...(m.selection && { range: { start: m.selection.start, end: m.selection.end }, original: m.selection.original }),
          };
        }),
      );
      setSessionId(id);
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Records what the owner did with an answer's proposal, here and in the saved session */
  const settle = useCallback((message: ChatMessage, proposal: number, state: 'accepted' | 'rejected') => {
    setChat((c) => c.map((m) => (m.id === message.id ? { ...m, settled: { ...m.settled, [proposal]: state } } : m)));
    if (message.savedId !== undefined) void settleAssistantProposal({ data: { messageId: message.savedId, index: proposal, state } }).catch(() => undefined);
  }, []);

  return {
    target,
    selection,
    setSelection,
    selected,
    proposal,
    run,
    acceptProposal,
    rejectProposal,
    chooseTitle,
    accept,
    chat,
    send,
    stopChat,
    sessionId,
    newSession,
    openSession,
    settle,
    announce,
  };
}

export type Assistant = ReturnType<typeof useAssistant>;
