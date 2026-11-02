import { Menu } from '@base-ui/react/menu';
import type { Editor } from '@tiptap/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorProfile } from '@shipcast/schema/channels';
import { Icon, type IconName } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { toolsFor, type Tool, type ToolId } from './toolbar';
import { markedDiff, paintDiff, renderMarkdown } from './visual';

/*
 * The editor's bar (board EditorWrite): the band on top of the editor's frame, the profile's buttons
 * in their groups, then the Markdown | Visual switch at its end. The two heading levels share one
 * button with a menu, as the board draws it. A plain channel has no bar at all. See
 * docs/decisions/rich-editor.md
 */

export type EditorMode = 'markdown' | 'visual';

const MODES = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'visual', label: 'Visual' },
] as const;

/** The board's line icons, by button; the marks (B, I, U, S, ||) are letters */
const ICONS: Partial<Record<ToolId, IconName>> = {
  image: 'image',
  link: 'link',
  code: 'code',
  codeBlock: 'codeBlock',
  quote: 'quote',
  bulletList: 'listBullet',
  orderedList: 'listNumber',
  taskList: 'listTask',
  table: 'table',
};

export interface EditorToolbarProps {
  profile: EditorProfile;
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  onTool: (tool: Tool) => void;
  /** Whether each button's format is on at the selection, in the Visual mode */
  active?: ReadonlySet<ToolId>;
  /** The image button, when images can be added here */
  images?: boolean;
  controls: string;
}

export function EditorToolbar({ profile, mode, onMode, onTool, active, images, controls }: EditorToolbarProps) {
  const tools = toolsFor(profile).filter((t) => t.id !== 'image' || images);
  const headings = tools.filter((t) => t.id === 'heading2' || t.id === 'heading3');
  // Two levels fold into one button with a menu; a single one stays a plain button
  // Inline code and code blocks share the Code button, as the board draws it: see codeToolAt
  const oneCode = tools.some((t) => t.id === 'code') && tools.some((t) => t.id === 'codeBlock');
  const buttons = tools.filter((t) => !(headings.length > 1 && headings.includes(t)) && !(oneCode && t.id === 'codeBlock')).map((t) => (oneCode && t.id === 'code' ? { ...t, label: 'Code' } : t));
  const isOn = (id: ToolId) => Boolean(active?.has(id) || (oneCode && id === 'code' && active?.has('codeBlock')));
  const button = (tool: Tool) => (
    <button
      type="button"
      className={`ed-tool ed-tool-${tool.id}${isOn(tool.id) ? ' ed-on' : ''}`}
      aria-label={tool.label}
      title={tool.keys ? `${tool.label} (${tool.keys.replace('Control', 'Ctrl')})` : tool.label}
      aria-pressed={active ? isOn(tool.id) : undefined}
      {...(tool.keys && { 'aria-keyshortcuts': tool.keys })}
      // The text keeps its selection while a button is pressed
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onTool(tool)}
    >
      {ICONS[tool.id] ? <Icon name={ICONS[tool.id]!} size={20} /> : <span aria-hidden="true">{tool.glyph}</span>}
    </button>
  );
  const headingOn = headings.some((h) => active?.has(h.id));
  return (
    <div className="ed-bar" role="toolbar" aria-label="Formatting" aria-controls={controls}>
      <div className="ed-tools">
        {headings.length > 1 && (
          <Menu.Root>
            <Menu.Trigger
              render={
                <button type="button" className={`ed-tool ed-tool-heading${headingOn ? ' ed-on' : ''}`} aria-label="Heading" title="Heading" onMouseDown={(e) => e.preventDefault()}>
                  <span aria-hidden="true">H</span>
                  <Icon name="chevronDown" size={14} />
                </button>
              }
            />
            <Menu.Portal>
              <Menu.Positioner className="k-pop-positioner" sideOffset={6} align="start">
                <Menu.Popup className="k-menu k-pop-list ed-heading-menu">
                  {headings.map((h) => (
                    <Menu.Item key={h.id} className={`k-mi k-option ed-heading-${h.id}`} onClick={() => onTool(h)}>
                      {h.label}
                    </Menu.Item>
                  ))}
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        )}
        {buttons.map((tool, i) => (
          <span key={tool.id} className="ed-tool-slot">
            {(i > 0 ? buttons[i - 1]!.group !== tool.group : headings.length > 1 && tool.group !== 'text') && <span className="ed-bar-sep" aria-hidden="true" />}
            {button(tool)}
          </span>
        ))}
      </div>
      <ModeSwitch mode={mode} onMode={onMode} />
    </div>
  );
}

/** Markdown | Visual, the compact switch at the bar's end (board EditorWrite) */
function ModeSwitch({ mode, onMode }: { mode: EditorMode; onMode: (mode: EditorMode) => void }) {
  return (
    <div className="ed-mode" role="radiogroup" aria-label="Editing mode">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={m.value === mode}
          className={m.value === mode ? 'ed-mode-on' : undefined}
          tabIndex={m.value === mode ? 0 : -1}
          onClick={() => onMode(m.value)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const next = m.value === 'markdown' ? 'visual' : 'markdown';
            onMode(next);
            const group = e.currentTarget.parentElement;
            requestAnimationFrame(() => group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus());
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

/** The formats on at the Visual mode's selection, for the buttons' pressed state */
export function activeTools(editor: Editor | null): Set<ToolId> {
  const on = new Set<ToolId>();
  if (!editor) return on;
  for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'spoiler', 'link'] as const) if (editor.isActive(mark)) on.add(mark);
  if (editor.isActive('heading', { level: 2 })) on.add('heading2');
  if (editor.isActive('heading', { level: 3 })) on.add('heading3');
  const blocks = { blockquote: 'quote', bulletList: 'bulletList', orderedList: 'orderedList', taskList: 'taskList', codeBlock: 'codeBlock', table: 'table' } as const;
  for (const [node, tool] of Object.entries(blocks)) if (editor.isActive(node)) on.add(tool);
  return on;
}

/** The Code button in the Visual mode: a block inside one, across blocks or on an empty line; inline code otherwise */
export function visualCodeTool(editor: Editor): 'code' | 'codeBlock' {
  const { $from, $to } = editor.state.selection;
  return editor.isActive('codeBlock') || !$from.sameParent($to) || $from.parent.content.size === 0 ? 'codeBlock' : 'code';
}

/** A button's command in the Visual mode; `link` and `image` ask first, so they are the caller's */
export function runVisual(editor: Editor, tool: ToolId): void {
  const chain = editor.chain().focus();
  switch (tool) {
    case 'bold':
      chain.toggleBold().run();
      break;
    case 'italic':
      chain.toggleItalic().run();
      break;
    case 'strike':
      chain.toggleStrike().run();
      break;
    case 'code':
      chain.toggleCode().run();
      break;
    case 'underline':
    case 'spoiler':
      chain.toggleMark(tool).run();
      break;
    case 'heading2':
      chain.toggleHeading({ level: 2 }).run();
      break;
    case 'heading3':
      chain.toggleHeading({ level: 3 }).run();
      break;
    case 'quote':
      chain.toggleBlockquote().run();
      break;
    case 'bulletList':
      chain.toggleBulletList().run();
      break;
    case 'orderedList':
      chain.toggleOrderedList().run();
      break;
    case 'taskList':
      chain.toggleTaskList().run();
      break;
    case 'codeBlock':
      chain.toggleCodeBlock().run();
      break;
    case 'table':
      chain.insertTable({ rows: 2, cols: 2, withHeaderRow: true }).run();
      break;
    case 'link':
    case 'image':
      break;
  }
}

/** The link's address, asked in a 480 px dialog (a sheet on a phone) */
export function LinkDialog({ open, onOpenChange, initial, onSubmit }: { open: boolean; onOpenChange: (open: boolean) => void; initial: string; onSubmit: (url: string | null) => void }) {
  const [url, setUrl] = useState(initial);
  useEffect(() => {
    if (open) setUrl(initial);
  }, [open, initial]);
  const valid = /^(https?:\/\/\S+|mailto:\S+|\/\S*|#\S+)$/.test(url.trim());
  return (
    <Overlay kind="dialog" label="Link" heading="Link" open={open} onOpenChange={onOpenChange}>
      <form
        className="k-stack k-g12"
        onSubmit={(e) => {
          e.preventDefault();
          // The dialog is a portal, but React bubbles its submit up to the page's own form (Write's), which would start the work
          e.stopPropagation();
          if (!valid) return;
          onSubmit(url.trim());
          onOpenChange(false);
        }}
      >
        <div className="k-field">
          <label className="k-lbl" htmlFor="ed-link-url">
            Address
          </label>
          <input id="ed-link-url" className="k-input" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoFocus />
          <span className="k-help">A web address, a mail link or a path on the site (/en/…)</span>
        </div>
        <div className="k-hrow k-g8">
          {initial && (
            <button
              type="button"
              className="k-btn"
              onClick={() => {
                onSubmit(null);
                onOpenChange(false);
              }}
            >
              Remove the link
            </button>
          )}
          <button type="submit" className="k-btn k-pri k-grow" disabled={!valid}>
            {initial ? 'Change the link' : 'Add the link'}
          </button>
        </div>
      </form>
    </Overlay>
  );
}

/**
 * A proposal shown formatted (board EditorAssistVisual): the text as it reads, its deleted words
 * struck and its added ones marked, formatting kept. "Show as Markdown" is the caller's DiffView.
 */
export function FormattedDiff({ before, after, label, imageSrc }: { before: string; after: string; label: string; imageSrc?: (src: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(markedDiff(before, after), imageSrc ? { imageSrc } : {});
  useLayoutEffect(() => {
    if (ref.current) paintDiff(ref.current);
  }, [html]);
  return (
    <figure className="wr-diff ed-formatted-diff" aria-label={label}>
      <div ref={ref} className="wr-diff-text ed-prose" role="region" aria-label={label} tabIndex={0} dangerouslySetInnerHTML={{ __html: html }} />
    </figure>
  );
}
