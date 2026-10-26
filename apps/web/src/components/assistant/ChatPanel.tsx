import { useEffect, useRef, useState } from 'react';
import { useToast } from '../Toasts';
import { ChatIcon, CloseIcon } from '../ui/icons';
import { splitProposals } from './diff';
import { DiffView } from './DiffView';
import type { Assistant, ChatMessage } from './session';

function Answer({ message, assistant }: { message: ChatMessage; assistant: Assistant }) {
  const toast = useToast();
  const [settled, setSettled] = useState<Record<number, 'accepted' | 'rejected'>>({});
  const pieces = splitProposals(message.content);
  const before = message.range ? (message.original ?? '') : assistant.target.value;
  return (
    <div className="chat-answer">
      {pieces.map((piece, i) =>
        piece.type === 'prose' ? (
          <p key={i} className="chat-prose">
            {piece.text}
          </p>
        ) : (
          <div key={i} className="chat-proposal">
            <DiffView before={before} after={piece.text} label={`Proposal ${i + 1} from the chat`} />
            {!piece.complete ? (
              <p className="muted">Still writing this proposal…</p>
            ) : settled[i] ? (
              <p className="muted">{settled[i] === 'accepted' ? 'Accepted' : 'Rejected'}</p>
            ) : (
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary btn-small"
                  onClick={() => {
                    const ok = assistant.accept({ range: message.range, original: before, text: piece.text });
                    if (ok) setSettled({ ...settled, [i]: 'accepted' });
                    else toast.fail('The text changed under this proposal: ask again on the text as it is now.');
                  }}
                >
                  Accept
                </button>
                <button type="button" className="btn btn-small" onClick={() => setSettled({ ...settled, [i]: 'rejected' })}>
                  Reject
                </button>
              </div>
            )}
          </div>
        ),
      )}
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
  );
}

/**
 * The side chat: open requests about the text ("make the opening punchier", "is this too long for
 * Bluesky?"). A proposed rewrite comes as a diff to accept or reject; it replaces what was selected
 * when the question was sent, or the whole text. Closes to an icon.
 */
export function ChatPanel({ assistant, open, onOpenChange }: { assistant: Assistant; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = assistant.chat.some((m) => m.streaming);
  const last = assistant.chat.at(-1);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [assistant.chat.length, last?.content]);

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open)
    return (
      <button type="button" className="chat-fab" onClick={() => onOpenChange(true)} aria-label="Open the assistant’s chat" aria-expanded="false" data-tour="assistant">
        <ChatIcon size={22} />
      </button>
    );

  const submit = () => {
    if (!draft.trim() || busy) return;
    assistant.send(draft.trim());
    setDraft('');
  };

  return (
    <aside className="chat-panel" aria-label="The assistant’s chat">
      {/* The tour points at the header, not the panel: on a phone the panel is taller than the room left for the card */}
      <header className="chat-head" data-tour="assistant">
        <strong>Assistant</strong>
        <div className="row">
          {assistant.chat.length > 0 && (
            <button type="button" className="btn-link" onClick={assistant.clearChat} disabled={busy}>
              New chat
            </button>
          )}
          <button type="button" className="ui-icon-button" onClick={() => onOpenChange(false)} aria-label="Close the chat" aria-expanded="true">
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="chat-list" ref={list}>
        {assistant.chat.length === 0 ? (
          <p className="muted chat-empty">
            Ask for anything about the text. Select a passage first to work on it alone; otherwise the assistant answers about the whole text. Every change it proposes is a diff you accept or reject.
          </p>
        ) : (
          assistant.chat.map((m) =>
            m.role === 'user' ? (
              <p key={m.id} className="chat-mine">
                {m.content}
              </p>
            ) : (
              <Answer key={m.id} message={m} assistant={assistant} />
            ),
          )
        )}
      </div>
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
        <div className="row">
          {busy ? (
            <button type="button" className="btn btn-small" onClick={assistant.stopChat}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-small" disabled={!draft.trim()}>
              Send
            </button>
          )}
          <small className="muted">Enter sends, Shift+Enter a new line</small>
        </div>
      </form>
    </aside>
  );
}
