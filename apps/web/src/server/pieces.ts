import type { Capability, EditField, PostChanges } from '@shipcast/engine';

/*
 * The launch page's published pieces, as plain data the page and the tests share: a row per piece
 * with what it can do and, when it cannot, why; what an edit of several pieces at once changes on
 * each; the recommended times as chips. Only types come from the engine, so this module is safe in
 * the browser bundle. The rules mirror the engine's (packages/engine/src/edit.ts), which refuses
 * again on the server: the page only says it first. See docs/decisions/launch-page.md
 */

export type PieceStatus = 'live' | 'edited' | 'deleted' | 'scheduled' | 'failed';

/** A post row as the page receives it */
export interface PieceInput {
  id: number;
  channel: string;
  kind: string;
  accountId: number | null;
  externalId: string | null;
  url: string | null;
  status: string;
  scheduledAt: string | null;
  publishedAt: string;
  updatedAt: string;
}

export interface AccountInput {
  id: number;
  label: string;
  identity: string | null;
  avatarUrl: string | null;
}

export interface ReadingInput {
  postId: number;
  name: string;
  value: number;
  takenAt: string;
}

/** An action a row offers: allowed, or refused with the reason the page shows beside it */
export interface Action {
  allowed: boolean;
  /** Why not, when refused; what to know before, when allowed */
  reason: string;
}

export interface PieceRow {
  id: number;
  channel: string;
  kind: string;
  /** What the piece is beside its channel: '' for the post, EN or ES for an article or an issue, story, comment */
  piece: string;
  account: { label: string; handle: string | null; avatarUrl: string | null } | null;
  status: PieceStatus;
  url: string | null;
  publishedAt: string;
  scheduledAt: string | null;
  updatedAt: string;
  /** The number a row shows, with its history for the sparkline */
  metric: { name: string; value: number; series: number[] } | null;
  /** The latest reading of each of its numbers */
  numbers: Array<{ name: string; value: number }>;
  edit: Action & { fields: EditField[] };
  remove: Action & { verb: 'Delete' | 'Unpublish' };
}

/*
 * The number each network's row leads with: the first of these the piece has. They are names of
 * METRIC_FAMILIES (packages/engine/src/stats.ts), a test checks it: views where a network counts
 * them, its reaction otherwise.
 */
export const PRIMARY_METRIC: Readonly<Record<string, readonly string[]>> = {
  devto: ['views', 'reactions'],
  hashnode: ['views', 'reactions'],
  bluesky: ['likes', 'reposts'],
  mastodon: ['favourites', 'boosts'],
  instagram: ['views', 'likes'],
  newsletter: ['opens', 'clicks'],
};

const NAMES: Record<string, string> = { devto: 'dev.to', hashnode: 'Hashnode', mastodon: 'Mastodon', telegram: 'Telegram', discord: 'Discord', bluesky: 'Bluesky', instagram: 'Instagram', newsletter: 'The newsletter', blog: 'The blog' };
export const networkName = (channel: string) => NAMES[channel] ?? channel;

/** A post's own piece, or a blog article: what the engine edits and deletes (a story, a comment or an issue is not) */
export const isMainPiece = (channel: string, kind: string) => (channel === 'blog' ? kind.startsWith('article:') : kind === 'post');

function pieceLabel(kind: string): string {
  if (kind === 'post') return '';
  const lang = /^(?:article|issue):(\w+)$/.exec(kind)?.[1];
  return lang ? lang.toUpperCase() : kind;
}

const asStatus = (status: string): PieceStatus => (['live', 'edited', 'deleted', 'scheduled', 'failed'].includes(status) ? (status as PieceStatus) : 'live');

const DELETED = 'Deleted already. A launch happens once: Shipcast never publishes it again';

/** Why a piece cannot be edited or deleted, in the engine's order of checks; undefined when it can */
export function refusal(piece: Pick<PieceInput, 'channel' | 'kind' | 'externalId'> & { status: PieceStatus }, capability: Capability, action: 'edit' | 'delete'): string | undefined {
  if (piece.status === 'deleted') return DELETED;
  if (piece.status === 'scheduled') return 'Not out yet: move or cancel its time instead';
  if (piece.status === 'failed') return 'It never went out';
  if (capability[action] === 'no') return capability.note;
  if (!isMainPiece(piece.channel, piece.kind)) {
    const what = piece.kind.startsWith('issue:') ? 'A newsletter issue' : `A ${piece.kind}`;
    return `${what} is not ${action === 'edit' ? 'edited' : 'deleted'} from Shipcast, only the post it belongs to`;
  }
  if (!piece.externalId && piece.channel !== 'blog') return `It has no id on ${networkName(piece.channel)} to ${action} it by`;
  return undefined;
}

/** One row per piece: its account, its status, its numbers over time, and what it can do */
export function pieceRows(input: {
  posts: readonly PieceInput[];
  accounts: readonly AccountInput[];
  readings: readonly ReadingInput[];
  capabilities: Readonly<Record<string, Capability>>;
}): PieceRow[] {
  const accounts = new Map(input.accounts.map((a) => [a.id, a]));
  const byPost = new Map<number, ReadingInput[]>();
  for (const r of input.readings) byPost.set(r.postId, [...(byPost.get(r.postId) ?? []), r]);
  return input.posts.map((post) => {
    const status = asStatus(post.status);
    const capability = input.capabilities[post.channel] ?? { edit: 'no', delete: 'no', note: 'Shipcast does not know this channel', fields: [] };
    const readings = [...(byPost.get(post.id) ?? [])].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
    const latest = new Map<string, number>();
    for (const r of readings) latest.set(r.name, r.value);
    const lead = (PRIMARY_METRIC[post.channel] ?? []).find((name) => latest.has(name)) ?? [...latest.keys()][0];
    const account = post.accountId === null ? undefined : accounts.get(post.accountId);
    const editWhy = refusal({ ...post, status }, capability, 'edit');
    const deleteWhy = refusal({ ...post, status }, capability, 'delete');
    const unpublish = capability.delete === 'unpublish';
    return {
      id: post.id,
      channel: post.channel,
      kind: post.kind,
      piece: pieceLabel(post.kind),
      account: account ? { label: account.label, handle: account.identity, avatarUrl: account.avatarUrl } : null,
      status,
      url: post.url,
      publishedAt: post.publishedAt,
      scheduledAt: post.scheduledAt,
      updatedAt: post.updatedAt,
      metric: lead === undefined ? null : { name: lead, value: latest.get(lead) ?? 0, series: readings.filter((r) => r.name === lead).map((r) => r.value) },
      numbers: [...latest].map(([name, value]) => ({ name, value })),
      edit: { allowed: editWhy === undefined, reason: editWhy ?? capability.note, fields: editWhy === undefined ? capability.fields : [] },
      remove: {
        allowed: deleteWhy === undefined,
        reason: deleteWhy ?? capability.note,
        verb: unpublish ? 'Unpublish' : 'Delete',
      },
    };
  });
}

/** A row's status after an edit or a delete answered, so the page updates without reading everything again */
export function withStatus(row: PieceRow, status: PieceStatus, updatedAt: string): PieceRow {
  if (status !== 'deleted') return { ...row, status, updatedAt };
  return { ...row, status, updatedAt, edit: { allowed: false, reason: DELETED, fields: [] }, remove: { ...row.remove, allowed: false, reason: DELETED } };
}

/* ---------- Editing several pieces at once ---------- */

/** The fields an edit of several channels sends: those every network has in some form */
export interface SharedChanges {
  text?: string;
  link?: string;
  imageUrl?: string;
  imageAlt?: string;
}

/** What a field becomes on a network, in the owner's words */
function fieldOn(channel: string, field: EditField): string {
  const article = channel === 'devto' || channel === 'hashnode' || channel === 'blog';
  switch (field) {
    case 'text':
      return article ? 'the whole article body' : channel === 'discord' ? 'the message' : 'the text';
    case 'link':
      return article ? 'the canonical URL' : 'the link, after the text';
    case 'image':
      return article ? 'the cover' : channel === 'telegram' ? 'the photo' : 'the image';
    default:
      return field;
  }
}

/** Networks whose post is text alone: a link goes after the text, so the text must come with it */
const TEXT_POSTS = ['mastodon', 'telegram', 'discord'];
/** Networks that replace the text whole and cannot keep it: a change there needs the text */
const TEXT_REQUIRED = ['telegram', 'discord'];

const sharedFields = (changes: SharedChanges): EditField[] => [
  ...(changes.text !== undefined ? (['text'] as const) : []),
  ...(changes.link !== undefined ? (['link'] as const) : []),
  ...(changes.imageUrl !== undefined ? (['image'] as const) : []),
];

export type PlanEntry =
  | { id: number; channel: string; piece: string; ok: true; changes: string[]; dropped: string[]; warning?: string }
  | { id: number; channel: string; piece: string; ok: false; reason: string };

/**
 * What an edit of the selected pieces does on each: the fields its network takes (and what each
 * becomes there), the ones it leaves out, or why the piece is left alone. The engine's editPost with
 * `strict: false` applies the same rules on the server.
 */
export function multiEditPlan(rows: readonly PieceRow[], changes: SharedChanges): PlanEntry[] {
  const asked = sharedFields(changes);
  return rows.map((row) => {
    const base = { id: row.id, channel: row.channel, piece: row.piece };
    if (!row.edit.allowed) return { ...base, ok: false, reason: row.edit.reason };
    const kept = asked.filter((f) => row.edit.fields.includes(f));
    const dropped = asked.filter((f) => !row.edit.fields.includes(f));
    if (asked.length === 0) return { ...base, ok: false, reason: 'Nothing to change yet' };
    if (kept.length === 0) return { ...base, ok: false, reason: `${networkName(row.channel)} takes none of these: it changes ${row.edit.fields.join(', ')}` };
    if (TEXT_POSTS.includes(row.channel) && kept.includes('link') && !kept.includes('text')) {
      return { ...base, ok: false, reason: `${networkName(row.channel)} replaces the whole text: write the text to go with the link` };
    }
    if (TEXT_REQUIRED.includes(row.channel) && !kept.includes('text')) {
      return { ...base, ok: false, reason: `${networkName(row.channel)} replaces the text whole: write the text` };
    }
    const article = row.channel === 'devto' || row.channel === 'hashnode' || row.channel === 'blog';
    return {
      ...base,
      ok: true,
      changes: kept.map((f) => fieldOn(row.channel, f)),
      dropped,
      ...(article && kept.includes('text') && { warning: 'The text replaces the article’s whole body' }),
    };
  });
}

/** The text a text-only network shows after an edit: the text, then the link, as the engine composes it */
export function composedText(channel: string, changes: Pick<PostChanges, 'text' | 'link'>): string | undefined {
  if (changes.text === undefined) return undefined;
  return TEXT_POSTS.includes(channel) && changes.link ? `${changes.text.trimEnd()}\n\n${changes.link}` : changes.text;
}

/** The form of one piece's edit, as typed */
export interface EditForm {
  text: string;
  title: string;
  tags: string;
  link: string;
  imageUrl: string;
  imageAlt: string;
}

/**
 * The change one piece's edit sends: the fields the owner changed from what the form started with,
 * and the text again where the network needs it whole (a link or a photo on Telegram, a link on
 * Mastodon or Discord). Undefined when nothing changed.
 */
export function singleEditChanges(channel: string, fields: readonly EditField[], form: EditForm, initial: EditForm): PostChanges | undefined {
  const changed = (key: keyof EditForm) => form[key].trim() !== initial[key].trim();
  const has = (f: EditField) => fields.includes(f);
  const link = has('link') && changed('link') && form.link.trim() !== '' ? form.link.trim() : undefined;
  const imageUrl = has('image') && changed('imageUrl') && form.imageUrl.trim() !== '' ? form.imageUrl.trim() : undefined;
  const needsText = (TEXT_POSTS.includes(channel) && link !== undefined) || (channel === 'telegram' && imageUrl !== undefined);
  const text = has('text') && (changed('text') || needsText) && form.text.trim() !== '' ? form.text : undefined;
  const tags = form.tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const changes: PostChanges = {
    ...(text !== undefined && { text }),
    ...(has('title') && changed('title') && form.title.trim() !== '' && { title: form.title.trim() }),
    ...(has('tags') && changed('tags') && { tags }),
    ...(link !== undefined && { link }),
    ...(imageUrl !== undefined && { imageUrl, ...(form.imageAlt.trim() && { imageAlt: form.imageAlt.trim() }) }),
  };
  return Object.keys(changes).length === 0 ? undefined : changes;
}

/* ---------- Scheduling ---------- */

/** A recommended time as the engine gives it */
export interface SlotInput {
  at: string;
  local: string;
  score: number;
  reason: string;
}

export interface Chip {
  at: string;
  /** `Tue 17:00`: short enough for a chip */
  label: string;
  /** The day and time in full, and why it is recommended: the chip's tooltip and accessible name */
  title: string;
  best: boolean;
}

/** The recommended times as chips, in the order given (best first), dropping any already past */
export function scheduleChips(slots: readonly SlotInput[], now: Date): Chip[] {
  return slots
    .filter((s) => Date.parse(s.at) > now.getTime())
    .map((s, i) => {
      // `Tue 2026-10-27 17:00` → `Tue 17:00`
      const m = /^(\w{3}) \d{4}-\d{2}-\d{2} (\d{2}:\d{2})$/.exec(s.local);
      const label = m ? `${m[1]} ${m[2]}` : s.local;
      return { at: s.at, label, title: `${s.local}: ${s.reason} (expected ${s.score.toFixed(1)}× a typical post)`, best: i === 0 };
    });
}

/** How long until a scheduled piece goes out, in words; a time past is due on the next run */
export function countdown(at: string, now: Date): string {
  const ms = Date.parse(at) - now.getTime();
  if (Number.isNaN(ms)) return '';
  if (ms <= 0) return 'due now: it goes out on the next run';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `in ${hours} h ${minutes % 60} min`;
  return `in ${Math.floor(hours / 24)} days ${hours % 24} h`;
}

/** A `datetime-local` value (the browser's own zone) as an instant with its offset, which the server requires */
export function localInputToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** An instant as a `datetime-local` value in the browser's own zone */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
