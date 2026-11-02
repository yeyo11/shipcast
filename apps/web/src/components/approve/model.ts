// Pure and import-light: the launch-to-approve screens' shaping of the drafts, testable without a browser
import { channelDefinition, editorProfile, type EditorProfile } from '@shipcast/schema/channels';

/** A draft as the launch page reads it: one file of the content pack */
export interface DraftLike {
  path: string;
  label: string;
  kind: string;
  content?: string | null;
  approved?: boolean;
}

/** A draft's file cut around the text the owner edits: the file's own lines before and after it stay as they are */
export interface DraftParts {
  head: string;
  body: string;
  tail: string;
}

/**
 * An article's front matter and a channel draft's heading and mode line (`> **Approval:**…`) are the
 * file's, not the text: the editor shows the body alone and a save puts them back around it.
 */
export function splitDraft(content: string, kind: string): DraftParts {
  let head = '';
  let rest = content;
  if (kind === 'article') {
    const front = /^---\n[\s\S]*?\n---\n/.exec(content);
    if (front) {
      head = front[0];
      rest = content.slice(head.length);
    }
  } else {
    const lines = content.split('\n');
    const mode = lines.findIndex((l) => l.startsWith('> **'));
    if (mode >= 0) {
      head = `${lines.slice(0, mode + 1).join('\n')}\n`;
      rest = content.slice(head.length);
    }
  }
  const lead = /^\s*/.exec(rest)![0];
  const trail = /\s*$/.exec(rest.slice(lead.length))![0];
  return { head: head + lead, body: rest.slice(lead.length, rest.length - trail.length), tail: trail };
}

export function joinDraft(parts: DraftParts, body: string): string {
  return parts.head + body + parts.tail;
}

/** Markdown read as plain words, for an excerpt: no headings' hashes, list marks, emphasis or code fences */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const words = (text: string): number => (text.trim() ? text.trim().split(/\s+/).length : 0);

const LANGS: Record<string, string> = { en: 'English', es: 'Spanish' };

/** A draft's language from its path (`src/content/posts/es/…`) */
export function langOf(path: string): 'en' | 'es' | undefined {
  const m = /(?:\/|-)(en|es)(?:\/|\.md$)/.exec(path);
  return m?.[1] === 'en' || m?.[1] === 'es' ? m[1] : undefined;
}

export const langName = (lang: string | undefined): string => (lang ? (LANGS[lang] ?? lang) : '');

/** A channel's text measured as its network counts it, against its cap, when it has one */
export function measure(channel: string, text: string): { length: number; max: number } | undefined {
  const def = channelDefinition(channel);
  return def?.text ? { length: def.text.length(text), max: def.text.max } : undefined;
}

const fmt = (n: number) => n.toLocaleString('en');

/** One piece of the launch: the article (its languages together) or one channel's post */
export interface Piece<D extends DraftLike = DraftLike> {
  /** `blog` for the article, else the channel */
  id: string;
  name: string;
  drafts: D[];
  /** The first draft's text, plain, for the card */
  excerpt: string;
  /** Its languages and length, or its count against the network's cap */
  meta: string;
  /** Changes with any of its drafts' text, so a mark made on one version is not taken for the next */
  fingerprint: string;
}

/** A short stable hash (FNV-1a), enough to tell two versions of a text apart */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** The drafts as pieces, in the pack's order: the article first, then one per channel */
export function piecesOf<D extends DraftLike>(drafts: readonly D[], channelOf: (path: string) => string | undefined, nameOf: (channel: string) => string): Piece<D>[] {
  const articles = drafts.filter((d) => d.kind === 'article');
  const pieces: Piece<D>[] = [];
  if (articles.length > 0) {
    const first = articles.find((a) => langOf(a.path) === 'en') ?? articles[0]!;
    const body = splitDraft(first.content ?? '', 'article').body;
    const langs = articles.map((a) => langName(langOf(a.path))).filter(Boolean);
    const named = langs.length > 1 ? `${langs.slice(0, -1).join(', ')} and ${langs.at(-1)}` : (langs[0] ?? '');
    pieces.push({
      id: 'blog',
      name: 'Article',
      drafts: [first, ...articles.filter((a) => a !== first)],
      excerpt: plainText(body),
      meta: [named, `${fmt(words(plainText(body)))} words`].filter(Boolean).join(' · '),
      fingerprint: fingerprint(articles.map((a) => a.content ?? '').join('\0')),
    });
  }
  const byChannel = new Map<string, D[]>();
  for (const d of drafts) {
    if (d.kind !== 'channel') continue;
    const channel = channelOf(d.path) ?? d.label;
    byChannel.set(channel, [...(byChannel.get(channel) ?? []), d]);
  }
  for (const [channel, list] of byChannel) {
    const body = splitDraft(list[0]!.content ?? '', 'channel').body;
    const m = measure(channel, body);
    pieces.push({
      id: channel,
      name: nameOf(channel),
      drafts: list,
      excerpt: plainText(body),
      meta: m ? `${fmt(m.length)} of ${fmt(m.max)} characters` : `${fmt(body.length)} characters`,
      fingerprint: fingerprint(list.map((d) => d.content ?? '').join('\0')),
    });
  }
  return pieces;
}

/** "3 min ago": how long since a moment, in the few words a header has room for */
export function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

/** A month's grid, Monday first: the blank cells before its 1st, and how many days it has */
export function monthGrid(year: number, month: number): { blanks: number; days: number } {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return { blanks: (first + 6) % 7, days: new Date(Date.UTC(year, month + 1, 0)).getUTCDate() };
}

export type Verdict = 'backed' | 'planned' | 'not-found' | 'contradicted';

export const VERDICT_WORDS: Record<Verdict, { title: string; count: string }> = {
  backed: { title: 'Backed by the code', count: 'backed' },
  planned: { title: 'Planned, not built', count: 'planned' },
  'not-found': { title: 'Not found in the code', count: 'not found' },
  contradicted: { title: 'The code says otherwise', count: 'says otherwise' },
};

/** The check's verdicts counted, in the order the screen shows them; a verdict with none is left out */
export function verdictCounts(findings: ReadonlyArray<{ verdict: Verdict }>): Array<{ verdict: Verdict; count: number; words: string }> {
  const order: Verdict[] = ['backed', 'planned', 'not-found', 'contradicted'];
  return order.flatMap((verdict) => {
    const count = findings.filter((f) => f.verdict === verdict).length;
    return count > 0 ? [{ verdict, count, words: `${count} ${VERDICT_WORDS[verdict].count}` }] : [];
  });
}

/** The line that sums a check up on the editor's card: the worst of it first */
export function checkSummary(findings: ReadonlyArray<{ verdict: Verdict }>): string {
  const n = (v: Verdict) => findings.filter((f) => f.verdict === v).length;
  const claims = (k: number) => (k === 1 ? '1 claim' : `${k} claims`);
  if (findings.length === 0) return 'Last check: no claims to check';
  if (n('contradicted') > 0) return `Last check: ${claims(n('contradicted'))} the code says otherwise`;
  if (n('not-found') > 0) return `Last check: ${claims(n('not-found'))} not found in the code`;
  if (n('planned') > 0) return `Last check: ${claims(n('planned'))} only planned`;
  return `Last check: every claim backed by the code`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The wall clock of an instant in a zone, as a `YYYY-MM-DD` day and an `HH:MM` time */
export function zonedParts(iso: string, timeZone: string): { day: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${pad2(Number(p.hour) % 24)}:${p.minute}` };
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A wall-clock day and time in words: `Thu 5 Nov, 15:00` */
export function dayLabel(day: string, time: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAY[date.getUTCDay()]} ${d} ${MONTH[m - 1]}, ${time}`;
}

/** A time for a channel's line: `Mon 15:00` within the coming week, the day in full beyond it */
export function timeLabel(iso: string, timeZone: string, now: Date): string {
  const { day, time } = zonedParts(iso, timeZone);
  const days = (Date.parse(iso) - now.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    return `${WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${time}`;
  }
  return dayLabel(day, time);
}

/** A front matter's `pubDate` and the article's reading time, as the blog heads it: `30 Oct 2026 · 6 min` */
export function articleLine(content: string, body: string): string {
  const date = /^pubDate:\s*["']?(\d{4})-(\d{2})-(\d{2})/m.exec(content);
  const minutes = Math.max(1, Math.round(words(plainText(body)) / 220));
  const when = date ? `${Number(date[3])} ${MONTH[Number(date[2]) - 1]} ${date[1]}` : '';
  return [when, `${minutes} min`].filter(Boolean).join(' · ');
}

/**
 * What the drafts screen is for a launch: the editor while its drafts can still change (a launch
 * Shipcast holds while drafted, one in a pull request while that is open), titled Drafts; otherwise a
 * read-only view of the text as it went out, titled by the launch's own state (Published, Failed…).
 */
export function draftsView(review: { app?: { open: boolean }; pullRequest?: { state: string } } | undefined, state: { label: string }): { editable: boolean; title: string } {
  const editable = review?.app ? review.app.open : review?.pullRequest?.state === 'open';
  return editable ? { editable: true, title: 'Drafts' } : { editable: false, title: state.label };
}

/**
 * The formatting a draft's text is edited with: its channel's profile, or the article's for a text
 * of no channel (the release notes, a draft whose file name is not a channel's), so every draft gets
 * the rich editor rather than a bare text box
 */
export function draftProfile(channel: string): EditorProfile {
  return editorProfile(channel) ?? editorProfile(undefined)!;
}
