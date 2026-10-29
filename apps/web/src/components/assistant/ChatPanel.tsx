import { Dialog } from '@base-ui/react/dialog';
import { getRouteApi } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useToast } from '../Toasts';
import { Avatar } from '../ui';
import { ChatIcon, CloseIcon, HistoryIcon, PlusIcon } from '../ui/icons';
import { listAssistantSessions, type SessionSummary } from '../../server/assistant.functions';
import { splitProposals } from './diff';
import { DiffView } from './DiffView';
import type { Assistant, ChatMessage } from './session';

/** The Shipcast mark (design/logo/mark.svg), inline so it needs no request and takes no theme */
function ShipcastMark({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <rect x="10" y="10" width="50" height="50" rx="14" fill="#F4F2EC" />
      <rect x="4" y="4" width="50" height="50" rx="14" fill="#FFD43B" stroke="#000" strokeWidth="4" />
      <circle cx="29" cy="29" r="9" fill="#000" />
    </svg>
  );
}

const SHELL = getRouteApi('/_app');

/** The signed-in owner's GitHub picture, from the shell's loader; their initial while there is none */
function Mine({ children }: { children: string }) {
  const { login, avatarUrl } = SHELL.useLoaderData();
  return (
    <div className="chat-row chat-row-mine">
      <p className="chat-mine">{children}</p>
      <span className="chat-avatar">{avatarUrl ? <Avatar src={avatarUrl} alt="" size={28} /> : <span className="chat-initial" aria-hidden="true">{login.slice(0, 1).toUpperCase()}</span>}</span>
    </div>
  );
}

function Answer({ message, assistant }: { message: ChatMessage; assistant: Assistant }) {
  const toast = useToast();
  const settled = message.settled ?? {};
  const pieces = splitProposals(message.content);
  // A proposal is numbered among the answer's proposals, as the server saves them
  let ordinal = -1;
  const before = message.range ? (message.original ?? '') : assistant.target.value;
  return (
    <div className="chat-row">
      <span className="chat-avatar chat-avatar-mark">
        <ShipcastMark size={28} />
      </span>
      <div className="chat-answer">
        {pieces.map((piece, i) => {
          if (piece.type === 'prose')
            return (
              <p key={i} className="chat-prose">
                {piece.text}
              </p>
            );
          const n = ++ordinal;
          return (
            <div key={i} className="chat-proposal">
              <DiffView before={before} after={piece.text} label={`Proposal ${n + 1} from the chat`} />
              {!piece.complete ? (
                <p className="muted">Still writing this proposal…</p>
              ) : settled[n] ? (
                <p className="muted">{settled[n] === 'accepted' ? 'Accepted' : 'Rejected'}</p>
              ) : (
                <div className="row">
                  <button
                    type="button"
                    className="btn btn-primary btn-small"
                    onClick={() => {
                      const ok = assistant.accept({ range: message.range, original: before, text: piece.text });
                      if (ok) assistant.settle(message, n, 'accepted');
                      else toast.fail('The text changed under this proposal: ask again on the text as it is now.');
                    }}
                  >
                    Accept
                  </button>
                  <button type="button" className="btn btn-small" onClick={() => assistant.settle(message, n, 'rejected')}>
                    Reject
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {message.streaming && (
          <p className="muted chat-wait" role="status">
            {message.whole ? 'Writing… with this provider the answer arrives all at once' : message.content ? '' : 'Writing…'}
          </p>
        )}
        {message.problem && (
          <p className="problem" role="alert">
            {message.problem}
          </p>
        )}
      </div>
    </div>
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
    <div className="chat-history">
      {state === 'ready' && sessions.length === 0 && <p className="muted chat-empty">No sessions yet: what you ask the assistant is kept here.</p>}
      {sessions.length > 0 && (
        <ul className="chat-sessions">
          {sessions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="chat-session"
                aria-current={assistant.sessionId === s.id ? 'true' : undefined}
                onClick={async () => {
                  if (await assistant.openSession(s.id)) onChosen();
                  else toast.fail('That session could not be opened.');
                }}
              >
                <strong className="chat-session-title">{s.title}</strong>
                <span className="muted">
                  {s.draftLabel ?? (s.launchId === null ? 'An article on Write' : `Launch ${s.launchId}`)} · {when.format(new Date(s.updatedAt))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div ref={end} aria-hidden="true" />
      {state === 'loading' && (
        <p className="muted" role="status">
          Loading…
        </p>
      )}
      {state === 'failed' && (
        <p className="problem" role="alert">
          The history could not be loaded.{' '}
          <button type="button" className="btn-link" onClick={() => void load(next ?? undefined)}>
            Try again
          </button>
        </p>
      )}
      {state === 'ready' && next && (
        <button type="button" className="btn btn-small" onClick={() => void load(next)}>
          Load more
        </button>
      )}
    </div>
  );
}

const PHONE = '(max-width: 760px)';

/** Whether the screen is a phone's: the chat becomes a bubble and a full-screen sheet there */
function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface SurfaceProps {
  assistant: Assistant;
  draft: string;
  setDraft: (draft: string) => void;
  view: 'chat' | 'history';
  setView: (view: 'chat' | 'history') => void;
  onClose: () => void;
  /** In the sheet the panel is the whole screen, not a card beside the text */
  sheet?: boolean;
}

/** The chat itself: header with the history and the new session, the conversation, the form */
function Surface({ assistant, draft, setDraft, view, setView, onClose, sheet }: SurfaceProps) {
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Whether the reader is at the bottom: only then does a new message pull the view down with it
  const following = useRef(true);
  const seen = useRef(0);
  const busy = assistant.chat.some((m) => m.streaming);
  const last = assistant.chat.at(-1);

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
    <aside className={`chat-panel${sheet ? ' chat-panel-sheet' : ''}`} aria-label="The assistant’s chat">
      {/* The tour points at the header, not the panel: on a phone the panel is taller than the room left for the card */}
      <header className="chat-head" data-tour="assistant">
        <strong>{view === 'history' ? 'Past sessions' : 'Assistant'}</strong>
        <div className="row">
          <button
            type="button"
            className="ui-icon-button"
            onClick={() => setView(view === 'history' ? 'chat' : 'history')}
            aria-label={view === 'history' ? 'Back to the chat' : 'Past sessions'}
            aria-pressed={view === 'history'}
          >
            <HistoryIcon />
          </button>
          <button
            type="button"
            className="ui-icon-button"
            onClick={() => {
              assistant.newSession();
              setView('chat');
            }}
            disabled={busy || (assistant.chat.length === 0 && view === 'chat')}
            aria-label="New session"
          >
            <PlusIcon />
          </button>
          <button type="button" className="ui-icon-button" onClick={onClose} aria-label="Close the chat" aria-expanded="true">
            <CloseIcon />
          </button>
        </div>
      </header>
      {/* Focusable, so a keyboard can scroll a conversation longer than the panel */}
      <div
        className="chat-list"
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
        ) : assistant.chat.length === 0 ? (
          <p className="muted chat-empty">
            Ask for anything about the text. Select a passage first to work on it alone; otherwise the assistant answers about the whole text. Every change it proposes is a diff you accept or reject.
          </p>
        ) : (
          assistant.chat.map((m) => (m.role === 'user' ? <Mine key={m.id}>{m.content}</Mine> : <Answer key={m.id} message={m} assistant={assistant} />))
        )}
      </div>
      {view === 'chat' && (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="chat-input" className="visually-hidden">
            Your request
          </label>
          <textarea
            id="chat-input"
            ref={input}
            className="textarea chat-input"
            rows={2}
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
            <button type="button" className="btn btn-small chat-send" onClick={assistant.stopChat}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary chat-send" disabled={!draft.trim()}>
              Send
            </button>
          )}
          <small className="muted">Enter sends, Shift+Enter a new line</small>
        </form>
      )}
    </aside>
  );
}

/**
 * The side chat: open requests about the text ("make the opening punchier", "is this too long for
 * Bluesky?"). A proposed rewrite comes as a diff to accept or reject; it replaces what was selected
 * when the question was sent, or the whole text. The header's history button lists the past sessions
 * to take one up again. Closes to an icon. On a phone it is a floating bubble that opens the chat as
 * a full-screen sheet; the selection made in the text stays, so the chat still works on it.
 */
export function ChatPanel({ assistant, open, onOpenChange }: { assistant: Assistant; open: boolean; onOpenChange: (open: boolean) => void }) {
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<'chat' | 'history'>('chat');

  const bubble = (props: { onClick?: () => void }) => (
    <button type="button" className="chat-fab" aria-label="Open the assistant’s chat" aria-expanded={false} data-tour="assistant" {...props}>
      <ChatIcon size={22} />
    </button>
  );

  if (phone)
    return (
      <Dialog.Root open={sheet} onOpenChange={setSheet}>
        {/* The bubble is the dialog's trigger, so closing the sheet gives the focus back to it */}
        <Dialog.Trigger render={bubble({})} />
        <Dialog.Portal>
          <Dialog.Popup className="chat-sheet" aria-label="The assistant’s chat">
            <Surface assistant={assistant} draft={draft} setDraft={setDraft} view={view} setView={setView} onClose={() => setSheet(false)} sheet />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );

  if (!open) return bubble({ onClick: () => onOpenChange(true) });
  return <Surface assistant={assistant} draft={draft} setDraft={setDraft} view={view} setView={setView} onClose={() => onOpenChange(false)} />;
}
