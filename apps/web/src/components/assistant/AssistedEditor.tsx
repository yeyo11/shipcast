import { Menu } from '@base-ui/react/menu';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react';
import { useToast } from '../Toasts';
import { CaretIcon, SparkIcon } from '../ui/icons';
import { caretPoint } from './caret';
import { DiffView } from './DiffView';
import { ADAPT_NETWORKS, type Action } from './protocol';
import type { Assistant } from './session';

const VERDICTS: Record<string, string> = { backed: 'Backed by the code', planned: 'Planned, not built', 'not-found': 'Not found in the code', contradicted: 'The code says otherwise' };

/**
 * The quick actions, behind one trigger: the same menu from the toolbar and from the small button
 * that appears beside a selection. Arrow keys move, Enter acts, Escape closes.
 */
function AssistMenu({ assistant, trigger }: { assistant: Assistant; trigger: ReactElement }) {
  const lang = assistant.target.lang;
  const translate = lang === 'es' ? 'Translate to English' : lang === 'en' ? 'Translate to Spanish' : 'Translate EN ↔ ES';
  const item = (action: Action, label: string, disabled?: boolean) => (
    <Menu.Item className="ui-option" onClick={() => assistant.run(action)} disabled={disabled}>
      {label}
    </Menu.Item>
  );
  return (
    <Menu.Root>
      <Menu.Trigger render={trigger} />
      <Menu.Portal>
        <Menu.Positioner className="ui-positioner" sideOffset={6} align="start">
          <Menu.Popup className="ui-popup ui-menu">
            <div className="ui-menu-note">{assistant.selected ? 'With the selection' : 'With the whole text (select a passage to work on it alone)'}</div>
            {item('improve', 'Improve')}
            {item('shorten', 'Shorten')}
            {item('translate', translate)}
            {item('titles', 'Propose titles')}
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className="ui-option ui-submenu-trigger">
                Adapt to a network <CaretIcon size={16} className="ui-submenu-caret" />
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner className="ui-positioner" sideOffset={4} alignOffset={-6}>
                  <Menu.Popup className="ui-popup ui-menu">
                    {ADAPT_NETWORKS.map((n) => (
                      <Menu.Item key={n.id} className="ui-option" onClick={() => assistant.run('adapt', n)}>
                        {n.name}
                      </Menu.Item>
                    ))}
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            <Menu.Separator className="ui-separator" />
            {item('check', 'Check against the repo’s code', Boolean(assistant.target.checkDisabled))}
            {assistant.target.checkDisabled && <div className="ui-menu-note">{assistant.target.checkDisabled}</div>}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
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
  help?: string;
}

/**
 * A textarea with the writing assistant: select a passage and a small button offers the quick
 * actions beside it (the toolbar's Assist offers the same, for the keyboard); the answer comes back
 * under the text as a diff to accept or reject.
 */
export function AssistedEditor({ id, label, assistant, mono = true, tall, required, placeholder, help }: AssistedEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
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

  return (
    <div className="field assisted">
      <div className="assisted-bar">
        <label htmlFor={id}>{label}</label>
        <AssistMenu
          assistant={assistant}
          trigger={
            <button type="button" id={`${id}-assist`} className="btn btn-small assist-trigger" aria-keyshortcuts="Alt+J">
              <SparkIcon size={16} /> Assist <CaretIcon size={14} />
            </button>
          }
        />
      </div>
      <div className="assisted-box">
        <textarea
          id={id}
          ref={ref}
          className={`textarea${mono ? ' mono' : ''}${tall ? ' tall' : ''}`}
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
            if (!(e.relatedTarget instanceof HTMLElement && e.relatedTarget.closest('.assist-float'))) setFloating(null);
          }}
          onKeyDown={(e) => {
            if (e.altKey && e.key.toLowerCase() === 'j') {
              e.preventDefault();
              const float = document.getElementById(`${id}-float`);
              (float ?? document.getElementById(`${id}-assist`))?.click();
            }
          }}
          aria-describedby={help ? `${id}-help` : undefined}
        />
        {floating && (
          <div className="assist-float" style={{ top: floating.top, left: floating.left }}>
            <AssistMenu
              assistant={assistant}
              trigger={
                <button type="button" id={`${id}-float`} className="assist-float-button" aria-label="Assist with the selection">
                  <SparkIcon size={16} /> <span>Assist</span>
                </button>
              }
            />
          </div>
        )}
      </div>
      {help && (
        <small id={`${id}-help`}>
          {help} Select a passage for the assistant, or press Alt+J.
        </small>
      )}
      <div className="visually-hidden" role="status" aria-live="polite">
        {assistant.announce}
      </div>
      {proposal && (
        <section className="proposal" aria-label={`Proposal: ${proposal.label}`}>
          <header className="proposal-head">
            <strong>{proposal.label}</strong>
            <span className="muted">{proposal.range ? 'on the selection' : 'on the whole text'}</span>
            {proposal.streaming && (
              <span className="proposal-wait" role="status">
                {proposal.whole ? 'Writing… the answer arrives all at once' : 'Writing…'}
              </span>
            )}
          </header>
          {proposal.problem ? (
            <p className="problem" role="alert">
              {proposal.problem}
            </p>
          ) : proposal.titles && !proposal.text ? (
            <div className="proposal-titles">
              <p className="muted">Pick one to see it against the text:</p>
              <ul>
                {proposal.titles.map((t) => (
                  <li key={t}>
                    <button type="button" className="btn btn-small" onClick={() => assistant.chooseTitle(t)}>
                      {t}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              {proposal.findings && proposal.findings.length > 0 && (
                <ul className="findings">
                  {proposal.findings.map((f, i) => (
                    <li key={i} data-verdict={f.verdict}>
                      <strong>{VERDICTS[f.verdict] ?? f.verdict}:</strong> {f.claim} <span className="muted">· {f.evidence}</span>
                    </li>
                  ))}
                </ul>
              )}
              {(proposal.text || !proposal.streaming) && <DiffView before={proposal.original} after={proposal.text} label={`${proposal.label}: the change`} />}
            </>
          )}
          <div className="row">
            <button type="button" className="btn btn-primary btn-small" onClick={accept} disabled={proposal.streaming || !proposal.text || Boolean(proposal.problem)}>
              Accept
            </button>
            <button type="button" className="btn btn-small" onClick={assistant.rejectProposal}>
              {proposal.streaming ? 'Stop' : 'Reject'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
