/*
 * The word-level diff every assistant proposal is shown as, and the pieces of a chat answer. Pure,
 * so the browser and the tests run the same code.
 */

export interface Part {
  type: 'equal' | 'insert' | 'delete';
  text: string;
}

/** Words (letters, digits, apostrophes and hyphens inside them), runs of whitespace, and single marks */
const TOKEN = /\s+|[\p{L}\p{N}_]+(?:['’-][\p{L}\p{N}_]+)*|[^\s\p{L}\p{N}_]/gu;

export function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/** Above this many cells the table would cost too much in a browser; the middle is then replaced whole */
const MAX_CELLS = 4_000_000;

function push(parts: Part[], type: Part['type'], text: string) {
  if (!text) return;
  const last = parts.at(-1);
  if (last?.type === type) last.text += text;
  else parts.push({ type, text });
}

/** The longest common subsequence of two token lists, walked into parts */
function lcs(a: string[], b: string[], parts: Part[]) {
  const n = a.length;
  const m = b.length;
  // Lengths of the LCS of a[i:] and b[j:], one row per i, in one flat array
  const table = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = a[i] === b[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(parts, 'equal', a[i]!);
      i++;
      j++;
    } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) {
      push(parts, 'delete', a[i]!);
      i++;
    } else {
      push(parts, 'insert', b[j]!);
      j++;
    }
  }
  while (i < n) push(parts, 'delete', a[i++]!);
  while (j < m) push(parts, 'insert', b[j++]!);
}

/**
 * A run of changes reads as one deletion and one insertion, deletions first; a lone space kept
 * between two changes is folded into both ("~~the old~~ ++a new++" rather than "~~the~~ ++a++ ~~old~~ ++new++").
 */
function fold(parts: Part[]): Part[] {
  const out: Part[] = [];
  let deleted = '';
  let inserted = '';
  const flush = () => {
    push(out, 'delete', deleted);
    push(out, 'insert', inserted);
    deleted = '';
    inserted = '';
  };
  parts.forEach((part, k) => {
    const next = parts[k + 1];
    if (part.type === 'delete') deleted += part.text;
    else if (part.type === 'insert') inserted += part.text;
    else if (/^\s+$/.test(part.text) && (deleted || inserted) && next && next.type !== 'equal') {
      deleted += part.text;
      inserted += part.text;
    } else {
      flush();
      push(out, 'equal', part.text);
    }
  });
  flush();
  return out;
}

/** The word-level difference from `before` to `after`: equal, deleted and inserted runs, in order */
export function wordDiff(before: string, after: string): Part[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const parts: Part[] = [];
  push(parts, 'equal', a.slice(0, start).join(''));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    push(parts, 'delete', midA.join(''));
    push(parts, 'insert', midB.join(''));
  } else {
    lcs(midA, midB, parts);
  }
  push(parts, 'equal', a.slice(endA).join(''));
  return fold(parts);
}

/** What a diff changes, in words, for a screen reader's summary */
export function diffSummary(parts: Part[]): { inserted: number; deleted: number } {
  const words = (text: string) => tokens(text).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  return {
    inserted: parts.filter((p) => p.type === 'insert').reduce((n, p) => n + words(p.text), 0),
    deleted: parts.filter((p) => p.type === 'delete').reduce((n, p) => n + words(p.text), 0),
  };
}

export type Piece = { type: 'prose'; text: string } | { type: 'proposal'; text: string; complete: boolean };

/**
 * A chat answer cut into prose and the proposals it carries (fenced ```proposal blocks). A block
 * still open while the answer streams is a proposal not complete yet, which cannot be accepted.
 */
export function splitProposals(answer: string): Piece[] {
  const pieces: Piece[] = [];
  const open = /```proposal[^\n]*\n/g;
  let at = 0;
  for (let match = open.exec(answer); match; match = open.exec(answer)) {
    const prose = answer.slice(at, match.index).trim();
    if (prose) pieces.push({ type: 'prose', text: prose });
    const bodyStart = match.index + match[0].length;
    const close = answer.indexOf('\n```', bodyStart - 1);
    if (close < 0) {
      pieces.push({ type: 'proposal', text: answer.slice(bodyStart), complete: false });
      return pieces;
    }
    pieces.push({ type: 'proposal', text: answer.slice(bodyStart, Math.max(bodyStart, close)), complete: true });
    at = close + 4;
    open.lastIndex = at;
  }
  const rest = answer.slice(at).trim();
  if (rest) pieces.push({ type: 'prose', text: rest });
  return pieces;
}

/** Replaces the selected range of a text with a proposal: what Accept does */
export function applyProposal(document: string, range: { start: number; end: number } | undefined, proposal: string): string {
  if (!range || range.start === range.end) return proposal;
  return document.slice(0, range.start) + proposal + document.slice(range.end);
}

/**
 * The words around a selection, within its sentence: what the proposal card shows before and after
 * the change so a reader sees it in place ("They were never where the code was, [change]"). A
 * sentence ends at . ! ? followed by a space, or at a line break; each side is capped at `max`
 * characters, cut at a word and marked with an ellipsis.
 */
export function sentenceContext(document: string, range: { start: number; end: number }, max = 120): { before: string; after: string } {
  let start = range.start;
  while (start > 0) {
    const c = document[start - 1]!;
    if (c === '\n' || (/\s/.test(c) && start >= 2 && /[.!?]/.test(document[start - 2]!))) break;
    start--;
  }
  let end = range.end;
  while (end < document.length) {
    const c = document[end]!;
    if (c === '\n') break;
    end++;
    if (/[.!?]/.test(c) && (end === document.length || /\s/.test(document[end]!))) break;
  }
  let before = document.slice(start, range.start).replace(/^\s+/, '');
  let after = document.slice(range.end, end).replace(/\s+$/, '');
  if (before.length > max) before = `…${before.slice(before.length - max).replace(/^\S*\s/, '')}`;
  if (after.length > max) after = `${after.slice(0, max).replace(/\s\S*$/, '')}…`;
  return { before, after };
}

/**
 * A diff as a person reads it: changes separated by only a few equal words (`gap` or fewer) read as
 * one deletion and one insertion, rather than a confetti of struck and added words ("went stale"
 * and "the week" and "wrote" each changed). Both texts still rebuild exactly.
 */
export function readableDiff(parts: Part[], gap = 3): Part[] {
  const wordsIn = (text: string) => tokens(text).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  const out: Part[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (part.type === 'equal') {
      push(out, 'equal', part.text);
      i++;
      continue;
    }
    // A run of changes, swallowing the short equal stretches between them
    let deleted = '';
    let inserted = '';
    let j = i;
    for (;;) {
      const p = parts[j];
      if (!p) break;
      if (p.type === 'delete') deleted += p.text;
      else if (p.type === 'insert') inserted += p.text;
      else {
        const next = parts[j + 1];
        if (!next || next.type === 'equal' || wordsIn(p.text) > gap) break;
        deleted += p.text;
        inserted += p.text;
      }
      j++;
    }
    push(out, 'delete', deleted);
    push(out, 'insert', inserted);
    i = j;
  }
  return out;
}
