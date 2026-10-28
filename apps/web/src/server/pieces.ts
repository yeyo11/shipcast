import type { Capability, EditField, PostChanges } from '@shipcast/engine';
import { draftBody, splitFrontMatter } from '@shipcast/schema/markdown';
import { markOf, type Mark } from './launch-summary.ts';

/*
 * The launch page's published pieces, as plain data the page and the tests share: a row per piece
 * with what it can do and, when it cannot, why; what an edit of several pieces at once changes on
 * each; the recommended times as chips. Only types come from the engine, so this module is safe in
 * the browser bundle. The rules mirror the engine's (packages/engine/src/edit.ts), which refuses
 * again on the server: the page only says it first. See docs/web-app.md
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

/** What the page needs of a piece after a change, to update its row in place */
export interface PieceState {
  id: number;
  status: string;
  updatedAt: string;
  scheduledAt: string | null;
}

/** One number of a piece over the readings Shipcast took (every six hours) */
export interface PieceNumber {
  name: string;
  value: number;
  /** The first reading, so the page can say how much it grew since it was first read */
  first: number;
  series: number[];
  /** When the first and the latest readings were taken */
  from: string;
  to: string;
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
  /** Each of its numbers over time: the first and latest readings, and every reading for the line */
  numbers: PieceNumber[];
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

const NAMES: Record<string, string> = { devto: 'dev.to', hashnode: 'Hashnode', mastodon: 'Mastodon', telegram: 'Telegram', discord: 'Discord', bluesky: 'Bluesky', instagram: 'Instagram', newsletter: 'The newsletter', brevo: 'The newsletter', blog: 'The blog', reddit: 'Reddit', threads: 'Threads', linkedin: 'LinkedIn', githubDiscussions: 'GitHub Discussions' };
export const networkName = (channel: string) => NAMES[channel] ?? channel;

/** A post's own piece, a blog article or a subreddit's post: what the engine edits and deletes (a story, a comment or an issue is not) */
export const isMainPiece = (channel: string, kind: string) => {
  if (channel === 'blog') return kind.startsWith('article:');
  return channel === 'reddit' ? kind.startsWith('post:') : kind === 'post';
};

function pieceLabel(kind: string): string {
  if (kind === 'post') return '';
  if (kind.startsWith('post:')) return `r/${kind.slice('post:'.length)}`;
  const lang = /^(?:article|issue):(\w+)$/.exec(kind)?.[1];
  return lang ? lang.toUpperCase() : kind;
}

export const asStatus = (status: string): PieceStatus => (['live', 'edited', 'deleted', 'scheduled', 'failed'].includes(status) ? (status as PieceStatus) : 'live');

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
    const numbers = new Map<string, PieceNumber>();
    for (const r of readings) {
      latest.set(r.name, r.value);
      const n = numbers.get(r.name);
      if (n) numbers.set(r.name, { ...n, value: r.value, series: [...n.series, r.value], to: r.takenAt });
      else numbers.set(r.name, { name: r.name, value: r.value, first: r.value, series: [r.value], from: r.takenAt, to: r.takenAt });
    }
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
      account: account ? { label: account.label, handle: account.identity, avatarUrl: accountAvatar(account) } : null,
      status,
      url: post.url,
      publishedAt: post.publishedAt,
      scheduledAt: post.scheduledAt,
      updatedAt: post.updatedAt,
      metric: lead === undefined ? null : { name: lead, value: latest.get(lead) ?? 0, series: readings.filter((r) => r.name === lead).map((r) => r.value) },
      numbers: [...numbers.values()],
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

/* ---------- The accounts a launch went out with ---------- */

export interface SnapshotInput {
  accountId: number;
  /** YYYY-MM-DD, UTC */
  day: string;
  followers: number | null;
}

export interface AccountRow {
  id: number;
  network: string;
  label: string;
  handle: string | null;
  avatarUrl: string | null;
  /** The channels of this launch it published on */
  channels: string[];
  /**
   * Its followers around the launch, from the daily snapshots: the last count before the launch's
   * day (or the first one there is, for an account connected later), the latest, and the days
   * between for the line. Null when the network counts no followers or nothing was recorded yet.
   */
  followers: { before: number; now: number; change: number; series: number[]; from: string; to: string } | null;
}

/**
 * One row per account that published a piece of the launch, with how its followers moved since. A
 * piece with no account went out with the .env credentials, which have no snapshots, so it has no row.
 */
export function accountRows(input: {
  posts: readonly Pick<PieceInput, 'channel' | 'accountId'>[];
  accounts: readonly (AccountInput & { network: string })[];
  snapshots: readonly SnapshotInput[];
  launchedAt: string;
}): AccountRow[] {
  const launchDay = input.launchedAt.slice(0, 10);
  const used = new Map<number, string[]>();
  for (const p of input.posts) {
    if (p.accountId === null) continue;
    const channels = used.get(p.accountId) ?? [];
    if (!channels.includes(p.channel)) channels.push(p.channel);
    used.set(p.accountId, channels);
  }
  return input.accounts.flatMap((a) => {
    const channels = used.get(a.id);
    if (!channels) return [];
    const days = input.snapshots
      .filter((s): s is SnapshotInput & { followers: number } => s.accountId === a.id && s.followers !== null)
      .sort((x, y) => x.day.localeCompare(y.day));
    const last = days.at(-1);
    const before = days.filter((s) => s.day < launchDay).at(-1) ?? days[0];
    const shown = days.filter((s) => s.day >= (before?.day ?? ''));
    return [
      {
        id: a.id,
        network: a.network,
        label: a.label,
        handle: a.identity,
        avatarUrl: accountAvatar(a),
        channels,
        followers:
          last && before ? { before: before.followers, now: last.followers, change: last.followers - before.followers, series: shown.map((s) => s.followers), from: before.day, to: last.day } : null,
      },
    ];
  });
}

/** A signed change for reading: +12, −3, or 0 */
export const signed = (n: number) => (n > 0 ? `+${n.toLocaleString('en')}` : n < 0 ? `−${Math.abs(n).toLocaleString('en')}` : '0');

/* ---------- A channel's pieces as one state ---------- */

export type GroupTone = 'published' | 'partial' | 'failed' | 'scheduled' | 'deleted';

const OUT: readonly PieceStatus[] = ['live', 'edited'];

/** What a piece is called in its channel's summary */
export const pieceName = (row: Pick<PieceRow, 'kind' | 'piece'>) => (row.kind === 'post' ? 'Post' : row.piece.charAt(0).toUpperCase() + row.piece.slice(1));

/** The aggregate state of a channel's pieces: all out, some of them, failed, waiting for a time, or gone */
export function groupState(pieces: readonly Pick<PieceRow, 'status'>[]): { label: string; tone: GroupTone } {
  const total = pieces.length;
  const count = (statuses: readonly PieceStatus[]) => pieces.filter((p) => statuses.includes(p.status)).length;
  if (count(['failed']) > 0) return { label: 'Failed', tone: 'failed' };
  if (count(['deleted']) === total) return { label: total === 1 ? 'Deleted' : 'All deleted', tone: 'deleted' };
  if (count(['scheduled']) === total) return { label: 'Scheduled', tone: 'scheduled' };
  const out = count(OUT);
  if (out === total) {
    if (total === 1) return { label: pieces[0]!.status === 'edited' ? 'Edited' : 'Published', tone: 'published' };
    return { label: 'All published', tone: 'published' };
  }
  return { label: `${out} of ${total} published`, tone: 'partial' };
}

/* ---------- The channels of a launch's page ---------- */

/** A channel's chip and panel on the launch page: what went out there, what failed, what still waits for a time */
export interface ChannelEntry {
  channel: string;
  pieces: PieceRow[];
  /** The publishing failure of this launch on this channel, kept until it is tried again */
  failure: string | undefined;
  /** Set while the channel can still be given a time: its scheduled piece, or null for none yet */
  scheduling: { scheduled: { id: number; scheduledAt: string | null } | null } | undefined;
  mark: Mark;
  /** The state in words, beside the dot: `All published`, `Failed`, `Scheduled`, `Not out yet` */
  label: string;
  replies: number;
}

/**
 * One entry per channel of a launch, in the order its pieces went out, then the channels that failed
 * before anything went out, then those still waiting for a time. No channel appears twice: a channel's
 * pieces (a language, a story) are the detail of its one entry.
 */
export function channelEntries(input: {
  rows: readonly PieceRow[];
  failures: ReadonlyArray<{ channel: string; message: string }>;
  scheduling: ReadonlyArray<{ channel: string; scheduled: { id: number; scheduledAt: string | null } | null }>;
  replies?: Readonly<Record<string, number>>;
}): ChannelEntry[] {
  const order: string[] = [];
  const note = (channel: string) => {
    if (!order.includes(channel)) order.push(channel);
  };
  for (const r of input.rows) note(r.channel);
  for (const f of input.failures) note(f.channel);
  for (const s of input.scheduling) note(s.channel);
  return order.map((channel) => {
    const pieces = input.rows.filter((r) => r.channel === channel);
    const failure = input.failures.find((f) => f.channel === channel)?.message;
    const sched = input.scheduling.find((s) => s.channel === channel);
    const statuses: string[] = [...pieces.map((p) => p.status), ...(sched?.scheduled ? ['scheduled'] : [])];
    const mark = markOf(statuses, failure !== undefined);
    const label =
      failure !== undefined ? 'Failed' : pieces.length > 0 ? groupState(pieces).label : sched?.scheduled ? 'Scheduled' : 'Not out yet';
    return { channel, pieces, failure, scheduling: sched ? { scheduled: sched.scheduled } : undefined, mark, label, replies: input.replies?.[channel] ?? 0 };
  });
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

/**
 * What an edit form starts from: the piece's text as merged in the drafts' pull request, which is
 * what went out unless it was edited since. Shipcast keeps no copy of a published post, so a piece
 * with no draft starts empty. The front matter is not the text: its title is the title field.
 */
export function draftPrefill(drafts: ReadonlyArray<{ path: string; content?: string }>, row: Pick<PieceRow, 'channel' | 'kind'>): { text: string; title: string } {
  const lang = /^article:(\w+)$/.exec(row.kind)?.[1];
  const draft = drafts.find((d) => {
    const name = d.path.split('/').at(-1) ?? '';
    if (row.channel === 'blog') return lang !== undefined && d.path.startsWith(`src/content/posts/${lang}/`);
    return name === `${row.channel}.md`;
  });
  const content = draft?.content ?? '';
  const front = splitFrontMatter(content);
  // A channel's draft opens with its heading and the approval note, which are never the post's
  if (!front) return { text: draftBody(content), title: '' };
  const title = /^title:\s*["']?(.*?)["']?\s*$/m.exec(front.front)?.[1] ?? '';
  return { text: front.body.trim(), title };
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

/*
 * Times on the page are the owner's zone (the setting the recommendations speak in), not the
 * browser's: the chips, the picker and a scheduled piece all read the same clock, and the server
 * renders the same text the browser does.
 */

/** The wall-clock parts of an instant in a zone */
function wallParts(ms: number, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute) };
}

/** A `datetime-local` value read as a wall-clock time in `timeZone`, as the instant (ISO, UTC) the server takes */
export function zonedInputToIso(value: string, timeZone: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return undefined;
  const wanted = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(wanted)) return undefined;
  // The zone's offset at that moment, found by reading the guess back; twice, for a guess across a change of summer time
  let at = wanted;
  for (let i = 0; i < 2; i++) {
    const p = wallParts(at, timeZone);
    at += wanted - Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
  }
  return new Date(at).toISOString();
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** An instant as a `datetime-local` value on the wall clock of `timeZone` */
export function isoToZonedInput(iso: string, timeZone: string): string {
  const p = wallParts(Date.parse(iso), timeZone);
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}

/** An instant for reading, in the owner's zone: `Tue 27 Oct, 17:00` */
export function zonedLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/* ---------- What a network allows ---------- */

/** A network's capability in a few words, for the list that says up front what each channel can do */
export function allowance(capability: Pick<Capability, 'edit' | 'delete'>): string {
  const edit = capability.edit !== 'no';
  if (capability.delete === 'unpublish') return edit ? 'Edit, and unpublish instead of delete' : 'Unpublish only';
  const remove = capability.delete === 'yes';
  if (edit && remove) return 'Edit and delete';
  if (edit) return 'Edit only';
  if (remove) return 'Delete only, no edit';
  return 'Neither edit nor delete';
}

/**
 * Where a page shows a connected account's avatar: the app's own `/avatars/<id>`, never the network's
 * image host, whose cookies and expiring addresses stay out of the browser (routes/avatars.$accountId.ts)
 */
export const accountAvatar = (account: { id: number; avatarUrl: string | null }): string | null => (account.avatarUrl ? `/avatars/${account.id}` : null);
