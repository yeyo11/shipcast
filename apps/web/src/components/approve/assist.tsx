import { useCallback, useEffect, useRef, useState } from 'react';
import { listAssistantSessions, type SessionSummary } from '../../server/assistant.functions';
import { splitProposals } from '../assistant/diff';
import { ADAPT_NETWORKS } from '../assistant/protocol';
import type { Assistant, ChatMessage } from '../assistant/session';
import { Icon } from '../kit/Icon';
import { Sheet } from '../kit/Sheet';
import { useToast } from '../Toasts';
import { InlineDiff } from './parts';

/*
 * The writing assistant around a draft (boards DraftEditor and DesktopDraftEditor): the quick
 * actions in a sheet, the proposal they bring back as a diff to accept or reject, and the chat card.
 * The logic is the assistant's own (assistant/session.ts); nothing changes the text but Accept.
 */

const quote = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

/** "Assist": the quick actions on the selection or the whole text, the check, and the chat */
export function AssistSheet({ assistant, open, onOpenChange, onCheck, onChat }: { assistant: Assistant; open: boolean; onOpenChange: (open: boolean) => void; onCheck: () => void; onChat: () => void }) {
  const [adapting, setAdapting] = useState(false);
  const lang = assistant.target.lang;
  const translate = lang === 'es' ? 'Translate to English' : lang === 'en' ? 'Translate to Spanish' : 'Translate EN ↔ ES';
  const act = (fn: () => void) => () => {
    fn();
    setAdapting(false);
    onOpenChange(false);
  };
  const disabledCheck = assistant.target.checkDisabled;
  return (
    <Sheet label="Assist" open={open} onOpenChange={(o) => (setAdapting(false), onOpenChange(o))} className="ap-sheet">
      <div className="k-stack k-g4">
        <div className="k-hrow k-g8">
          <Icon name="assist" size={20} />
          <strong className="ap-sheet-title">Assist</strong>
        </div>
        <span className="k-xs k-muted">{assistant.selected ? `With the selection: “${quote(assistant.selected)}”` : 'With the whole text (select a passage to work on it alone)'}</span>
      </div>
      <div className="k-stack">
        {adapting ? (
          <>
            <button type="button" className="k-mi" onClick={() => setAdapting(false)}>
              <Icon name="chevronLeft" size={18} />
              Adapt for a network
            </button>
            {ADAPT_NETWORKS.map((n) => (
              <button key={n.id} type="button" className="k-mi" onClick={act(() => assistant.run('adapt', n))}>
                {n.name}
              </button>
            ))}
          </>
        ) : (
          <>
            <button type="button" className="k-mi" onClick={act(() => assistant.run('improve'))}>
              Improve
            </button>
            <button type="button" className="k-mi" onClick={act(() => assistant.run('shorten'))}>
              Shorten
            </button>
            <button type="button" className="k-mi" onClick={act(() => assistant.run('translate'))}>
              {translate}
            </button>
            <button type="button" className="k-mi" onClick={act(() => assistant.run('titles'))}>
              Propose titles
            </button>
            <button type="button" className="k-mi k-between" onClick={() => setAdapting(true)}>
              Adapt for a network
              <Icon name="chevronRight" size={18} />
            </button>
            <div className="k-sep" />
            <button type="button" className="k-mi" disabled={Boolean(disabledCheck)} onClick={act(onCheck)}>
              Check against the repo’s code
            </button>
            {disabledCheck && <span className="k-xs k-muted ap-mi-note">{disabledCheck}</span>}
            <button type="button" className="k-mi" onClick={act(onChat)}>
              <Icon name="comments" size={18} />
              Open the chat
            </button>
          </>
        )}
      </div>
    </Sheet>
  );
}

/** The quick action's answer over the text: what it changes, and Accept or Reject */
export function ProposalCard({ assistant, onProblem }: { assistant: Assistant; onProblem: () => void }) {
  const p = assistant.proposal;
  if (!p) return null;
  return (
    <section className="k-card ap-proposal" aria-label={`Proposal: ${p.label}`}>
      <div className="k-hrow k-between k-g8">
        <span className="k-hrow k-g8">
          <Icon name="assist" size={18} />
          <strong>Proposal: {p.label}</strong>
        </span>
        <span className="k-xs k-muted">{p.range ? 'on the selection' : 'on the whole text'}</span>
      </div>
      {p.problem ? (
        <p className="k-sm ap-m0 ap-bad-text" role="alert">
          {p.problem}
        </p>
      ) : p.titles && !p.text ? (
        <div className="k-stack k-g8">
          <span className="k-sm k-muted">Pick one to see it against the text:</span>
          {p.titles.map((t) => (
            <button key={t} type="button" className="k-btn k-sm ap-title-pick" onClick={() => assistant.chooseTitle(t)}>
              {t}
            </button>
          ))}
        </div>
      ) : p.streaming && !p.text ? (
        <p className="k-sm k-muted ap-m0" role="status">
          {p.whole ? 'Working… the answer arrives all at once' : 'Writing…'}
        </p>
      ) : (
        <>
          <div className="ap-proposal-text" tabIndex={0} role="region" aria-label={`${p.label}: the change`}>
            <InlineDiff before={p.original} after={p.text} />
          </div>
          <div className="k-hrow k-g12 k-xs k-muted">
            <span className="ap-legend">
              <i className="ap-add" />
              added
            </span>
            <span className="ap-legend">
              <i className="ap-del" />
              removed
            </span>
          </div>
        </>
      )}
      <div className="k-hrow k-g8">
        <button type="button" className="k-btn" onClick={assistant.rejectProposal}>
          {p.streaming ? 'Stop' : 'Reject'}
        </button>
        <button
          type="button"
          className="k-btn k-pri ap-grow-btn"
          disabled={p.streaming || !p.text || Boolean(p.problem)}
          onClick={() => {
            if (!assistant.acceptProposal()) onProblem();
          }}
        >
          <Icon name="check" size={18} />
          Accept
        </button>
      </div>
    </section>
  );
}

function Answer({ message, assistant }: { message: ChatMessage; assistant: Assistant }) {
  const toast = useToast();
  const settled = message.settled ?? {};
  const before = message.range ? (message.original ?? '') : assistant.target.value;
  let ordinal = -1;
  return (
    <div className="k-stack k-g8">
      {splitProposals(message.content).map((piece, i) => {
        if (piece.type === 'prose')
          return (
            <div key={i} className="k-sm ap-answer">
              {piece.text}
            </div>
          );
        const n = ++ordinal;
        return (
          <div key={i} className="k-card ap-chat-proposal">
            <span className="k-xs k-muted">Proposal {n + 1} from the chat</span>
            <span className="k-sm">
              <InlineDiff before={before} after={piece.text} compact />
            </span>
            {!piece.complete ? (
              <span className="k-xs k-muted">Still writing this proposal…</span>
            ) : settled[n] ? (
              <span className="k-xs k-muted">{settled[n] === 'accepted' ? 'Accepted' : 'Rejected'}</span>
            ) : (
              <div className="k-hrow k-g8">
                <button type="button" className="k-btn k-sm" onClick={() => assistant.settle(message, n, 'rejected')}>
                  Reject
                </button>
                <button
                  type="button"
                  className="k-btn k-sm ap-accept"
                  onClick={() => {
                    if (assistant.accept({ range: message.range, original: before, text: piece.text })) assistant.settle(message, n, 'accepted');
                    else toast.fail('The text changed under this proposal: ask again on the text as it is now.');
                  }}
                >
                  <Icon name="check" size={16} />
                  Accept
                </button>
              </div>
            )}
          </div>
        );
      })}
      {message.streaming && !message.content && (
        <span className="k-sm k-muted" role="status">
          Writing…
        </span>
      )}
      {message.problem && (
        <span className="k-sm ap-bad-text" role="alert">
          {message.problem}
        </span>
      )}
    </div>
  );
}

const sessionWhen = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

function History({ assistant, onChosen }: { assistant: Assistant; onChosen: () => void }) {
  const toast = useToast();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const load = useCallback(async (cursor?: string) => {
    setState('loading');
    try {
      const page = await listAssistantSessions({ data: { limit: 20, ...(cursor && { cursor }) } });
      setSessions((all) => (cursor ? [...all, ...page.sessions] : page.sessions));
      setNext(page.next);
      setState('ready');
    } catch {
      setState('failed');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="k-stack k-g4">
      {state === 'ready' && sessions.length === 0 && <p className="k-sm k-muted ap-m0">No sessions yet: what you ask the assistant is kept here.</p>}
      {sessions.map((s) => (
        <button
          key={s.id}
          type="button"
          className="ap-session"
          aria-current={assistant.sessionId === s.id ? 'true' : undefined}
          onClick={async () => {
            if (await assistant.openSession(s.id)) onChosen();
            else toast.fail('That session could not be opened.');
          }}
        >
          <strong className="k-sm">{s.title}</strong>
          <span className="k-xs k-muted">
            {s.draftLabel ?? (s.launchId === null ? 'An article on Write' : `Launch ${s.launchId}`)} · {sessionWhen.format(new Date(s.updatedAt))}
          </span>
        </button>
      ))}
      {state === 'loading' && (
        <span className="k-sm k-muted" role="status">
          Loading…
        </span>
      )}
      {state === 'failed' && (
        <span className="k-sm ap-bad-text" role="alert">
          The history could not be loaded.
        </span>
      )}
      {state === 'ready' && next && (
        <button type="button" className="k-btn k-sm" onClick={() => void load(next)}>
          Load more
        </button>
      )}
    </div>
  );
}

/** The assistant's chat as the desktop's side card (and the phone's sheet): its history, the talk, the question */
export function ChatCard({ assistant, focusKey }: { assistant: Assistant; focusKey?: number }) {
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = assistant.chat.some((m) => m.streaming);
  const last = assistant.chat.at(-1);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [assistant.chat.length, last?.content]);
  useEffect(() => {
    if (focusKey) input.current?.focus();
  }, [focusKey]);
  const submit = () => {
    if (!draft.trim() || busy) return;
    assistant.send(draft.trim());
    setDraft('');
  };
  return (
    <aside className="k-card ap-chat" aria-label="The assistant’s chat">
      <div className="k-hrow k-between">
        <span className="k-hrow k-g8 ap-strong">
          <Icon name="assist" size={18} />
          {view === 'history' ? 'Past sessions' : 'Assistant'}
        </span>
        <div className="k-hrow k-g4">
          <button type="button" className="k-btn k-icon k-sm k-ghost" aria-label={view === 'history' ? 'Back to the chat' : 'Past sessions'} aria-pressed={view === 'history'} onClick={() => setView(view === 'history' ? 'chat' : 'history')}>
            <Icon name="history" />
          </button>
          <button
            type="button"
            className="k-btn k-icon k-sm k-ghost"
            aria-label="New session"
            disabled={busy || (assistant.chat.length === 0 && view === 'chat')}
            onClick={() => {
              assistant.newSession();
              setView('chat');
            }}
          >
            <Icon name="plus" />
          </button>
        </div>
      </div>
      <div className="ap-chat-list" ref={list} role="region" aria-label={view === 'history' ? 'Past sessions' : 'Messages'} tabIndex={0} data-lenis-prevent>
        {view === 'history' ? (
          <History assistant={assistant} onChosen={() => setView('chat')} />
        ) : assistant.chat.length === 0 ? (
          <p className="k-sm k-muted ap-m0">Ask for anything about the text. Select a passage first to work on it alone. Every change it proposes is a diff you accept or reject.</p>
        ) : (
          assistant.chat.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ap-mine">
                {m.content}
              </div>
            ) : (
              <Answer key={m.id} message={m} assistant={assistant} />
            ),
          )
        )}
      </div>
      {view === 'chat' && (
        <form
          className="k-hrow k-g8 ap-chat-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor="ap-chat-input" className="visually-hidden">
            Your request
          </label>
          <textarea
            id="ap-chat-input"
            ref={input}
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
            <button type="button" className="k-btn k-icon" aria-label="Stop" onClick={assistant.stopChat}>
              <Icon name="close" />
            </button>
          ) : (
            <button type="submit" className="k-btn k-icon" aria-label="Send" disabled={!draft.trim()}>
              <Icon name="send" />
            </button>
          )}
        </form>
      )}
    </aside>
  );
}
