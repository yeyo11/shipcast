import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useMemo, useRef } from 'react';
import type { EditorProfile } from '@shipcast/schema/channels';
import { extensionsFor, markdownManager, parseFor, serialize } from './extensions';
import { rangeOf, type Range } from './visual';

/*
 * The Visual mode: TipTap over the same Markdown string the Markdown mode edits. The string is the
 * model: the document is parsed from it, and only an edit made here writes it back, serialised, so
 * switching modes without typing never changes the stored text. See docs/decisions/rich-editor.md
 */

export interface VisualEditorProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  profile: EditorProfile;
  /** Where the selection sits in the Markdown string; empty when nothing is selected or it was not found */
  onSelect: (range: Range) => void;
  /** The editor, once it exists: the toolbar runs its commands through it */
  onReady?: (editor: Editor | null) => void;
  /** Files pasted or dropped into the text: images, when the profile takes them */
  onFiles?: (files: File[], at: number) => boolean;
  /** Where the page shows an image the Markdown links */
  imageSrc?: (src: string) => string;
  describedBy?: string;
  label: string;
  tall?: boolean;
  dimmed?: boolean;
}

export function VisualEditor({ id, value, onChange, profile, onSelect, onReady, onFiles, imageSrc, describedBy, label, tall, dimmed }: VisualEditorProps) {
  const manager = useMemo(() => markdownManager(profile), [profile]);
  // What this editor wrote last: a value that differs came from elsewhere (an accepted proposal, the Markdown mode)
  const written = useRef(value);
  const latest = useRef({ value, onChange, onSelect, onFiles });
  latest.current = { value, onChange, onSelect, onFiles };

  const shown = useRef(imageSrc);
  shown.current = imageSrc;
  const editor = useEditor({
    extensions: extensionsFor(profile, { imageSrc: (src) => shown.current?.(src) ?? src }),
    content: parseFor(manager, value, profile),
    // The server renders the page; the editor starts in the browser
    immediatelyRender: false,
    editorProps: {
      attributes: {
        id,
        class: `k-input ed-visual${tall ? ' ed-tall' : ''}`,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        ...(describedBy && { 'aria-describedby': describedBy }),
      },
      handlePaste: (view, event) => {
        const files = [...(event.clipboardData?.files ?? [])];
        return files.length > 0 && (latest.current.onFiles?.(files, view.state.selection.from) ?? false);
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length === 0) return false;
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        return latest.current.onFiles?.(files, at) ?? false;
      },
    },
    onUpdate: ({ editor: e }) => {
      const next = serialize(manager, e.getJSON(), latest.current.value);
      written.current = next;
      latest.current.onChange(next);
    },
    onSelectionUpdate: ({ editor: e }) => {
      const { from, to, empty } = e.state.selection;
      if (empty) {
        latest.current.onSelect({ start: 0, end: 0 });
        return;
      }
      const slice = e.state.doc.slice(from, to);
      const selected = { markdown: manager.serialize({ type: 'doc', content: slice.content.toJSON() ?? [] }), plain: e.state.doc.textBetween(from, to, '\n') };
      latest.current.onSelect(rangeOf(latest.current.value, selected, from / Math.max(1, e.state.doc.content.size)) ?? { start: 0, end: 0 });
    },
  });

  useEffect(() => {
    onReady?.(editor);
    return () => onReady?.(null);
  }, [editor]);

  // A text changed outside (Accept, the Markdown mode, a restored draft) is parsed in again
  useEffect(() => {
    if (!editor || value === written.current) return;
    written.current = value;
    editor.commands.setContent(parseFor(manager, value, profile), { emitUpdate: false });
  }, [editor, value, manager, profile]);

  return <EditorContent editor={editor} className={`ed-visual-box${dimmed ? ' ed-dimmed' : ''}`} />;
}
