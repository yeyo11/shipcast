import type { Editor } from '@tiptap/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorProfile } from '@shipcast/schema/channels';
import { Icon, type IconName } from '../kit/Icon';
import { Overlay } from '../kit/Overlay';
import { Seg } from '../write/Form';
import { toolsFor, type Tool, type ToolId } from './toolbar';
import { markedDiff, paintDiff, renderMarkdown } from './visual';

/*
 * The editor's bar (board EditorWrite): the Markdown | Visual switch, then only the buttons the
 * channel's profile offers. A plain channel has no bar at all. See docs/decisions/rich-editor.md
 */

export type EditorMode = 'markdown' | 'visual';

const MODES = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'visual', label: 'Visual' },
] as const;

const ICONS: Partial<Record<string, IconName>> = { image: 'image', link: 'link' };

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
  return (
    <div className="k-hrow k-g8 ed-bar" role="toolbar" aria-label="Formatting" aria-controls={controls}>
      <Seg label="Editing mode" options={MODES} value={mode} onChange={onMode} tone="text" />
      <span className="ed-bar-sep" aria-hidden="true" />
      <div className="k-hrow ed-tools">
        {tools.map((tool, i) => (
          <span key={tool.id} className="k-hrow">
            {i > 0 && tools[i - 1]!.group !== tool.group && <span className="ed-bar-sep" aria-hidden="true" />}
            <button
              type="button"
              className={`ed-tool ed-tool-${tool.id}${active?.has(tool.id) ? ' ed-on' : ''}`}
              aria-label={tool.label}
              title={tool.keys ? `${tool.label} (${tool.keys.replace('Control', 'Ctrl')})` : tool.label}
              aria-pressed={active ? active.has(tool.id) : undefined}
              {...(tool.keys && { 'aria-keyshortcuts': tool.keys })}
              // The text keeps its selection while a button is pressed
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onTool(tool)}
            >
              {ICONS[tool.glyph] ? <Icon name={ICONS[tool.glyph]!} size={18} /> : <span aria-hidden="true">{tool.glyph}</span>}
            </button>
          </span>
        ))}
      </div>
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
export function FormattedDiff({ before, after, label }: { before: string; after: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(markedDiff(before, after));
  useLayoutEffect(() => {
    if (ref.current) paintDiff(ref.current);
  }, [html]);
  return (
    <figure className="wr-diff ed-formatted-diff" aria-label={label}>
      <div ref={ref} className="wr-diff-text ed-prose" role="region" aria-label={label} tabIndex={0} dangerouslySetInnerHTML={{ __html: html }} />
    </figure>
  );
}
