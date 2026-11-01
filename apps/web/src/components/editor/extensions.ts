import { Mark, mergeAttributes, type AnyExtension } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import type { JSONContent } from '@tiptap/core';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { stripFormat, type EditorProfile } from '@shipcast/schema/channels';

/*
 * The Visual mode's schema, from a channel's formatting profile: only the marks and blocks the
 * network shows exist in the editor, so a paste or a shortcut cannot make what the toolbar does not
 * offer. Markdown stays the stored format: @tiptap/markdown parses the string into the document and
 * serialises it back. See docs/decisions/rich-editor.md
 */

/**
 * A mark written between two delimiters in Markdown and as a tag on the page: underline as
 * `<u>…</u>` (Markdown has none, and the networks that show it read the tag), a spoiler as `||…||`,
 * as Discord and Telegram write it
 */
function delimitedMark(name: string, open: string, close: string, html: { tag: string; attrs?: Record<string, string> }, shortcut?: string) {
  const at = new RegExp(`^${open.replace(/[|]/g, '\\$&')}(?=\\S)([\\s\\S]*?\\S)${close.replace(/[|/]/g, '\\$&')}`);
  return Mark.create({
    name,
    parseHTML: () => [{ tag: html.attrs ? `${html.tag}[${Object.keys(html.attrs)[0]}]` : html.tag }],
    renderHTML: ({ HTMLAttributes }) => [html.tag, mergeAttributes(HTMLAttributes, html.attrs ?? {}), 0],
    addKeyboardShortcuts() {
      return shortcut ? { [shortcut]: () => this.editor.commands.toggleMark(this.name) } : {};
    },
    markdownTokenizer: {
      name,
      level: 'inline',
      start: (src) => src.indexOf(open),
      tokenize: (src, _tokens, lexer) => {
        const match = at.exec(src);
        return match ? { type: name, raw: match[0], text: match[1]!, tokens: lexer.inlineTokens(match[1]!) } : undefined;
      },
    },
    parseMarkdown: (token, helpers) => helpers.applyMark(name, helpers.parseInline(token.tokens ?? [])),
    renderMarkdown: (node, helpers) => `${open}${helpers.renderChildren(node)}${close}`,
  });
}

const Underline = delimitedMark('underline', '<u>', '</u>', { tag: 'u' }, 'Mod-u');
const Spoiler = delimitedMark('spoiler', '||', '||', { tag: 'span', attrs: { 'data-spoiler': '', class: 'ed-spoiler' } });

interface CellJson {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
}

/**
 * A table as the articles write it: `| a | b |` and `| --- |`, no padding to the widest cell, no
 * blank lines added around it. TipTap's own pads every column, so one edit rewrote every row.
 */
const CompactTable = Table.extend({
  renderMarkdown: (node: JSONContent, h: { renderChildren(nodes: JSONContent[]): string }) => {
    const rows = (node.content ?? []).map((row) =>
      ((row.content ?? []) as CellJson[]).map((cell) => ({
        text: (cell.content ?? [])
          .map((child) => (child.type === 'paragraph' ? h.renderChildren(child.content ?? []) : h.renderChildren([child]).trim()))
          .join('<br>')
          .replace(/\s*\n\s*/g, '<br>')
          .replace(/\\.|\|/g, (m) => (m === '|' ? '\\|' : m))
          .trim(),
        header: cell.type === 'tableHeader',
        align: typeof cell.attrs?.align === 'string' ? cell.attrs.align : typeof cell.attrs?.textAlign === 'string' ? cell.attrs.textAlign : null,
      })),
    );
    const columns = Math.max(0, ...rows.map((r) => r.length));
    if (columns === 0) return '';
    const line = (cells: string[]) => `| ${cells.map((c) => c).join(' | ')} |`.replace(/\|  \|/g, '| |').replace(/^\|  /, '| ');
    const head = rows[0]!;
    const header = Array.from({ length: columns }, (_, i) => (head.some((c) => c.header) ? (head[i]?.text ?? '') : ''));
    const aligns = Array.from({ length: columns }, (_, i) => rows.find((r) => r[i]?.align)?.[i]?.align ?? null);
    const delimiter = aligns.map((a) => (a === 'left' ? ':---' : a === 'right' ? '---:' : a === 'center' ? ':---:' : '---'));
    const body = rows.slice(head.some((c) => c.header) ? 1 : 0).map((r) => Array.from({ length: columns }, (_, i) => r[i]?.text ?? ''));
    return [line(header), line(delimiter), ...body.map(line)].join('\n');
  },
} as never);

const has = <T extends string>(list: readonly string[], item: T) => list.includes(item);

/**
 * The editor's extensions for a profile. A plain profile keeps paragraphs and line breaks only; a
 * mark or block the profile lacks is not in the schema at all.
 */
export function extensionsFor(profile: EditorProfile, options: { imageSrc?: (src: string) => string } = {}): AnyExtension[] {
  const { marks, blocks } = profile;
  const levels = ([1, 2, 3, 4, 5, 6] as const).filter((l) => l <= (has(blocks, 'heading') ? (profile.maxHeading ?? 6) : 0));
  const extensions: AnyExtension[] = [
    StarterKit.configure({
      bold: has(marks, 'bold') ? {} : false,
      italic: has(marks, 'italic') ? {} : false,
      strike: has(marks, 'strike') ? {} : false,
      code: has(marks, 'code') ? {} : false,
      link: has(marks, 'link') ? { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null } } : false,
      // Underline is our own mark: StarterKit's writes `++…++`, which no network reads
      underline: false,
      heading: levels.length > 0 ? { levels: [...levels] } : false,
      blockquote: has(blocks, 'quote') ? {} : false,
      bulletList: has(blocks, 'bulletList') ? {} : false,
      orderedList: has(blocks, 'orderedList') ? {} : false,
      listItem: has(blocks, 'bulletList') || has(blocks, 'orderedList') ? {} : false,
      listKeymap: has(blocks, 'bulletList') || has(blocks, 'orderedList') ? {} : false,
      codeBlock: has(blocks, 'codeBlock') ? {} : false,
      // A rule reads as `---` everywhere, and the articles use it
      horizontalRule: profile.format === 'markdown' ? {} : false,
    }),
  ];
  if (has(marks, 'underline')) extensions.push(Underline);
  if (has(marks, 'spoiler')) extensions.push(Spoiler);
  if (has(blocks, 'taskList')) extensions.push(TaskList, TaskItem.configure({ nested: true }));
  if (has(blocks, 'table')) extensions.push(CompactTable.configure({ resizable: false }), TableRow, TableHeader, TableCell);
  if (profile.images) {
    const shown = options.imageSrc;
    // The document keeps the address the Markdown links; the page shows an upload the site does not have yet from the app
    const ShownImage = shown
      ? Image.extend({ renderHTML: ({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) => ['img', mergeAttributes(HTMLAttributes, { src: shown(String(HTMLAttributes.src ?? '')) })] } as never)
      : Image;
    extensions.push(ShownImage.configure({ inline: false, allowBase64: false }));
  }
  return extensions;
}

/**
 * A text node's characters escaped only where they would read as syntax again. TipTap escapes every
 * `_`, `~` and `*` and writes `&` as `&amp;`, which rewrote `x86_64`, `~40%` and `Q&A` on every edit
 * (and a plain network would show the entity as typed).
 */
export function escapeText(text: string): string {
  return text
    .replace(/[\\`[\]]/g, '\\$&')
    // A `*` between spaces opens nothing (5 * 3); anywhere else it could
    .replace(/\*/g, (m, at: number, s: string) => (/\s/.test(s[at - 1] ?? '') && /\s/.test(s[at + 1] ?? '') ? m : '\\*'))
    .replace(/_/g, (m, at: number, s: string) => (/[^\W_]/.test(s[at - 1] ?? '') && /[^\W_]/.test(s[at + 1] ?? '') ? m : '\\_'))
    .replace(/~/g, (m, at: number, s: string) => (s.indexOf('~', at + 1) > at || (s[at - 1] === '~') ? '\\~' : m))
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?\w+;)/g, '\\&');
}

interface Manager {
  codeTypes: Set<string>;
  encodeTextForMarkdown(text: string, node: JSONContent, parent?: JSONContent): string;
}

/** Markdown in and out of the Visual mode's document: the editor, a mode switch and the tests use this one */
export function markdownManager(profile: EditorProfile): MarkdownManager {
  const manager = new MarkdownManager({ extensions: extensionsFor(profile), indentation: { style: 'space', size: 2 } });
  const inner = manager as unknown as Manager;
  inner.encodeTextForMarkdown = (text, node, parent) => {
    const code = (parent?.type !== undefined && inner.codeTypes.has(parent.type)) || (node.marks ?? []).some((m) => inner.codeTypes.has(typeof m === 'string' ? m : m.type));
    return code ? text : escapeText(text);
  };
  return manager;
}

/** The document's Markdown, ending as the text it came from did: with its last line break or without */
export function serialize(manager: MarkdownManager, doc: JSONContent, like: string): string {
  const out = manager.serialize(doc).replace(/\n+$/, '');
  return like.endsWith('\n') ? `${out}\n` : out;
}

/**
 * The Visual mode's document from the Markdown. Syntax the profile does not show has no node to
 * become, and the parser would drop it with its words: it is taken out first, keeping the words, as
 * the paste and the assistant's proposals are
 */
export function parseFor(manager: MarkdownManager, markdown: string, profile: EditorProfile): JSONContent {
  return manager.parse(stripFormat(markdown, profile).text);
}

/** A text as the Visual mode would write it back: what a round trip through the editor gives */
export function roundTrip(markdown: string, profile: EditorProfile): string {
  const manager = markdownManager(profile);
  return serialize(manager, parseFor(manager, markdown, profile), markdown);
}
