import { CHANNEL_DEFINITIONS, maxHeading, type Block, type EditorProfile, type Mark } from '@shipcast/schema/channels';

/*
 * The editor's toolbar, from a channel's formatting profile, and what each button does to the
 * Markdown text in the Markdown mode: pure, so it is tested without a browser. The Visual mode runs
 * the same buttons as TipTap commands. See docs/decisions/rich-editor.md
 */

export type ToolId = Mark | Exclude<Block, 'heading'> | 'heading2' | 'heading3' | 'image';

export interface Tool {
  id: ToolId;
  label: string;
  /** The design system's glyph, or a letter drawn in the button */
  glyph: string;
  /** The keyboard shortcut, as aria-keyshortcuts writes it */
  keys?: string;
  /** The bar's groups, split by a rule (board EditorWrite): text, code, blocks, insert */
  group: 'text' | 'code' | 'blocks' | 'insert';
}

const MARK_TOOLS: Readonly<Record<Mark, Omit<Tool, 'id' | 'group'>>> = {
  bold: { label: 'Bold', glyph: 'B', keys: 'Control+B' },
  italic: { label: 'Italic', glyph: 'I', keys: 'Control+I' },
  underline: { label: 'Underline', glyph: 'U', keys: 'Control+U' },
  strike: { label: 'Strikethrough', glyph: 'S' },
  code: { label: 'Inline code', glyph: '</>', keys: 'Control+E' },
  link: { label: 'Link', glyph: 'link', keys: 'Control+K' },
  spoiler: { label: 'Spoiler', glyph: '||' },
};

const BLOCK_TOOLS: Readonly<Record<Exclude<Block, 'heading'>, Omit<Tool, 'id' | 'group'>>> = {
  quote: { label: 'Quote', glyph: '❝' },
  bulletList: { label: 'Bulleted list', glyph: '•' },
  orderedList: { label: 'Numbered list', glyph: '1.' },
  taskList: { label: 'Task list', glyph: '☐' },
  codeBlock: { label: 'Code block', glyph: '{}' },
  table: { label: 'Table', glyph: '▦' },
};

/** The buttons a profile offers, in the board's order (EditorWrite); none for a plain one */
export function toolsFor(profile: EditorProfile): Tool[] {
  const tools: Tool[] = [];
  const deepest = maxHeading(profile);
  if (deepest >= 2) tools.push({ id: 'heading2', label: 'Heading', glyph: 'H2', group: 'text' });
  if (deepest >= 3) tools.push({ id: 'heading3', label: 'Subheading', glyph: 'H3', group: 'text' });
  for (const mark of ['bold', 'italic', 'underline', 'strike', 'spoiler'] as const) {
    if (profile.marks.includes(mark)) tools.push({ id: mark, group: 'text', ...MARK_TOOLS[mark] });
  }
  for (const mark of ['link', 'code'] as const) {
    if (profile.marks.includes(mark)) tools.push({ id: mark, group: 'code', ...MARK_TOOLS[mark] });
  }
  if (profile.blocks.includes('codeBlock')) tools.push({ id: 'codeBlock', group: 'code', ...BLOCK_TOOLS.codeBlock });
  for (const block of ['quote', 'bulletList', 'orderedList', 'taskList'] as const) {
    if (profile.blocks.includes(block)) tools.push({ id: block, group: 'blocks', ...BLOCK_TOOLS[block] });
  }
  if (profile.blocks.includes('table')) tools.push({ id: 'table', group: 'insert', ...BLOCK_TOOLS.table });
  if (profile.images) tools.push({ id: 'image', label: 'Image', glyph: 'image', group: 'insert' });
  return tools;
}

export interface Range {
  start: number;
  end: number;
}

/** A change to the text: the new text and where the selection goes */
export interface Edit {
  text: string;
  selection: Range;
}

const WRAP: Partial<Record<ToolId, [string, string]>> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
  code: ['`', '`'],
  spoiler: ['||', '||'],
};

const PREFIX: Partial<Record<ToolId, (n: number) => string>> = {
  heading2: () => '## ',
  heading3: () => '### ',
  quote: () => '> ',
  bulletList: () => '- ',
  orderedList: (n) => `${n + 1}. `,
  taskList: () => '- [ ] ',
};

/** A heading, quote or list marker already at a line's start, which a new one replaces */
const LINE_MARKER = /^(?:#{1,6} |> |- \[[ xX]\] |[-*+] |\d+[.)] )/;

/** The whole lines a range touches */
function lineSpan(text: string, range: Range): Range {
  const start = text.lastIndexOf('\n', range.start - 1) + 1;
  const after = text.indexOf('\n', range.end > range.start ? range.end - 1 : range.end);
  return { start, end: after < 0 ? text.length : after };
}

/**
 * What a button does to the Markdown text and its selection: a mark wraps the selection (or takes
 * the wrap off when it is there already), a block marks each line it touches (a second press takes it
 * off), a code block fences the lines, a table inserts a two-column one. `link` and `image` ask for
 * their address first: see `insertLink` and `insertImage`.
 */
export function applyTool(text: string, range: Range, tool: ToolId): Edit {
  const wrap = WRAP[tool];
  if (wrap) {
    const [open, close] = wrap;
    const selected = text.slice(range.start, range.end);
    // Already wrapped, outside or inside the selection: unwrap
    if (text.slice(range.start - open.length, range.start) === open && text.slice(range.end, range.end + close.length) === close) {
      return {
        text: text.slice(0, range.start - open.length) + selected + text.slice(range.end + close.length),
        selection: { start: range.start - open.length, end: range.end - open.length },
      };
    }
    if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
      const inner = selected.slice(open.length, selected.length - close.length);
      return { text: text.slice(0, range.start) + inner + text.slice(range.end), selection: { start: range.start, end: range.start + inner.length } };
    }
    return {
      text: text.slice(0, range.start) + open + selected + close + text.slice(range.end),
      selection: { start: range.start + open.length, end: range.end + open.length },
    };
  }
  const prefix = PREFIX[tool];
  if (prefix) {
    const span = lineSpan(text, range);
    const lines = text.slice(span.start, span.end).split('\n');
    const marker = (i: number) => prefix(i);
    const all = lines.every((l, i) => l.startsWith(marker(i)) || (tool === 'orderedList' && /^\d+[.)] /.test(l)));
    const next = lines.map((l, i) => (all ? l.replace(LINE_MARKER, '') : `${marker(i)}${l.replace(LINE_MARKER, '')}`)).join('\n');
    return { text: text.slice(0, span.start) + next + text.slice(span.end), selection: { start: span.start, end: span.start + next.length } };
  }
  if (tool === 'codeBlock') {
    const span = lineSpan(text, range);
    const body = text.slice(span.start, span.end);
    const fenced = `\`\`\`\n${body}\n\`\`\``;
    return { text: text.slice(0, span.start) + fenced + text.slice(span.end), selection: { start: span.start + 4, end: span.start + 4 + body.length } };
  }
  if (tool === 'table') {
    const table = '| Column | Column |\n| --- | --- |\n|  |  |';
    // After the selection, never over it
    return insertBlock(text, { start: range.end, end: range.end }, table, 2, 8);
  }
  return { text, selection: range };
}

/**
 * The one Code button the board draws, when a profile has both inline code and code blocks: a block
 * over a selection that spans lines or on an empty line, inline code otherwise
 */
export function codeToolAt(text: string, range: Range): 'code' | 'codeBlock' {
  if (text.slice(range.start, range.end).includes('\n')) return 'codeBlock';
  const span = lineSpan(text, range);
  return text.slice(span.start, span.end).trim() === '' ? 'codeBlock' : 'code';
}

/** A block on lines of its own at the caret, a blank line around it, the selection inside it */
function insertBlock(text: string, range: Range, block: string, selectFrom: number, selectTo: number): Edit {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const tail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const at = before.length + lead.length;
  return { text: before + lead + block + tail + after, selection: { start: at + selectFrom, end: at + selectTo } };
}

/** A link around the selection, or the address itself when nothing is selected */
export function insertLink(text: string, range: Range, url: string): Edit {
  const label = text.slice(range.start, range.end) || url;
  const link = `[${label}](${url})`;
  return { text: text.slice(0, range.start) + link + text.slice(range.end), selection: { start: range.start + 1, end: range.start + 1 + label.length } };
}

/** An image on a line of its own at the caret: `![alt](src)` */
export function insertImage(text: string, range: Range, image: { alt: string; src: string }): Edit {
  const markdown = `![${image.alt.replace(/[[\]]/g, '')}](${image.src})`;
  return insertBlock(text, { start: range.end, end: range.end }, markdown, markdown.length, markdown.length);
}

/**
 * Where the article goes as written, from the channel definitions: the blog, and every channel whose
 * piece carries the article itself (an edit there replaces its body). Write's status line.
 */
export function articleDestinations(): string {
  const names = CHANNEL_DEFINITIONS.filter((d) => 'article' in d.edit && d.edit.article).map((d) => d.name);
  const listed = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? 'The blog');
  return `Goes as written to ${listed}; the other channels are written from it`;
}
