import { Marked } from 'marked';
import { wordDiff } from '../assistant/diff.ts';

/*
 * What the Visual mode needs to keep the writing assistant on the Markdown string: where a selection
 * made in the formatted text sits in that string, and a proposal shown formatted, its deleted words
 * struck and its added ones marked. Pure but for the DOM walk, which the page does.
 * See docs/decisions/rich-editor.md
 */

export interface Range {
  start: number;
  end: number;
}

/**
 * Where a selection made in the Visual mode sits in the Markdown: its own Markdown (the selection
 * serialised) found in the whole text, the occurrence nearest where the selection is in the document
 * (`at`, 0 to 1); failing that, its plain words. Undefined when neither is found: the assistant then
 * works on the whole text, as with no selection.
 */
export function rangeOf(markdown: string, selected: { markdown: string; plain: string }, at: number): Range | undefined {
  for (const needle of [selected.markdown.trim(), selected.plain.trim()]) {
    if (!needle) continue;
    const found: number[] = [];
    for (let i = markdown.indexOf(needle); i >= 0; i = markdown.indexOf(needle, i + 1)) found.push(i);
    if (found.length === 0) continue;
    const expected = at * markdown.length;
    const start = found.reduce((best, i) => (Math.abs(i - expected) < Math.abs(best - expected) ? i : best), found[0]!);
    return { start, end: start + needle.length };
  }
  return undefined;
}

/** Private-use characters: never typed, so they mark the diff's runs through the Markdown renderer */
export const MARKS = { delOpen: '', delClose: '', insOpen: '', insClose: '' } as const;

/** The proposal's Markdown with its changes marked: deleted runs kept and wrapped, inserted ones wrapped */
export function markedDiff(before: string, after: string): string {
  return wordDiff(before, after)
    .map((p) => (p.type === 'equal' ? p.text : p.type === 'delete' ? wrapLines(p.text, MARKS.delOpen, MARKS.delClose) : wrapLines(p.text, MARKS.insOpen, MARKS.insClose)))
    .join('');
}

/**
 * Each line of a run wrapped on its own, the marks inside its block syntax: a run across a paragraph
 * break, or one that begins a heading or a list item, still renders as the heading or the item
 */
function wrapLines(text: string, open: string, close: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      const lead = /^(\s*(?:#{1,6} |> |[-*+] (?:\[[ xX]\] )?|\d+[.)] )?)/.exec(line)?.[1] ?? '';
      return `${lead}${open}${line.slice(lead.length)}${close}`;
    })
    .join('\n');
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const SAFE_URL = /^(https?:\/\/|mailto:|#|\/(?!\/))/i;

/**
 * Markdown as HTML for the formatted diff: GitHub-flavoured, raw HTML shown as text but for the
 * underline the profiles write, links and images only to web, mail, anchors or the site's own paths,
 * and a spoiler drawn as one. `imageSrc` says where the page shows an image the Markdown links (a
 * launch's files are served by the app, not at the site's paths); what it answers passes the same
 * check, an inline image allowed.
 */
export function renderMarkdown(markdown: string, options: { imageSrc?: (src: string) => string } = {}): string {
  const marked = new Marked({
    gfm: true,
    walkTokens: (token) => {
      if (token.type === 'image' && options.imageSrc) {
        const shown = options.imageSrc(token.href).trim();
        token.href = SAFE_URL.test(shown) || /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(shown) ? shown : '#';
      } else if ((token.type === 'link' || token.type === 'image') && !SAFE_URL.test(token.href.trim())) token.href = '#';
    },
    renderer: {
      html: (token) => (/^<\/?u>$/.test(token.text.trim()) ? token.text.trim() : esc(token.text)),
    },
  });
  const spoilered = markdown.replace(/\|\|(?=\S)([^|\n]*?\S)\|\|/g, '$1');
  return (marked.parse(spoilered, { async: false }) as string).replaceAll('', '<span class="ed-spoiler">').replaceAll('', '</span>');
}

export type Run = { text: string; change: 'equal' | 'delete' | 'insert' };

/**
 * One text node's runs, given the change open when it starts: the marks taken out, what they enclosed
 * told apart. Returns the change still open at its end, which the next text node starts in.
 */
export function splitRuns(text: string, open: Run['change']): { runs: Run[]; open: Run['change'] } {
  const runs: Run[] = [];
  let state = open;
  let current = '';
  const flush = () => {
    if (current) runs.push({ text: current, change: state });
    current = '';
  };
  for (const ch of text) {
    if (ch === MARKS.delOpen || ch === MARKS.insOpen) {
      flush();
      state = ch === MARKS.delOpen ? 'delete' : 'insert';
    } else if (ch === MARKS.delClose || ch === MARKS.insClose) {
      flush();
      state = 'equal';
    } else current += ch;
  }
  flush();
  return { runs, open: state };
}

/**
 * The formatted diff in a container: every text node split into its runs, a deleted run in `<del>`,
 * an inserted one in `<ins>`. Walking the text nodes keeps the HTML whole whatever the runs cross.
 */
export function paintDiff(root: HTMLElement): void {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let open: Run['change'] = 'equal';
  for (const node of nodes) {
    const split = splitRuns(node.data, open);
    open = split.open;
    if (split.runs.length === 1 && split.runs[0]!.change === 'equal' && split.runs[0]!.text === node.data) continue;
    const fragment = root.ownerDocument.createDocumentFragment();
    for (const run of split.runs) {
      if (run.change === 'equal') fragment.append(run.text);
      else {
        // As DiffView draws them: struck or marked, and said in words for a screen reader
        const el = root.ownerDocument.createElement(run.change === 'delete' ? 'del' : 'ins');
        el.className = run.change === 'delete' ? 'k-diff-del' : 'k-diff-add';
        const hidden = (words: string) => Object.assign(root.ownerDocument.createElement('span'), { className: 'visually-hidden', textContent: words });
        el.append(hidden(run.change === 'delete' ? ' [deleted: ' : ' [inserted: '), run.text, hidden('] '));
        fragment.append(el);
      }
    }
    node.replaceWith(fragment);
  }
}
