/*
 * What formatting a channel shows, and the checks that read it: pure and import-free, so the browser's
 * editor (its toolbar and its paste filter), the writing assistant's instructions, the check of its
 * proposals and the check of a saved draft all read the one profile on the channel's definition.
 * Markdown is the stored format everywhere; a profile only says which of its syntax the network
 * renders rather than showing it as typed. See docs/decisions/rich-editor.md
 */

/** Inline formatting. Underline is `<u>…</u>` and a spoiler `||…||`, Markdown having neither */
export const MARKS = ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'spoiler'] as const;
export type Mark = (typeof MARKS)[number];

/** Block formatting; a heading's deepest level is the profile's `maxHeading` */
export const BLOCKS = ['heading', 'quote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'table'] as const;
export type Block = (typeof BLOCKS)[number];

/** Anything a check can find: a mark, a block, or an image */
export type Syntax = Mark | Block | 'image';

export interface EditorProfile {
  /**
   * `markdown`: the network renders Markdown (the article's GFM, or most of it); `light`: a handful of
   * marks and blocks; `plain`: none, every `*`, `#` or `[` shows as typed
   */
  format: 'markdown' | 'light' | 'plain';
  marks: readonly Mark[];
  blocks: readonly Block[];
  /** The deepest heading it shows, where `blocks` has `heading`: 6 unless said */
  maxHeading?: number;
  /** Whether an image goes in the text itself */
  images: boolean;
  /** What it shows, in words the app puts beside the editor */
  note: string;
}

/** What a channel shows when it renders an article: GitHub-flavoured Markdown with images */
export const FULL_MARKDOWN: Omit<EditorProfile, 'note'> = {
  format: 'markdown',
  marks: ['bold', 'italic', 'strike', 'code', 'link'],
  blocks: ['heading', 'quote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'table'],
  images: true,
};

/** What a network that shows no formatting at all takes */
export const PLAIN_TEXT = (network: string): EditorProfile => ({
  format: 'plain',
  marks: [],
  blocks: [],
  images: false,
  note: `Plain text: ${network} shows no formatting, so a * or a # appears as typed`,
});

/** A syntax's name in a sentence, for the refusals and the assistant's notice */
export const SYNTAX_NAMES: Readonly<Record<Syntax, string>> = {
  bold: 'bold',
  italic: 'italics',
  underline: 'underline',
  strike: 'strikethrough',
  code: 'inline code',
  link: 'Markdown links',
  spoiler: 'spoilers',
  heading: 'headings',
  quote: 'quotes',
  bulletList: 'bulleted lists',
  orderedList: 'numbered lists',
  taskList: 'task lists',
  codeBlock: 'code blocks',
  table: 'tables',
  image: 'images',
};

/** How each is written, for the assistant's instruction */
const SYNTAX_SPELLING: Readonly<Record<Syntax, string>> = {
  bold: '**bold**',
  italic: '_italics_',
  underline: '<u>underline</u>',
  strike: '~~strikethrough~~',
  code: '`inline code`',
  link: '[text](url)',
  spoiler: '||spoiler||',
  heading: '## headings',
  quote: '> quotes',
  bulletList: '- lists',
  orderedList: '1. numbered lists',
  taskList: '- [ ] task lists',
  codeBlock: '``` code blocks',
  table: 'tables',
  image: '![alt](url) images',
};

/**
 * Lists read the same as typed on any network ("- one" is a line with a dash), so a check never
 * refuses them: they are only a toolbar's choice
 */
const READS_AS_TYPED: ReadonlySet<Syntax> = new Set(['bulletList', 'orderedList']);

const allows = (profile: EditorProfile, syntax: Syntax): boolean =>
  READS_AS_TYPED.has(syntax) || (syntax === 'image' ? profile.images : (profile.marks as readonly string[]).includes(syntax) || (profile.blocks as readonly string[]).includes(syntax));

/** The deepest heading a profile shows; 0 when it shows none */
export const maxHeading = (profile: EditorProfile): number => (profile.blocks.includes('heading') ? (profile.maxHeading ?? 6) : 0);

/** The instruction the writing assistant is given for a text bound for a channel with this profile */
export function formatInstruction(profile: EditorProfile, network: string): string {
  if (profile.format === 'plain') {
    return `Formatting: plain text only, no Markdown at all. ${network} shows every *, _, #, >, backtick and [ ] as typed: give emphasis with words, write a link as its bare URL, and never use headings, bold, italics, code or tables.`;
  }
  const shown: Syntax[] = [...profile.marks, ...profile.blocks, ...(profile.images ? (['image'] as const) : [])];
  const missing = [...MARKS, ...BLOCKS, 'image' as const].filter((s) => !shown.includes(s) && !READS_AS_TYPED.has(s));
  const headings = maxHeading(profile);
  const list = shown.map((s) => (s === 'heading' && headings < 6 ? `headings down to level ${headings} (${'#'.repeat(headings)})` : SYNTAX_SPELLING[s])).join(', ');
  return [
    `Formatting: ${network} shows ${profile.format === 'light' ? 'only this Markdown' : 'this Markdown'}: ${list}.`,
    missing.length > 0 ? `Never use ${missing.map((s) => SYNTAX_NAMES[s]).join(', ')}: ${network} would show them as typed or drop them.` : '',
    'Keep the formatting the text already has where it is allowed.',
  ]
    .filter(Boolean)
    .join(' ');
}

/** One piece of syntax a profile does not show, with where it was seen */
export interface FormatProblem {
  syntax: Syntax;
  /** The text as written, for the message */
  sample: string;
}

interface Scan {
  problems: FormatProblem[];
  text: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const TASK = /^(\s*)[-*+][ \t]+\[[ xX]\][ \t]+/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Placeholders for what inline scanning must not look into: code spans and URLs */
const HOLD = '\u0000';

/**
 * Walks a text and, where the profile does not show a syntax, takes it out (keeping what it held)
 * and records it. Code spans and fences are never looked into; a bare URL is never read as emphasis.
 */
function scan(markdown: string, profile: EditorProfile): Scan {
  const problems: FormatProblem[] = [];
  const found = (syntax: Syntax, sample: string) => {
    if (!problems.some((p) => p.syntax === syntax)) problems.push({ syntax, sample: sample.trim().slice(0, 60) });
  };
  const deepest = maxHeading(profile);
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const opened = FENCE.exec(line);
    if (fence !== undefined) {
      if (opened && opened[1]!.startsWith(fence[0]!) && opened[1]!.length >= fence.length && line.trim() === opened[1]) {
        fence = undefined;
        if (!allows(profile, 'codeBlock')) continue;
      }
      out.push(line);
      continue;
    }
    if (opened) {
      fence = opened[1]!;
      if (!allows(profile, 'codeBlock')) {
        found('codeBlock', line);
        continue;
      }
      out.push(line);
      continue;
    }
    let text = line;
    const heading = HEADING.exec(text);
    if (heading) {
      const level = heading[1]!.length;
      if (level > deepest) {
        found('heading', text);
        text = deepest > 0 ? `${'#'.repeat(deepest)} ${heading[2]!}` : heading[2]!;
      }
    }
    if (QUOTE.test(text) && !allows(profile, 'quote')) {
      found('quote', text);
      text = text.replace(QUOTE, '');
    }
    const task = TASK.exec(text);
    if (task && !allows(profile, 'taskList')) {
      found('taskList', text);
      text = text.replace(TASK, `${task[1]}- `);
    }
    const next = lines[i + 1];
    if (text.includes('|') && next !== undefined && TABLE_DELIMITER.test(next) && next.includes('-') && !allows(profile, 'table')) {
      found('table', text);
      // Rows become lines of cells, and the delimiter row goes
      out.push(cells(inline(text, profile, found)));
      i++;
      while (i + 1 < lines.length && lines[i + 1]!.includes('|') && lines[i + 1]!.trim() !== '') out.push(cells(inline(lines[++i]!, profile, found)));
      continue;
    }
    out.push(inline(text, profile, found));
  }
  return { problems, text: out.join('\n') };
}

const cells = (row: string): string =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean)
    .join(' · ');

const URL = /\bhttps?:\/\/[^\s<>()[\]]+/g;

/** One line's inline syntax, checked and taken out where the profile does not show it */
function inline(line: string, profile: EditorProfile, found: (syntax: Syntax, sample: string) => void): string {
  const held: string[] = [];
  const hold = (value: string) => `${HOLD}${held.push(value) - 1}${HOLD}`;
  // Code spans first: nothing inside them is formatting
  let text = line.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (match, _ticks: string, inner: string) => {
    if (allows(profile, 'code')) return hold(match);
    found('code', match);
    return hold(inner.trim());
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (match, alt: string) => {
    if (allows(profile, 'image')) return hold(match);
    found('image', match);
    return alt.trim();
  });
  text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label: string, url: string) => {
    if (allows(profile, 'link')) return `[${label}](${hold(url)})`;
    found('link', match);
    return label.trim() === url ? hold(url) : `${label} (${hold(url)})`;
  });
  // A bare URL is held whole, so its underscores or asterisks are never emphasis
  text = text.replace(URL, (url) => hold(url));
  text = text.replace(/<u>([\s\S]+?)<\/u>/g, (match, inner: string) => (allows(profile, 'underline') ? match : (found('underline', match), inner)));
  const pair = (pattern: RegExp, syntax: Syntax) => {
    text = text.replace(pattern, (match, inner: string) => (allows(profile, syntax) ? match : (found(syntax, match), inner)));
  };
  pair(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, 'bold');
  pair(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, 'bold');
  pair(/~~(?=\S)([\s\S]*?\S)~~/g, 'strike');
  pair(/\|\|(?=\S)([\s\S]*?\S)\|\|/g, 'spoiler');
  pair(/(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, 'italic');
  pair(/(?<![\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, 'italic');
  return text.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (_m, n: string) => held[Number(n)] ?? '');
}

/** The syntax in a text that the profile does not show, each kind once; empty when it all shows */
export function checkFormat(text: string, profile: EditorProfile): FormatProblem[] {
  return scan(text, profile).problems;
}

/**
 * The text with what the profile does not show taken out: emphasis keeps its words, a heading its
 * title, a link becomes "text (url)", a table its rows of cells, an image its alt text. `removed` says
 * what went, for the notice beside a cleaned proposal.
 */
export function stripFormat(text: string, profile: EditorProfile): { text: string; removed: Syntax[] } {
  const { problems, text: cleaned } = scan(text, profile);
  return { text: cleaned, removed: problems.map((p) => p.syntax) };
}

/** What is wrong with a text's formatting for a network, in a sentence, or undefined when nothing is */
export function formatProblem(network: string, text: string, profile: EditorProfile): string | undefined {
  const problems = checkFormat(text, profile);
  if (problems.length === 0) return undefined;
  const what = problems.map((p) => SYNTAX_NAMES[p.syntax]);
  const listed = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]!;
  return `${network} does not show ${listed} (${problems[0]!.sample}): ${profile.format === 'plain' ? 'write it as plain text' : 'take it out'}`;
}
