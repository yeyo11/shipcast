import { Dialog } from '@base-ui/react/dialog';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../kit/Icon';
import { useToast } from '../Toasts';
import { usePhone } from '../kit/usePhone';
import { listAssistantSessions, type SessionSummary } from '../../server/assistant.functions';
import { splitProposals } from './diff';
import { DiffView } from './DiffView';
import type { Assistant, ChatMessage } from './session';

function Answer({ message, assistant }: { message: ChatMessage; assistant: Assistant }) {
  const toast = useToast();
  const settled = message.settled ?? {};
  const pieces = splitProposals(message.content);
  // A proposal is numbered among the answer's proposals, as the server saves them
  let ordinal = -1;
  const before = message.range ? (message.original ?? '') : assistant.target.value;
  return (
    <>
      {pieces.map((piece, i) => {
        if (piece.type === 'prose')
          return (
            <p key={i} className="wr-chat-prose">
              {piece.text}
            </p>
          );
        const n = ++ordinal;
        const label = `Proposal ${n + 1} from the chat`;
        if (!piece.complete)
          return (
            <div key={i} className="k-card wr-chat-proposal wr-chat-pending">
              <span className="k-xs k-muted">{label}</span>
              <span className="k-sm k-muted" role="status">
                Still writing this proposal…
              </span>
            </div>
          );
        return (
          <div key={i} className="k-card wr-chat-proposal">
            <span className="k-xs k-muted">{label}</span>
            <DiffView before={before} after={piece.text} label={label} className="k-sm" trim={message.range ? undefined : 48} />
            {settled[n] ? (
              <span className="k-xs k-muted">{settled[n] === 'accepted' ? 'Accepted' : 'Rejected'}</span>
            ) : (
              <div className="k-hrow k-g8">
                <button type="button" className="k-btn k-sm" onClick={() => assistant.settle(message, n, 'rejected')}>
                  Reject
                </button>
                <button
                  type="button"
                  className="k-btn k-sm k-grow wr-chat-accept"
                  onClick={() => {
                    const ok = assistant.accept({ range: message.range, original: before, text: piece.text });
                    if (ok) assistant.settle(message, n, 'accepted');
                    else toast.fail('The text changed under this proposal: ask again on the text as it is now.');
                  }}
                >
                  <Icon name="check" size={18} />
                  Accept
                </button>
              </div>
            )}
          </div>
        );
      })}
      {message.streaming && !message.content && (
        <p className="k-sm k-muted wr-flush" role="status">
          Writing…
        </p>
      )}
      {message.problem && (
        <p className="k-sm wr-problem wr-flush" role="alert">
          {message.problem}
        </p>
      )}
    </>
  );
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * The past sessions, the most recently talked in first, a page at a time: the next page loads when
 * the end of the list scrolls into view, and a button does the same for anyone who cannot scroll.
 */
function History({ assistant, onChosen }: { assistant: Assistant; onChosen: () => void }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const loading = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(async (cursor?: string) => {
    if (loading.current) return;
    loading.current = true;
    setState('loading');
    try {
      const page = await listAssistantSessions({ data: { limit: 20, ...(cursor && { cursor }) } });
      setSessions((all) => (cursor ? [...all, ...page.sessions] : page.sessions));
      setNext(page.next);
      setState('ready');
    } catch {
      setState('failed');
    } finally {
      loading.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const el = end.current;
    if (!el || !next || state !== 'ready') return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void load(next);
    });
    watcher.observe(el);
    return () => watcher.disconnect();
  }, [next, state, load]);

  return (
    <div className="k-stack k-g8">
      {state === 'ready' && sessions.length === 0 && <p className="k-sm k-muted wr-flush">No sessions yet: what you ask the assistant is kept here.</p>}
      {sessions.length > 0 && (
        <ul className="k-stack wr-chat-sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="k-row wr-chat-session"
                aria-current={assistant.sessionId === s.id ? 'true' : undefined}
                onClick={async () => {
                  if (await assistant.openSession(s.id)) onChosen();
                  else toast.fail('That session could not be opened.');
                }}
              >
                <span className="k-grow k-stack">
                  <strong className="k-sm k-ellipsis">{s.title}</strong>
                  <span className="k-xs k-muted">
                    {s.draftLabel ?? (s.launchId === null ? 'An article on Write' : `Launch ${s.launchId}`)} · {when.format(new Date(s.updatedAt))}
                  </span>
                </span>
                <Icon name="chevronRight" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div ref={end} aria-hidden="true" />
      {state === 'loading' && (
        <p className="k-sm k-muted wr-flush" role="status">
          Loading…
        </p>
      )}
      {state === 'failed' && (
        <p className="k-sm wr-problem wr-flush" role="alert">
          The history could not be loaded.{' '}
          <button type="button" className="wr-textbutton" onClick={() => void load(next ?? undefined)}>
            Try again
          </button>
        </p>
      )}
      {state === 'ready' && next && (
        <button type="button" className="k-btn k-sm wr-chat-more" onClick={() => void load(next)}>
          Load more
        </button>
      )}
    </div>
  );
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface SurfaceProps {
  assistant: Assistant;
  /** What the conversation is about, for the line above it ("An article on Write") */
  about: string;
  draft: string;
  setDraft: (draft: string) => void;
  view: 'chat' | 'history';
  setView: (view: 'chat' | 'history') => void;
  onClose: () => void;
  /** In the phone's sheet: the whole height, the send button the screen's yellow one */
  sheet?: boolean;
}

/** The chat itself: header with the history and the new session, the conversation, the form */
function Surface({ assistant, about, draft, setDraft, view, setView, onClose, sheet }: SurfaceProps) {
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Whether the reader is at the bottom: only then does a new message pull the view down with it
  const following = useRef(true);
  const seen = useRef(0);
  const busy = assistant.chat.some((m) => m.streaming);
  const last = assistant.chat.at(-1);
  const icon = `k-btn k-icon k-ghost${sheet ? '' : ' k-sm'}`;

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const grew = assistant.chat.length !== seen.current;
    seen.current = assistant.chat.length;
    // The owner's own question always scrolls into view, even from further up
    if (last?.role === 'user' && grew) following.current = true;
    if (!following.current) return;
    // Lenis only drives the page's root scroller, so this nested one scrolls natively; a new message
    // glides, the text growing token by token just stays pinned, and reduced motion never animates
    el.scrollTo({ top: el.scrollHeight, behavior: grew && !reducedMotion() ? 'smooth' : 'auto' });
  }, [assistant.chat.length, last?.content, view, last?.role]);

  useEffect(() => {
    if (view === 'chat') input.current?.focus();
  }, [view]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    assistant.send(draft.trim());
    setDraft('');
  };

  return (
    <aside className={sheet ? 'wr-chat wr-chat-in-sheet' : 'k-card wr-chat wr-chat-card'} aria-label="The assistant’s chat">
      {/* The tour points at the header, not the panel: on a phone the panel is taller than the room left for the card */}
      <header className="k-hrow k-between wr-chat-head" data-tour="assistant">
        <span className="k-hrow k-g8 wr-strong">
          <Icon name={view === 'history' ? 'history' : 'assist'} />
          {view === 'history' ? 'Past sessions' : 'Assistant'}
        </span>
        <div className="k-hrow k-g4">
          <button
            type="button"
            className={icon}
            onClick={() => setView(view === 'history' ? 'chat' : 'history')}
            aria-label={view === 'history' ? 'Back to the chat' : 'Past sessions'}
            aria-pressed={view === 'history'}
          >
            <Icon name="history" />
          </button>
          <button
            type="button"
            className={icon}
            onClick={() => {
              assistant.newSession();
              setView('chat');
            }}
            disabled={busy || (assistant.chat.length === 0 && view === 'chat')}
            aria-label="New session"
          >
            <Icon name="plus" />
          </button>
          <button type="button" className={icon} onClick={onClose} aria-label="Close the chat" aria-expanded="true">
            <Icon name="close" />
          </button>
        </div>
      </header>
      {/* Focusable, so a keyboard can scroll a conversation longer than the panel */}
      <div
        className="k-stack k-g12 wr-chat-list"
        ref={list}
        role="region"
        aria-label={view === 'history' ? 'Past sessions' : 'Messages'}
        tabIndex={0}
        data-lenis-prevent
        onScroll={(e) => {
          const el = e.currentTarget;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
        }}
      >
        {view === 'history' ? (
          <History assistant={assistant} onChosen={() => setView('chat')} />
        ) : (
          <>
            <div className="k-xs k-muted wr-chat-about">
              {about} · {assistant.selected ? 'about the selection' : 'about the whole text'}
            </div>
            {assistant.chat.length === 0 ? (
              <p className="k-sm k-muted wr-flush">Ask for anything about the text. Select a passage first to work on it alone; otherwise the assistant answers about the whole text. Every change it proposes is a diff you accept or reject.</p>
            ) : (
              assistant.chat.map((m) =>
                m.role === 'user' ? (
                  <p key={m.id} className="wr-chat-mine">
                    {m.content}
                  </p>
                ) : (
                  <Answer key={m.id} message={m} assistant={assistant} />
                ),
              )
            )}
          </>
        )}
      </div>
      {view === 'chat' && (
        <form
          className="k-stack k-g6 wr-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="k-hrow k-g8">
            <label htmlFor="chat-input" className="visually-hidden">
              Your request
            </label>
            <textarea
              id="chat-input"
              ref={input}
              className="k-input k-grow wr-chat-input"
              rows={1}
              value={draft}
              placeholder={assistant.selected ? 'About the selected passage…' : 'About the whole text…'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {busy ? (
              <button type="button" className="k-btn k-icon" onClick={assistant.stopChat} aria-label="Stop the answer">
                <Icon name="close" />
              </button>
            ) : (
              <button type="submit" className={`k-btn k-icon${sheet ? ' k-pri' : ''}`} disabled={!draft.trim()} aria-label="Send">
                <Icon name="send" />
              </button>
            )}
          </div>
          <span className="k-xs k-muted">Enter sends, Shift+Enter a new line</span>
        </form>
      )}
    </aside>
  );
}

export interface ChatPanelProps {
  assistant: Assistant;
  /** From 960 px: whether the panel shows beside the text */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * On a phone: whether the chat's sheet is open. A page that opens it from its own controls (the
   * Assist sheet's "Open the chat") passes these; without them the phone shows a floating button
   * that opens it.
   */
  sheetOpen?: boolean;
  onSheetOpenChange?: (open: boolean) => void;
  /** What the conversation is about, for the line above it; the draft's name by default */
  about?: string;
}

/**
 * The assistant's chat (boards AssistChat and the desktop editors' side card): open requests about
 * the text ("make the opening more personal"). A proposed rewrite comes as a diff to accept or
 * reject; it replaces what was selected when the question was sent, or the whole text. The history
 * button lists the past sessions to take one up again. On a phone it is a sheet over the page; the
 * selection made in the text stays, so the chat still works on it.
 */
export function ChatPanel({ assistant, open, onOpenChange, sheetOpen, onSheetOpenChange, about }: ChatPanelProps) {
  const phone = usePhone();
  const [ownSheet, setOwnSheet] = useState(false);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const controlled = onSheetOpenChange !== undefined;
  const sheet = controlled ? Boolean(sheetOpen) : ownSheet;
  const setSheet = controlled ? onSheetOpenChange : setOwnSheet;
  const subject = about ?? assistant.target.draftLabel ?? 'The text';

  if (phone)
    return (
      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        {!controlled && (
          <Dialog.Trigger
            render={
              <button type="button" className="k-btn k-icon wr-chat-fab" aria-label="Open the assistant’s chat" data-tour="assistant">
                <Icon name="comments" />
              </button>
            }
          />
        )}
        <Dialog.Portal>
          <Dialog.Backdrop className="k-scrim wr-chat-scrim" />
          <Dialog.Popup className="wr-chat-sheet" aria-label="The assistant’s chat">
            <Surface assistant={assistant} about={subject} draft={draft} setDraft={setDraft} view={view} setView={setView} onClose={() => setSheet(false)} sheet />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );

  // A page with its own "Open the chat" (Write) shows nothing while it is closed; others keep the button
  if (!open)
    return controlled ? null : (
      <button type="button" className="k-btn k-icon wr-chat-fab" aria-label="Open the assistant’s chat" aria-expanded={false} data-tour="assistant" onClick={() => onOpenChange(true)}>
        <Icon name="comments" />
      </button>
    );
  return <Surface assistant={assistant} about={subject} draft={draft} setDraft={setDraft} view={view} setView={setView} onClose={() => onOpenChange(false)} />;
}
