import { Menu } from '@base-ui/react/menu';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { useToast } from '../Toasts';
import { usePhone } from '../kit/usePhone';
import { caretPoint } from './caret';
import { sentenceContext } from './diff';
import { DiffView } from './DiffView';
import { ADAPT_NETWORKS, type Action } from './protocol';
import type { Assistant } from './session';

const VERDICTS: Record<string, { label: string; dot: string }> = {
  backed: { label: 'Backed by the code', dot: 'k-dot-pub' },
  planned: { label: 'Planned, not built', dot: 'k-dot-quiet' },
  'not-found': { label: 'Not found in the code', dot: 'k-dot-quiet' },
  contradicted: { label: 'The code says otherwise', dot: 'k-dot-fail' },
};

/** What the assistant is asked to work on, in the words the menu and the sheet lead with */
function scope(assistant: Assistant): string {
  if (!assistant.selected) return 'With the whole text (select a passage to work on it alone)';
  const quote = assistant.selected.trim().replace(/\s+/g, ' ');
  return `With the selection: “${quote.length > 90 ? `${quote.slice(0, 90).replace(/\s\S*$/, '')}…` : quote}”`;
}

function translateLabel(assistant: Assistant): string {
  const lang = assistant.target.lang;
  return lang === 'es' ? 'Translate to English' : lang === 'en' ? 'Translate to Spanish' : 'Translate EN ↔ ES';
}

const QUICK: ReadonlyArray<[Exclude<Action, 'adapt' | 'check' | 'translate'>, string]> = [
  ['improve', 'Improve'],
  ['shorten', 'Shorten'],
];

/**
 * The quick actions as a dropdown (from 960 px): the same list from the toolbar's Assist and from the
 * small button beside a selection. Arrow keys move, Enter acts, Escape closes.
 */
function AssistMenu({ assistant, trigger, onOpenChat }: { assistant: Assistant; trigger: ReactElement; onOpenChat?: () => void }) {
  const item = (action: Action, label: string, disabled?: boolean) => (
    <Menu.Item className="k-mi k-option" onClick={() => assistant.run(action)} disabled={disabled}>
      {label}
    </Menu.Item>
  );
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner className="k-pop-positioner" sideOffset={6} align="start">
          <Menu.Popup className="k-menu k-pop-list wr-assist-menu">
            <div className="k-xs k-muted wr-menu-note">{scope(assistant)}</div>
            {QUICK.map(([action, label]) => (
              <Menu.Item key={action} className="k-mi k-option" onClick={() => assistant.run(action)}>
                {label}
              </Menu.Item>
            ))}
            {item('translate', translateLabel(assistant))}
            {item('titles', 'Propose titles')}
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className="k-mi k-option">
                <span className="k-grow">Adapt for a network</span>
                <Icon name="chevronRight" size={18} />
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner className="k-pop-positioner" sideOffset={4} alignOffset={-6}>
                  <Menu.Popup className="k-menu k-pop-list">
                    {ADAPT_NETWORKS.map((n) => (
                      <Menu.Item key={n.id} className="k-mi k-option" onClick={() => assistant.run('adapt', n)}>
                        {n.name}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            <Menu.Separator className="k-sep" />
            {item('check', 'Check against the repo’s code', Boolean(assistant.target.checkDisabled))}
            {assistant.target.checkDisabled && <div className="k-xs k-muted wr-menu-note">{assistant.target.checkDisabled}</div>}
            {onOpenChat && (
              <Menu.Item className="k-mi k-option" onClick={onOpenChat}>
                <span className="k-hrow k-g12">
                  <Icon name="comments" />
                  Open the chat
                </span>
              </Menu.Item>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The quick actions as the board's bottom sheet (AssistMenu), on a phone */
function AssistSheet({ assistant, open, onOpenChange, onOpenChat }: { assistant: Assistant; open: boolean; onOpenChange: (open: boolean) => void; onOpenChat?: () => void }) {
  const [view, setView] = useState<'actions' | 'adapt'>('actions');
  useEffect(() => {
    if (open) setView('actions');
  }, [open]);
  const act = (action: Action, adaptTo?: { id: string; name: string }) => {
    assistant.run(action, adaptTo);
    onOpenChange(false);
  };
  const row = (action: Action, label: string, disabled?: boolean, why?: string) => (
    <button type="button" className="k-mi" onClick={() => act(action)} disabled={disabled} aria-describedby={why ? 'assist-sheet-why' : undefined} title={why}>
      {label}
    </button>
  );
  return (
    <Overlay kind="menu" label="Assist" open={open} onOpenChange={onOpenChange} className="wr-assist-sheet">
      <div className="k-stack k-g4 wr-sheet-head">
        <span className="k-hrow k-g8 wr-sheet-title">
          <Icon name="assist" />
          Assist
        </span>
        <span className="k-xs k-muted">{scope(assistant)}</span>
      </div>
      {view === 'adapt' ? (
        <div className="k-stack">
          <button type="button" className="k-mi wr-sheet-back" onClick={() => setView('actions')}>
            <Icon name="chevronLeft" size={18} />
            Adapt for a network
          </button>
          <div className="k-sep" />
          {ADAPT_NETWORKS.map((n) => (
            <button key={n.id} type="button" className="k-mi" onClick={() => act('adapt', n)}>
              {n.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="k-stack">
          {QUICK.map(([action, label]) => (
            <button key={action} type="button" className="k-mi" onClick={() => act(action)}>
              {label}
            </button>
          ))}
          {row('translate', translateLabel(assistant))}
          {row('titles', 'Propose titles')}
          <button type="button" className="k-mi" onClick={() => setView('adapt')}>
            <span className="k-grow">Adapt for a network</span>
            <Icon name="chevronRight" size={18} />
          </button>
          <div className="k-sep" />
          {row('check', 'Check against the repo’s code', Boolean(assistant.target.checkDisabled), assistant.target.checkDisabled)}
          {/* Why it cannot run here, for a screen reader; the sheet keeps the board's list */}
          {assistant.target.checkDisabled && (
            <span id="assist-sheet-why" className="visually-hidden">
              {assistant.target.checkDisabled}
            </span>
          )}
          {onOpenChat && (
            <button
              type="button"
              className="k-mi"
              onClick={() => {
                onOpenChange(false);
                onOpenChat();
              }}
            >
              <Icon name="comments" />
              Open the chat
            </button>
          )}
        </div>
      )}
    </Overlay>
  );
}

/** The quick action's answer (board AssistProposal): the change in place, to accept or reject */
function ProposalCard({ assistant, onAccept }: { assistant: Assistant; onAccept: () => void }) {
  const proposal = assistant.proposal;
  if (!proposal) return null;
  const context = proposal.range ? sentenceContext(assistant.target.value, proposal.range) : undefined;
  const hasText = Boolean(proposal.text);
  return (
    <section className="k-card wr-proposal" aria-label={`Proposal: ${proposal.label}`}>
      <div className="k-hrow k-between k-g8">
        <span className="k-hrow k-g8 wr-strong">
          <Icon name="assist" size={18} />
          Proposal: {proposal.label}
        </span>
        <span className="k-xs k-muted">{proposal.range ? 'on the selection' : 'on the whole text'}</span>
      </div>
      {proposal.streaming && !hasText && (
        <p className="k-sm k-muted wr-flush" role="status">
          {proposal.whole ? 'Writing… the answer arrives all at once' : 'Writing…'}
        </p>
      )}
      {proposal.problem ? (
        <p className="k-sm wr-problem wr-flush" role="alert">
          {proposal.problem}
        </p>
      ) : proposal.titles && !proposal.text ? (
        <div className="k-stack k-g8">
          <span className="k-xs k-muted">Pick one to see it against the text:</span>
          <ul className="k-stack k-g8 wr-titles">
            {proposal.titles.map((t) => (
              <li key={t}>
                <button type="button" className="k-chip wr-title-choice" onClick={() => assistant.chooseTitle(t)}>
                  {t}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {proposal.findings && proposal.findings.length > 0 && (
            <ul className="k-stack wr-findings">
              {proposal.findings.map((f, i) => {
                const verdict = VERDICTS[f.verdict] ?? { label: f.verdict, dot: 'k-dot-quiet' };
                return (
                  <li key={i} className="k-row wr-finding" data-verdict={f.verdict}>
                    <span className="wr-finding-dot">
                      <span className={`k-dot ${verdict.dot}`} />
                    </span>
                    <span className="k-grow k-stack k-g4">
                      <span className="k-sm wr-verdict">{verdict.label}</span>
                      <span className="k-sm">“{f.claim}”</span>
                      <span className="k-xs k-muted">{f.evidence}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {proposal.notice && (
            <p className="k-sm k-muted wr-flush wr-notice" role="status">
              {proposal.notice}
            </p>
          )}
          {(hasText || !proposal.streaming) && <DiffView before={proposal.original} after={proposal.text} label={`${proposal.label}: the change`} context={context} legend className={proposal.range ? undefined : 'wr-diff-whole'} />}
        </>
      )}
      <div className="k-hrow k-g8">
        <button type="button" className="k-btn k-sm" onClick={assistant.rejectProposal}>
          {proposal.streaming ? 'Stop' : 'Reject'}
        </button>
        <button type="button" className="k-btn k-pri k-sm k-grow" onClick={onAccept} disabled={proposal.streaming || !proposal.text || Boolean(proposal.problem)}>
          <Icon name="check" size={18} />
          Accept
        </button>
      </div>
    </section>
  );
}

export interface AssistedEditorProps {
  id: string;
  label: string;
  assistant: Assistant;
  mono?: boolean;
  tall?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: ReactNode;
  /** Opens the assistant's chat: offered in the Assist menu and, from 960 px, beside Assist */
  onOpenChat?: () => void;
  /** What the toolbar says on its right from 960 px (Write's "Markdown · 412 words") */
  meta?: ReactNode;
  className?: string;
}

/**
 * A textarea with the writing assistant: select a passage and a small button offers the quick
 * actions beside it (the toolbar's Assist offers the same, for the keyboard); on a phone they open as
 * a bottom sheet. The answer comes back above the text as a diff to accept or reject.
 */
export function AssistedEditor({ id, label, assistant, mono = false, tall, required, placeholder, help, onOpenChat, meta, className }: AssistedEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const phone = usePhone();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [floating, setFloating] = useState<{ top: number; left: number } | null>(null);
  const { target, proposal } = assistant;

  const readSelection = () => {
    const el = ref.current;
    if (!el) return;
    assistant.setSelection({ start: el.selectionStart, end: el.selectionEnd });
  };

  // The floating button follows the end of a selection made with the pointer or the keyboard
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !assistant.selected || document.activeElement !== el) {
      setFloating(null);
      return;
    }
    const point = caretPoint(el, assistant.selection.end);
    const top = Math.min(Math.max(point.top + point.height + 6, 4), el.clientHeight - 8);
    const left = Math.min(Math.max(point.left - 20, 4), el.clientWidth - 140);
    setFloating({ top, left });
  }, [assistant.selected, assistant.selection.end]);

  // The box grows with the text, as the boards draw it, so a long article scrolls with the page
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '';
    // Only past its minimum: below it the stylesheet's height holds, whatever the layout (a proposal shrinks it)
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [target.value, proposal]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hide = () => setFloating(null);
    el.addEventListener('scroll', hide);
    return () => el.removeEventListener('scroll', hide);
  }, []);

  const accept = () => {
    if (!assistant.acceptProposal()) toast.fail('The text changed under the proposal: ask again on the text as it is now.');
    else ref.current?.focus();
  };

  // On a phone both buttons open the sheet; from 960 px each is a dropdown's trigger
  const assistButton = (
    <button type="button" id={`${id}-assist`} className="k-btn k-sm wr-assist-button" aria-keyshortcuts="Alt+J" onClick={phone ? () => setSheetOpen(true) : undefined}>
      <Icon name="assist" size={16} />
      Assist
    </button>
  );
  const floatButton = (
    <button type="button" id={`${id}-float`} className="k-btn k-sm wr-assist-float-button" aria-label="Assist with the selection" onClick={phone ? () => setSheetOpen(true) : undefined}>
      <Icon name="assist" size={16} />
      <span>Assist</span>
    </button>
  );

  return (
    <div className={`k-field wr-assisted${proposal ? ' wr-has-proposal' : ''}${className ? ` ${className}` : ''}`}>
      <div className="k-hrow k-g8 wr-assisted-bar">
        <label htmlFor={id} className="k-lbl k-grow wr-assisted-label">
          {label}
        </label>
        {phone ? assistButton : <AssistMenu assistant={assistant} trigger={assistButton} onOpenChat={onOpenChat} />}
        {onOpenChat && (
          <button type="button" className="k-btn k-sm wr-desk-inline" onClick={onOpenChat}>
            <Icon name="comments" size={18} />
            Open the chat
          </button>
        )}
        {meta && <span className="k-xs k-muted wr-desk-inline wr-assisted-meta">{meta}</span>}
      </div>
      <ProposalCard assistant={assistant} onAccept={accept} />
      <div className="wr-assisted-box">
        <textarea
          id={id}
          ref={ref}
          className={`k-input wr-textarea${mono ? ' k-mono' : ''}${tall ? ' wr-tall' : ''}`}
          value={target.value}
          required={required}
          placeholder={placeholder}
          onChange={(e) => {
            target.onChange(e.target.value);
            readSelection();
          }}
          onSelect={readSelection}
          onKeyUp={readSelection}
          onMouseUp={readSelection}
          onBlur={(e) => {
            // Moving to the floating button keeps it; anything else hides it
            if (!(e.relatedTarget instanceof HTMLElement && e.relatedTarget.closest('.wr-assist-float'))) setFloating(null);
          }}
          onKeyDown={(e) => {
            if (e.altKey && e.key.toLowerCase() === 'j') {
              e.preventDefault();
              const float = document.getElementById(`${id}-float`);
              (float ?? document.getElementById(`${id}-assist`))?.click();
            }
          }}
          aria-describedby={`${id}-help`}
        />
        {floating && (
          <div className="wr-assist-float" style={{ top: floating.top, left: floating.left }}>
            {phone ? floatButton : <AssistMenu assistant={assistant} trigger={floatButton} onOpenChat={onOpenChat} />}
          </div>
        )}
      </div>
      <span id={`${id}-help`} className="k-help wr-assisted-help">
        {help}
        <span className="visually-hidden"> Select a passage for the assistant, or press Alt+J.</span>
      </span>
      <div className="visually-hidden" role="status" aria-live="polite">
        {assistant.announce}
      </div>
      {phone && <AssistSheet assistant={assistant} open={sheetOpen} onOpenChange={setSheetOpen} onOpenChat={onOpenChat} />}
    </div>
  );
}
