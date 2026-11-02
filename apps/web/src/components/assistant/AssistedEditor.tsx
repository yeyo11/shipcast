import { Menu } from '@base-ui/react/menu';
import type { Editor } from '@tiptap/core';
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { stripFormat, type EditorProfile } from '@shipcast/schema/channels';
import { activeTools, EditorToolbar, FormattedDiff, LinkDialog, runVisual, visualCodeTool, type EditorMode } from '../editor/EditorToolbar';
import { imageFiles, type ImageSupport } from '../editor/images';
import { ImageDialog, MissingAlt } from '../editor/ImageParts';
import { applyTool, codeToolAt, insertImage, insertLink, type Edit, type Tool, type ToolId } from '../editor/toolbar';
import { VisualEditor } from '../editor/VisualEditor';
import { Icon } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { useToast } from '../Toasts';
import { usePhone } from '../kit/usePhone';
import { caretPoint } from './caret';
import { sentenceContext } from './diff';
import { DiffView } from './DiffView';
import { ADAPT_NETWORKS, type Action } from './protocol';
import type { Assistant } from './session';

/**
 * Where an image goes in the Visual mode: where it was put, or after the table it was put in. A
 * Markdown table's cell holds a line of text, so an image there would not survive the way back.
 */
function outsideTable(editor: Editor, pos: number): number {
  const $pos = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size));
  for (let depth = $pos.depth; depth > 0; depth--) if ($pos.node(depth).type.name === 'table') return $pos.after(depth);
  return pos;
}

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
function ProposalCard({ assistant, onAccept, formatted, imageSrc }: { assistant: Assistant; onAccept: () => void; formatted?: boolean; imageSrc?: (src: string) => string }) {
  const proposal = assistant.proposal;
  // In the Visual mode a proposal reads formatted; its Markdown is one press away
  const [asMarkdown, setAsMarkdown] = useState(false);
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
          {(hasText || !proposal.streaming) &&
            (formatted && !asMarkdown ? (
              <FormattedDiff before={proposal.original} after={proposal.text} label={`${proposal.label}: the change`} imageSrc={imageSrc} />
            ) : (
              <DiffView before={proposal.original} after={proposal.text} label={`${proposal.label}: the change`} context={context} legend className={proposal.range ? undefined : 'wr-diff-whole'} />
            ))}
          {formatted && (hasText || !proposal.streaming) && (
            <button type="button" className="wr-textbutton k-sm ed-diff-toggle" aria-pressed={asMarkdown} onClick={() => setAsMarkdown(!asMarkdown)}>
              {asMarkdown ? 'Show formatted' : 'Show as Markdown'}
            </button>
          )}
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
  /** The count, at the start of the frame's status band (Write's "412 words", board EditorWrite) */
  meta?: ReactNode;
  className?: string;
  /**
   * The formatting the text's channel shows: with it the editor has the Markdown | Visual switch and
   * the buttons the profile offers, and a paste keeps only what the profile shows. A plain profile has
   * no bar. Without it the editor is the plain textarea.
   */
  profile?: EditorProfile;
  /** Under the text: where it goes as written (Write's status line) */
  status?: ReactNode;
  /** Images by paste, drop and the bar's button, where the profile takes them */
  images?: ImageSupport;
  /**
   * Where the page shows an image the text links, for a text that takes no new image (a launch's
   * draft, whose images are its own files, served by the app). `images.display` wins over it.
   */
  imageSrc?: (src: string) => string;
}

/**
 * A textarea with the writing assistant: select a passage and a small button offers the quick
 * actions beside it (the toolbar's Assist offers the same, for the keyboard); on a phone they open as
 * a bottom sheet. The answer comes back above the text as a diff to accept or reject.
 */
export function AssistedEditor({ id, label, assistant, mono = false, tall, required, placeholder, help, onOpenChat, meta, className, profile, status, images: imageSupport, imageSrc }: AssistedEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const phone = usePhone();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [floating, setFloating] = useState<{ top: number; left: number } | null>(null);
  const { target, proposal } = assistant;
  // Markdown is the default; the choice is not kept between visits yet
  const [mode, setMode] = useState<EditorMode>('markdown');
  const [visual, setVisual] = useState<Editor | null>(null);
  const [active, setActive] = useState<Set<ToolId>>(new Set());
  const [linkOpen, setLinkOpen] = useState(false);
  const formatting = profile !== undefined && profile.format !== 'plain';
  const inVisual = formatting && mode === 'visual';
  const [imageOpen, setImageOpen] = useState(false);
  // Only where the channel shows images in the text
  const images = profile?.images ? imageSupport : undefined;
  // Where the page shows an image the text links: an upload from the app, or a launch's own file
  const shownImage = profile?.images ? (images?.display ?? imageSrc) : undefined;

  /**
   * Pasted or dropped images, uploaded at once and put where they landed with no alt text yet: the
   * field under the bar asks for it, and the text cannot be saved until it has it
   */
  const takeFiles = (files: File[], at: { markdown: number } | { visual: number }): boolean => {
    const taken = images ? imageFiles(files) : [];
    if (!images || taken.length === 0) return false;
    void (async () => {
      for (const file of taken) {
        const uploaded = await images.upload(file);
        if (!uploaded.ok) {
          toast.fail(`${file.name || 'The image'} was not taken: ${uploaded.problem}`);
          continue;
        }
        if ('visual' in at) {
          if (visual) visual.chain().focus().insertContentAt(outsideTable(visual, at.visual), { type: 'image', attrs: { src: uploaded.src, alt: '' } }).run();
        } else {
          const edit = insertImage(latestValue.current, { start: at.markdown, end: at.markdown }, { alt: '', src: uploaded.src });
          applyEdit(edit);
        }
      }
    })();
    return true;
  };
  const latestValue = useRef(target.value);
  latestValue.current = target.value;

  // The pressed state follows the Visual mode's selection
  useEffect(() => {
    if (!visual) return;
    const update = () => setActive(activeTools(visual));
    visual.on('transaction', update);
    return () => {
      visual.off('transaction', update);
    };
  }, [visual]);

  /** Applies an edit of the Markdown text and puts the selection where it says */
  const applyEdit = (edit: Edit) => {
    target.onChange(edit.text);
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(edit.selection.start, edit.selection.end);
      assistant.setSelection(edit.selection);
    });
  };

  const onTool = (tool: Tool) => {
    if (tool.id === 'link') {
      setLinkOpen(true);
      return;
    }
    if (tool.id === 'image') {
      setImageOpen(true);
      return;
    }
    // The one Code button (EditorToolbar) means a block or inline code by where it is pressed
    const oneCode = tool.id === 'code' && profile?.blocks.includes('codeBlock');
    if (inVisual) {
      if (visual) runVisual(visual, oneCode ? visualCodeTool(visual) : tool.id);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const range = { start: el.selectionStart, end: el.selectionEnd };
    applyEdit(applyTool(target.value, range, oneCode ? codeToolAt(target.value, range) : tool.id));
  };

  const onImage = (image: { src: string; alt: string }) => {
    if (inVisual && visual) {
      visual.chain().focus().insertContentAt(outsideTable(visual, visual.state.selection.to), { type: 'image', attrs: image }).run();
      return;
    }
    const el = ref.current;
    const at = el ? el.selectionEnd : target.value.length;
    applyEdit(insertImage(target.value, { start: at, end: at }, image));
  };

  const onLink = (url: string | null) => {
    if (inVisual && visual) {
      const chain = visual.chain().focus().extendMarkRange('link');
      if (url === null) chain.unsetLink().run();
      else if (visual.state.selection.empty && !visual.isActive('link')) chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run();
      else chain.setLink({ href: url }).run();
      return;
    }
    const el = ref.current;
    if (!el || url === null) return;
    applyEdit(insertLink(target.value, { start: el.selectionStart, end: el.selectionEnd }, url));
  };

  const readSelection = () => {
    const el = ref.current;
    if (!el) return;
    assistant.setSelection({ start: el.selectionStart, end: el.selectionEnd });
  };

  // The floating button follows the end of a selection made with the pointer or the keyboard
  useLayoutEffect(() => {
    if (inVisual) {
      const box = boxRef.current;
      if (!visual || !box || !assistant.selected || visual.state.selection.empty) {
        setFloating(null);
        return;
      }
      const at = visual.view.coordsAtPos(visual.state.selection.to);
      const frame = box.getBoundingClientRect();
      setFloating({ top: Math.min(at.bottom - frame.top + 6, frame.height - 8), left: Math.min(Math.max(at.left - frame.left - 20, 4), frame.width - 140) });
      return;
    }
    const el = ref.current;
    if (!el || !assistant.selected || document.activeElement !== el) {
      setFloating(null);
      return;
    }
    const point = caretPoint(el, assistant.selection.end);
    const top = Math.min(Math.max(point.top + point.height + 6, 4), el.clientHeight - 8);
    const left = Math.min(Math.max(point.left - 20, 4), el.clientWidth - 140);
    setFloating({ top, left });
  }, [assistant.selected, assistant.selection.end, inVisual, visual]);

  // The box grows with the text, as the boards draw it, so a long article scrolls with the page
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || inVisual) return;
    el.style.height = '';
    // Only past its minimum: below it the stylesheet's height holds, whatever the layout (a proposal shrinks it)
    if (el.scrollHeight > el.clientHeight) el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [target.value, proposal, inVisual]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hide = () => setFloating(null);
    el.addEventListener('scroll', hide);
    return () => el.removeEventListener('scroll', hide);
  }, [inVisual]);

  // Back to the text without moving the page, the caret after the change, nothing left selected
  const accept = () => {
    const accepted = proposal;
    if (!accepted || !assistant.acceptProposal()) {
      toast.fail('The text changed under the proposal: ask again on the text as it is now.');
      return;
    }
    if (inVisual) {
      visual?.commands.focus(undefined, { scrollIntoView: false });
      return;
    }
    const caret = accepted.range ? accepted.range.start + accepted.text.length : accepted.text.length;
    assistant.setSelection({ start: caret, end: caret });
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      el.setSelectionRange(caret, caret);
    });
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
      </div>
      {images && <MissingAlt value={target.value} onChange={target.onChange} images={images} />}
      <ProposalCard assistant={assistant} onAccept={accept} formatted={inVisual} imageSrc={shownImage} />
      {/* One frame (board EditorWrite): the bar on top, the text, the status band under it */}
      <div className={`ed-frame${profile ? '' : ' ed-frame-bare'}`}>
      {formatting && <EditorToolbar profile={profile} mode={mode} onMode={(m) => {
        setMode(m);
        setFloating(null);
        assistant.setSelection({ start: 0, end: 0 });
      }} onTool={onTool} active={inVisual ? active : undefined} images={Boolean(images)} controls={id} />}
      {profile && !formatting && (
        <div className="ed-bar ed-bar-plain">
          <span className="k-sm k-muted">Plain text</span>
        </div>
      )}
      <div
        className="wr-assisted-box"
        ref={boxRef}
        onKeyDown={(e) => {
          if (inVisual && e.altKey && e.key.toLowerCase() === 'j') {
            e.preventDefault();
            const float = document.getElementById(`${id}-float`);
            (float ?? document.getElementById(`${id}-assist`))?.click();
          }
        }}
      >
        {inVisual ? (
          <VisualEditor
            id={id}
            label={label}
            value={target.value}
            onChange={target.onChange}
            profile={profile}
            onSelect={assistant.setSelection}
            onReady={setVisual}
            {...(images && { onFiles: (files: File[], at: number) => takeFiles(files, { visual: at }) })}
            {...(shownImage && { imageSrc: shownImage })}
            describedBy={`${id}-help`}
            tall={tall}
            dimmed={Boolean(proposal)}
          />
        ) : (
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
          onDrop={(e) => {
            const files = [...e.dataTransfer.files];
            if (files.length > 0 && takeFiles(files, { markdown: e.currentTarget.selectionStart })) e.preventDefault();
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length > 0 && takeFiles(files, { markdown: e.currentTarget.selectionEnd })) {
              e.preventDefault();
              return;
            }
            // A paste keeps only the formatting the channel shows: a bold pasted into Bluesky arrives as its words
            if (!profile) return;
            const pasted = e.clipboardData.getData('text/plain');
            const cleaned = stripFormat(pasted, profile).text;
            if (!pasted || cleaned === pasted) return;
            e.preventDefault();
            const el = e.currentTarget;
            const at = el.selectionStart + cleaned.length;
            target.onChange(el.value.slice(0, el.selectionStart) + cleaned + el.value.slice(el.selectionEnd));
            requestAnimationFrame(() => {
              el.setSelectionRange(at, at);
              readSelection();
            });
          }}
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
        )}
        {floating && (
          <div className="wr-assist-float" style={{ top: floating.top, left: floating.left }}>
            {phone ? floatButton : <AssistMenu assistant={assistant} trigger={floatButton} onOpenChat={onOpenChat} />}
          </div>
        )}
      </div>
      {(meta || status || (profile && profile.format !== 'markdown')) && (
        <div className="ed-status">
          {meta && <span className="ed-status-count">{meta}</span>}
          <span className="k-grow" />
          <span className="ed-status-note">{status ?? (profile && profile.format !== 'markdown' ? profile.note : null)}</span>
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
      {images && <ImageDialog open={imageOpen} onOpenChange={setImageOpen} images={images} onInsert={onImage} />}
      {formatting && <LinkDialog open={linkOpen} onOpenChange={setLinkOpen} initial={inVisual && visual?.isActive('link') ? String(visual.getAttributes('link').href ?? '') : ''} onSubmit={onLink} />}
    </div>
  );
}
